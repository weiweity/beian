import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PendingUploadReceipt } from "../api.js";
import type { UploadSnapshot } from "../uploadStore.js";
import {
  matchesDeskQuery,
  loadDeskReceipts,
  pendingUploadCard,
  pendingUploadOpenAction,
  pendingUploadItems,
  shouldReconcileUpload,
} from "./uploadDesk.js";

const local: UploadSnapshot = {
  attempt: 1,
  kind: "compare",
  phase: "ready",
  files: [
    { field: "excel", name: "备案确认单.xlsx", bytes: 10 },
    { field: "pdf", name: "包装展开图.pdf", bytes: 20 },
  ],
  productName: "修护面膜",
  packSurface: "carton",
  pct: 100,
  loaded: 30,
  total: 30,
  receipt: "aabbccddeeff",
  createdAt: "2026-08-26T08:00:00.000Z",
};

const restored: PendingUploadReceipt = {
  id: "112233445566",
  kind: "compare",
  files: [
    { field: "excel", name: "远端确认单.xlsx", bytes: 12, received: 12 },
    { field: "pdf", name: "远端包装.pdf", bytes: 24, received: 24 },
  ],
  bytes: 36,
  received: 36,
  created_at: "2026-08-26T07:00:00.000Z",
  phase: "ready",
};

