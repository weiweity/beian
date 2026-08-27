import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UploadPausedError, type UploadProgress, type UploadReceipt } from "./api.js";
import { createUploadStore, uploadPhaseLine, type UploadTransport } from "./uploadStore.js";
import { UPLOAD_TOO_LARGE } from "./uploadLimit.js";

type PendingCall = {
  signal?: AbortSignal;
  progress?: (value: UploadProgress) => void;
  resolve: (value: UploadReceipt) => void;
  reject: (reason: unknown) => void;
};

function controlledTransport() {
  const calls: PendingCall[] = [];
  const transport: UploadTransport = (_form, progress, signal) =>
    new Promise<UploadReceipt>((resolve, reject) => {
      calls.push({ signal, progress, resolve, reject });
    });
  return { calls, transport };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function ai(name = "盒子.ai") {
  return new File(["ai"], name, { type: "application/postscript" });
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("uploadStore", () => {
  it("取消页面订阅不会中止模块级上传", async () => {
    const fake = controlledTransport();
    const store = createUploadStore(fake.transport);
    const unsubscribe = store.subscribe(() => undefined);
    store.replaceFile("mockup", "ai", ai());
    assert.equal(fake.calls.length, 1);

    unsubscribe();
    assert.equal(fake.calls[0]?.signal?.aborted, false);
    fake.calls[0]?.resolve({ receipt: "aabbccddeeff", files: [{ field: "file", name: "盒子.ai", bytes: 2 }] });
    await flush();
    assert.equal(store.get("mockup")?.phase, "ready");
  });

  it("换文件会中止旧请求并只保留新文件", () => {
    const fake = controlledTransport();
    const store = createUploadStore(fake.transport);
    store.replaceFile("mockup", "ai", ai("旧稿.ai"));
    const first = fake.calls[0];
    store.replaceFile("mockup", "ai", ai("新稿.ai"));

    assert.equal(first?.signal?.aborted, true);
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(store.get("mockup")?.files.map((file) => file.name), ["新稿.ai"]);
  });

  it("替换已确认的文件会撤销旧回执，避免看板和磁盘留下重复待开工项", async () => {
    const fake = controlledTransport();
    const discarded: string[] = [];
    const store = createUploadStore(fake.transport, async (receipt) => {
      discarded.push(receipt);
    });
    store.replaceFile("mockup", "ai", ai("旧稿.ai"));
    fake.calls[0]?.resolve({ receipt: "aabbccddeeff", files: [{ field: "ai", name: "旧稿.ai", bytes: 2 }] });
    await flush();

    store.replaceFile("mockup", "ai", ai("新稿.ai"));
    await flush();
    assert.deepEqual(discarded, ["aabbccddeeff"]);
    assert.deepEqual(store.get("mockup")?.files.map((file) => file.name), ["新稿.ai"]);
  });

  it("对照 ready 后更换一栏会清掉另一栏的纯元数据，避免假装已经选齐", async () => {
    const fake = controlledTransport();
    const discarded: string[] = [];
    const store = createUploadStore(fake.transport, async (receipt) => {
      discarded.push(receipt);
    });
    store.replaceFile("compare", "excel", new File(["PK"], "旧表.xlsx"));
    store.replaceFile("compare", "pdf", new File(["%PDF"], "旧稿.pdf"));
    fake.calls[0]?.resolve({
      receipt: "aabbccddeeff",
      files: [
        { field: "excel", name: "旧表.xlsx", bytes: 2 },
        { field: "pdf", name: "旧稿.pdf", bytes: 4 },
      ],
    });
    await flush();

    store.replaceFile("compare", "excel", new File(["PK2"], "新表.xlsx"));
    await flush();
    assert.deepEqual(discarded, ["aabbccddeeff"]);
    assert.equal(store.get("compare")?.phase, "draft");
    assert.deepEqual(store.get("compare")?.files.map((file) => file.name), ["新表.xlsx"]);
    assert.equal(fake.calls.length, 1);

    store.replaceFile("compare", "pdf", new File(["%PDF2"], "新稿.pdf"));
    assert.equal(store.get("compare")?.phase, "uploading");
    assert.equal(fake.calls.length, 2);
  });

  it("传输进度到 100 后进入服务器确认中，收到回执才 ready", async () => {
    const fake = controlledTransport();
    const store = createUploadStore(fake.transport);
    store.replaceFile("mockup", "ai", ai());
    fake.calls[0]?.progress?.({ pct: 100, loaded: 2, total: 2 });

    const confirming = store.get("mockup");
    assert.equal(confirming?.phase, "confirming");
    assert.equal(confirming && uploadPhaseLine(confirming, "可以开始"), "文件已传完，服务器正在确认");

    fake.calls[0]?.resolve({ receipt: "aabbccddeeff", files: [{ field: "file", name: "盒子.ai", bytes: 2 }] });
    await flush();
    assert.equal(store.get("mockup")?.phase, "ready");
    assert.equal(store.get("mockup")?.receipt, "aabbccddeeff");
    assert.equal(store.get("mockup")?.files[0]?.file, undefined);
  });

  it("网络失败保留当前文件并给出可重试错误", async () => {
    const fake = controlledTransport();
    const store = createUploadStore(fake.transport);
    store.replaceFile("mockup", "ai", ai());
    fake.calls[0]?.reject(new Error("上传中断。请检查网络后重新上传。"));
    await flush();

    assert.equal(store.get("mockup")?.phase, "failed");
    assert.match(store.get("mockup")?.error || "", /上传中断/);
    assert.deepEqual(store.get("mockup")?.files.map((file) => file.name), ["盒子.ai"]);
  });

  it("自动重连耗尽后进入可继续状态，不丢文件或上传会话", async () => {
    const fake = controlledTransport();
    const store = createUploadStore(fake.transport);
    store.replaceFile("mockup", "ai", ai());
    fake.calls[0]?.progress?.({ pct: 48, loaded: 1, total: 2, phase: "retrying", retryAttempt: 2, uploadId: "112233445566" });
    assert.equal(store.get("mockup")?.phase, "retrying");
    assert.equal(store.get("mockup")?.retryAttempt, 2);
    fake.calls[0]?.reject(new UploadPausedError("上传已暂停，可继续", "112233445566"));
    await flush();
    assert.equal(store.get("mockup")?.phase, "paused");
    assert.equal(store.get("mockup")?.uploadId, "112233445566");
    assert.ok(store.get("mockup")?.files[0]?.file);

    store.retry("mockup");
    assert.equal(fake.calls.length, 2);
    assert.equal(store.get("mockup")?.phase, "uploading");
  });

  it("历史记录删除暂停上传后，按服务器 upload id 同步清掉本地会话", async () => {
    const fake = controlledTransport();
    const store = createUploadStore(fake.transport);
    store.replaceFile("mockup", "ai", ai());
    fake.calls[0]?.progress?.({ pct: 48, loaded: 1, total: 2, phase: "retrying", uploadId: "112233445566" });
    fake.calls[0]?.reject(new UploadPausedError("上传已暂停，可继续", "112233445566"));
    await flush();

    store.clear("mockup", "another-upload");
    assert.equal(store.get("mockup")?.uploadId, "112233445566");
    store.clear("mockup", "112233445566");
    assert.equal(store.get("mockup"), null);
  });

  it("响应丢失后用同一 client id 的服务端回执恢复，并在开工后释放状态", async () => {
    const fake = controlledTransport();
    const store = createUploadStore(fake.transport);
    store.replaceFile("mockup", "ai", ai());
    const clientUploadId = store.get("mockup")?.clientUploadId;
    assert.ok(clientUploadId);
    fake.calls[0]?.reject(new Error("上传中断。请检查网络后重新上传。"));
    await flush();
    assert.ok(store.get("mockup")?.files[0]?.file);

    const recovered = store.recover("mockup", {
      id: "112233445566",
      kind: "mockup",
      client_upload_id: clientUploadId,
      files: [{ field: "ai", name: "盒子.ai", bytes: 2, received: 2 }],
      bytes: 2,
      received: 2,
      created_at: "2026-08-26T08:00:00.000Z",
      phase: "ready",
    });
    assert.equal(recovered, true);
    assert.equal(store.get("mockup")?.phase, "ready");
    assert.equal(store.get("mockup")?.receipt, "112233445566");
    assert.equal(store.get("mockup")?.files[0]?.file, undefined);

    store.clear("mockup", "112233445566");
    assert.equal(store.get("mockup"), null);
  });

  it("整页刷新恢复部分会话后，轮询不会覆盖重选同一文件的指引", () => {
    const store = createUploadStore(controlledTransport().transport);
    const paused = {
      id: "112233445566",
      kind: "mockup" as const,
      client_upload_id: "client-paused-refresh",
      files: [{ field: "ai", name: "盒子.ai", bytes: 2, received: 1 }],
      bytes: 2,
      received: 1,
      created_at: "2026-08-26T08:00:00.000Z",
      phase: "paused" as const,
    };
    store.restore("mockup", paused);
    assert.match(store.get("mockup")?.error || "", /重新选择同一文件/);
    assert.equal(store.recover("mockup", paused), true);
    assert.match(store.get("mockup")?.error || "", /重新选择同一文件/);
  });

  it("整页刷新保留本次上传身份，并在重选同一文件后续传", () => {
    const storage = memoryStorage();
    const firstTransport = controlledTransport();
    const source = ai("刷新续传.ai");
    const first = createUploadStore(firstTransport.transport, async () => undefined, storage, "ou_refresh_owner");
    first.replaceFile("mockup", "ai", source, { productName: "刷新续传", packSurface: "carton" });
    firstTransport.calls[0]?.progress?.({
      pct: 50,
      loaded: 1,
      total: 2,
      phase: "uploading",
      uploadId: "112233445566",
    });
    const clientUploadId = first.get("mockup")?.clientUploadId;
    assert.ok(clientUploadId);

    const resumedTransport = controlledTransport();
    const resumed = createUploadStore(resumedTransport.transport, async () => undefined, storage, "ou_refresh_owner");
    assert.equal(resumed.get("mockup")?.phase, "paused");
    assert.equal(resumed.get("mockup")?.clientUploadId, clientUploadId);
    assert.equal(resumed.get("mockup")?.uploadId, "112233445566");
    assert.equal(resumed.get("mockup")?.files[0]?.file, undefined);
    assert.match(resumed.get("mockup")?.error || "", /重新选择同一文件/);

    resumed.replaceFile("mockup", "ai", source);
    assert.equal(resumedTransport.calls.length, 1);
    assert.equal(resumed.get("mockup")?.clientUploadId, clientUploadId);
    assert.equal(resumed.get("mockup")?.uploadId, "112233445566");
    first.abortAll();
    resumed.abortAll();
  });

  it("按登录人隔离刷新状态，切换账号不会看到上一人的文件名", () => {
    const storage = memoryStorage();
    const fake = controlledTransport();
    const store = createUploadStore(fake.transport, async () => undefined, storage, "ou_owner_a");
    store.replaceFile("mockup", "ai", ai("甲账号稿件.ai"));
    assert.equal(store.get("mockup")?.files[0]?.name, "甲账号稿件.ai");

    store.setOwner("ou_owner_b");
    assert.equal(store.get("mockup"), null);

    store.setOwner("ou_owner_a");
    assert.equal(store.get("mockup")?.phase, "paused");
    assert.equal(store.get("mockup")?.files[0]?.name, "甲账号稿件.ai");
    store.abortAll();
  });

  it("不会用另一次同文件上传的 client id 覆盖当前失败状态", async () => {
    const fake = controlledTransport();
    const store = createUploadStore(fake.transport);
    store.replaceFile("mockup", "ai", ai());
    fake.calls[0]?.reject(new Error("上传失败"));
    await flush();
    assert.equal(
      store.recover("mockup", {
        id: "223344556677",
        kind: "mockup",
        client_upload_id: "another-client-id",
        files: [{ field: "ai", name: "盒子.ai", bytes: 2, received: 2 }],
        bytes: 2,
        received: 2,
        created_at: "2026-08-26T08:00:00.000Z",
        phase: "ready",
      }),
      false,
    );
    assert.equal(store.get("mockup")?.phase, "failed");
  });

  it("放弃失败上传会立即释放 File，放弃 ready 还会删除服务端回执", async () => {
    const fake = controlledTransport();
    const discarded: string[] = [];
    const store = createUploadStore(fake.transport, async (receipt) => {
      discarded.push(receipt);
    });
    store.replaceFile("mockup", "ai", ai("失败稿.ai"));
    fake.calls[0]?.reject(new Error("上传失败"));
    await flush();
    const failedClientId = store.get("mockup")?.clientUploadId;
    assert.ok(failedClientId);
    assert.ok(store.get("mockup")?.files[0]?.file);
    await store.abandon("mockup");
    assert.equal(store.get("mockup"), null);

    store.replaceFile("mockup", "ai", ai("已收稿.ai"));
    fake.calls[1]?.resolve({ receipt: "ffeeddccbbaa", files: [{ field: "ai", name: "已收稿.ai", bytes: 2 }] });
    await flush();
    await store.abandon("mockup");
    assert.equal(store.get("mockup"), null);
    assert.deepEqual(discarded, [failedClientId, "ffeeddccbbaa"]);
  });

  it("服务端放弃失败时保留本地会话和文件，允许再次删除", async () => {
    const fake = controlledTransport();
    const store = createUploadStore(fake.transport, async () => {
      throw new Error("删除暂存失败");
    });
    store.replaceFile("mockup", "ai", ai("待重试删除.ai"));
    fake.calls[0]?.reject(new Error("上传失败"));
    await flush();

    await assert.rejects(store.abandon("mockup"), /删除暂存失败/);
    assert.equal(store.get("mockup")?.files[0]?.name, "待重试删除.ai");
    assert.ok(store.get("mockup")?.files[0]?.file);
  });

  it("超过 100 MB 立即拒绝，不创建网络请求", () => {
    const fake = controlledTransport();
    const store = createUploadStore(fake.transport);
    const huge = ai("超大.ai");
    Object.defineProperty(huge, "size", { value: 100 * 1024 * 1024 + 1 });

    store.replaceFile("mockup", "ai", huge);
    assert.equal(fake.calls.length, 0);
    assert.equal(store.get("mockup")?.phase, "failed");
    assert.equal(store.get("mockup")?.error, UPLOAD_TOO_LARGE);
  });

  it("整页卸载入口会中止两台正在进行的请求", () => {
    const fake = controlledTransport();
    const store = createUploadStore(fake.transport);
    store.replaceFile("mockup", "ai", ai());
    store.replaceFile("compare", "excel", new File(["x"], "表.xlsx"));
    store.replaceFile("compare", "pdf", new File(["p"], "稿.pdf"));
    assert.equal(fake.calls.length, 2);

    store.abortAll();
    assert.equal(fake.calls[0]?.signal?.aborted, true);
    assert.equal(fake.calls[1]?.signal?.aborted, true);
  });
});