describe("uploadDesk", () => {
  it("本地回执和 GET 同 id 时只画一张卡", () => {
    const withClient = { ...local, clientUploadId: "client-same-upload" };
    const same = {
      ...restored,
      id: "aabbccddeeff",
      client_upload_id: "client-same-upload",
    };
    const items = pendingUploadItems("compare", withClient, [same]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.productName, "修护面膜");
    assert.equal(items[0]?.title, "修护面膜");
    assert.equal(items[0]?.phase, "ready");
  });

  it("GET 恢复的回执只用文件名展示，不把它当品名", () => {
    const [item] = pendingUploadItems("compare", null, [restored]);
    assert.equal(item?.title, "远端确认单");
    assert.equal(item?.productName, null);
    assert.equal(item?.receipt, "112233445566");
  });

  it("GET 恢复的待开工审稿保留包装面类型", () => {
    const [item] = pendingUploadItems("compare", null, [
      { ...restored, product_name: "膜袋", pack_surface: "pouch" },
    ]);
    assert.equal(item?.productName, "膜袋");
    assert.equal(item?.packSurface, "pouch");
    assert.equal(item ? pendingUploadOpenAction(item) : null, "start");
  });

  it("可按任一文件名搜索待开工上传", () => {
    assert.equal(pendingUploadItems("compare", null, [restored], "包装").length, 1);
    assert.equal(pendingUploadItems("compare", null, [restored], "不存在").length, 0);
    assert.equal(matchesDeskQuery("确认", "远端确认单.xlsx"), true);
  });

  it("100% 等响应时卡片明确显示服务器确认中", () => {
    const confirming: UploadSnapshot = { ...local, phase: "confirming", receipt: undefined };
    const [item] = pendingUploadItems("compare", confirming, []);
    assert.ok(item);
    const card = pendingUploadCard(item, "待对照");
    assert.equal(card.live, "服务器确认中");
    assert.equal(card.progress, 100);
  });

  it("切回看板仍能看到上传失败并点回工作台重试", () => {
    const failed: UploadSnapshot = {
      ...local,
      kind: "mockup",
      phase: "failed",
      files: [{ field: "ai", name: "花盒.ai", bytes: 20 }],
      receipt: undefined,
      error: "上传超时。请检查网络后重新上传。",
    };
    const [item] = pendingUploadItems("mockup", failed, []);
    assert.ok(item);
    const card = pendingUploadCard(item, "待打样");
    assert.equal(card.statusText, "上传失败");
    assert.equal(card.statusColor, "error");
    assert.match(card.error || "", /上传超时/);
  });

  it("响应丢失时以同一上传标识的服务端回执为准，不同时画失败和待开工", () => {
    const failed: UploadSnapshot = {
      ...local,
      phase: "failed",
      receipt: undefined,
      clientUploadId: "client-response-lost",
      error: "上传超时。请检查网络后重新上传。",
    };
    const recovered = { ...restored, client_upload_id: "client-response-lost" };
    const items = pendingUploadItems("compare", failed, [recovered]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.phase, "ready");
    assert.equal(items[0]?.receipt, recovered.id);
  });

  it("确定性校验失败保留原错误，不被同一服务端 partial 快照伪装成暂停", () => {
    const failed: UploadSnapshot = {
      ...local,
      phase: "failed",
      receipt: undefined,
      uploadId: "112233445566",
      clientUploadId: "client-invalid-file",
      recoverable: false,
      error: "不是有效的 PDF",
    };
    const partial = {
      ...restored,
      phase: "paused" as const,
      received: restored.bytes,
      client_upload_id: "client-invalid-file",
    };
    const items = pendingUploadItems("compare", failed, [partial]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.phase, "failed");
    assert.equal(items[0]?.error, "不是有效的 PDF");
    assert.equal(shouldReconcileUpload("compare", failed, [partial]), false);
    assert.equal(shouldReconcileUpload("compare", { ...failed, recoverable: true }, [partial]), true);
  });

  it("相同文件的另一次上传不会被错误合并", () => {
    const failed: UploadSnapshot = {
      ...local,
      phase: "failed",
      receipt: undefined,
      clientUploadId: "client-new-attempt",
      error: "上传中断。请检查网络后重新上传。",
    };
    const older = {
      ...restored,
      client_upload_id: "client-old-attempt",
      files: local.files.map((file) => ({ ...file, received: file.bytes })),
    };
    const items = pendingUploadItems("compare", failed, [older]);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((item) => item.phase), ["failed", "ready"]);
  });

  it("partial 会话继续轮询，只有完整回执才结束协调", () => {
    const confirming: UploadSnapshot = {
      ...local,
      phase: "confirming",
      receipt: undefined,
      clientUploadId: "client-reconcile",
    };
    assert.equal(shouldReconcileUpload("compare", confirming, []), true);
    assert.equal(
      shouldReconcileUpload("compare", confirming, [
        { ...restored, client_upload_id: "client-reconcile" },
      ]),
      false,
    );
    assert.equal(
      shouldReconcileUpload("compare", confirming, [
        { ...restored, phase: "paused", received: 10, client_upload_id: "client-reconcile" },
      ]),
      true,
    );
    assert.equal(shouldReconcileUpload("mockup", confirming, []), false);
    assert.equal(shouldReconcileUpload("compare", { ...confirming, phase: "ready" }, []), false);
  });

  it("只读账号不请求上传回执，回执读取失败也不影响任务主列表", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      throw new Error("没有权限");
    };
    assert.deepEqual(await loadDeskReceipts(false, load), []);
    assert.equal(calls, 0);
    assert.deepEqual(await loadDeskReceipts(true, load), []);
    assert.equal(calls, 1);
  });

  it("只有完整回执可以开工，本地暂停保留文件句柄，远端暂停回恢复页", () => {
    const [ready] = pendingUploadItems("compare", local, []);
    assert.ok(ready);
    assert.equal(pendingUploadOpenAction(ready), "start");

    const [anonymous] = pendingUploadItems("compare", null, [restored]);
    assert.ok(anonymous);
    assert.equal(pendingUploadOpenAction(anonymous), "resume");

    const [paused] = pendingUploadItems("compare", null, [
      {
        ...restored,
        phase: "paused",
        product_name: "断点续传花盒",
        received: 18,
      },
    ]);
    assert.ok(paused);
    assert.equal(pendingUploadOpenAction(paused), "resume");

    const localClientId = "client-local-paused";
    const [localPaused] = pendingUploadItems(
      "compare",
      {
        ...local,
        phase: "paused",
        receipt: undefined,
        uploadId: paused.receipt || undefined,
        clientUploadId: localClientId,
      },
      [
        {
          ...restored,
          id: paused.receipt || restored.id,
          phase: "paused",
          client_upload_id: localClientId,
          received: 18,
        },
      ],
    );
    assert.ok(localPaused);
    assert.equal(pendingUploadOpenAction(localPaused), "active");
  });

  it("本地 ready 不会被看板缓存的旧 partial 快照降级", () => {
    const ready = { ...local, clientUploadId: "client-ready-after-background" };
    const [item] = pendingUploadItems("compare", ready, [
      {
        ...restored,
        id: ready.receipt!,
        phase: "paused",
        received: 9,
        client_upload_id: ready.clientUploadId,
      },
    ]);
    assert.ok(item);
    assert.equal(item.phase, "ready");
    assert.equal(item.pct, 100);
    assert.equal(item.receipt, ready.receipt);
    assert.equal(pendingUploadOpenAction(item), "start");
  });

  it("本机仍在上传或等回执时保持当前工作台，不重挂载恢复页", () => {
    for (const phase of ["uploading", "retrying", "confirming"] as const) {
      const [item] = pendingUploadItems("compare", { ...local, phase }, [restored]);
      assert.ok(item);
      assert.equal(pendingUploadOpenAction(item), "active");
    }
  });
});
