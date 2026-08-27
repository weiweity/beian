import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Alert, App, Button, ConfigProvider, Empty, Input, Segmented, Space, Table, Tag, theme as antdTheme } from "antd";
import { ApiError, api, UPLOAD_TIMEOUT_MS, type MockupJob, type PendingUploadReceipt } from "../api";
import {
  forgetMockupHandoff,
  mockupHandoffFor,
  rememberMockupHandoff,
} from "../jobHandoff";
import { UploadProgressSlot } from "../chrome/UploadProgressSlot";
import { UploadWell } from "../chrome/UploadWell";
import { WaitCard } from "../chrome/WaitCard";
import { mockupFailReason, mockupFailTag } from "./mockupError";
import { StructureConfirmPanel } from "./StructureConfirmPanel";
import { structureIssueCopy, structureStatusLabel } from "./mockupStructure";
import { liveJobLine, mockupBoardProgress, shouldShowWaitCard } from "./waitCard";
import { stemFromFilename } from "./stemName";
import { HUD_MS, downloadHudLine, missingPptHud } from "./mockupHud";
import { deskClock, type DeskCardRow } from "./deskBoard";
import { DeskCol } from "./DeskCol";
import { shouldShowTaskBoard } from "./tasksBoard";
import {
  uploadIsBusy,
  UPLOAD_RECOVERY_INTERVAL_MS,
  uploadStore,
  useUploadReceiptRecovery,
  useUploadSnapshot,
  type UploadSnapshot,
} from "../uploadStore";
import {
  matchesDeskQuery,
  loadDeskReceipts,
  pendingUploadCard,
  pendingUploadOpenAction,
  pendingUploadItems,
  shouldReconcileUpload,
  type PendingUploadItem,
} from "./uploadDesk";
import {
  enterElementFullscreen,
  exitElementFullscreen,
  isElementFullscreen,
  pingViewerAfterFullscreen,
} from "./mockupFullscreen";
import "@google/model-viewer";

type DeskProps = {
  canCreate: boolean;
  onOpenJob: (id: string) => void;
  onCompose: () => void;
  onResumeReceipt: (receipt: string) => void;
};
type JobProps = { jobId: string; onBack: () => void };
type Layout = "board" | "table";

function mockLabel(row: MockupJob) {
  if (row.status === "done") return { text: "已出图", color: "success" as const };
  if (row.structure_status === "review_required") return { text: "待确认结构", color: "warning" as const };
  if (row.structure_status === "unsupported") return { text: "结构暂不支持", color: "error" as const };
  if (row.status === "failed") return { text: mockupFailTag(), color: "error" as const };
  if (row.status === "queued" || row.status === "running") return { text: "打样中", color: "processing" as const };
  return { text: row.status, color: "default" as const };
}

function mockCol(row: MockupJob): "running" | "failed" | "done" {
  if (row.status === "done") return "done";
  if (row.status === "failed" || row.status === "unsupported" || row.job_status === "failed") return "failed";
  return "running";
}

function mockTitle(row: MockupJob) {
  return row.title || row.files[0]?.name || row.id.slice(0, 8);
}

function fileHref(jobId: string, key: string, download = false) {
  const base = `/api/mockups/${jobId}/files/${key}`;
  return download ? `${base}?download=1` : base;
}

export function MockupDesk({
  openId,
  composing,
  receiptId,
  canCreate,
  canAdmin,
  onOpenJob,
  onBack,
  onCompose,
  onResumeReceipt,
}: {
  openId?: string | null;
  composing?: boolean;
  receiptId?: string | null;
  canCreate: boolean;
  canAdmin: boolean;
  onOpenJob: (id: string) => void;
  onBack: () => void;
  onCompose?: () => void;
  onResumeReceipt: (receipt: string) => void;
}) {
  let content: ReactNode;
  if (openId) {
    content = <MockupJobPage jobId={openId} canAdmin={canAdmin} onBack={onBack} />;
  } else if (composing) {
    content = <MockupNewPage key={receiptId || "active"} canCreate={canCreate} receiptId={receiptId} onCreated={onOpenJob} onBack={onBack} />;
  } else {
    content = (
      <MockupPage
        canCreate={canCreate}
        onOpenJob={onOpenJob}
        onCompose={onCompose || (() => undefined)}
        onResumeReceipt={onResumeReceipt}
      />
    );
  }
  return (
    <ConfigProvider
      theme={{
        algorithm: antdTheme.defaultAlgorithm,
        token: { colorPrimary: "#805898", colorText: "#1c1a1f", colorBgBase: "#ffffff" },
      }}
    >
      {content}
    </ConfigProvider>
  );
}

function toMockCard(row: MockupJob): DeskCardRow {
  const s = mockLabel(row);
  return {
    id: row.id,
    title: mockTitle(row),
    statusText: s.text,
    statusColor: s.color,
    actor: row.owner,
    at: row.job_started_at || row.created_at,
    progress: mockupBoardProgress(row),
    live: liveJobLine({ ...row, kind: "mockup" }),
    error:
      row.structure_status === "review_required"
        ? structureIssueCopy(row)
        : row.structure_status === "unsupported"
          ? structureIssueCopy(row)
          : row.status === "failed"
            ? mockupFailReason(row.error || row.job_error)
            : null,
  };
}

export function MockupPage({
  canCreate,
  onOpenJob,
  onCompose,
  onResumeReceipt,
}: DeskProps) {
  const { message, modal } = App.useApp();
  const localUpload = useUploadSnapshot("mockup");
  const [rows, setRows] = useState<MockupJob[]>([]);
  const [receipts, setReceipts] = useState<PendingUploadReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [layout, setLayout] = useState<Layout>("board");
  const [reload, setReload] = useState(0);
  const listGen = useRef(0);

  function refreshList() {
    const gen = ++listGen.current;
    return api
      .mockups()
      .then((list) => {
        if (gen !== listGen.current) return list;
        setRows(list);
        return list;
      })
      .catch(() => undefined);
  }

  useEffect(() => {
    let cancelled = false;
    const gen = ++listGen.current;
    setLoading(true);
    setError(null);
    void Promise.all([api.mockups(), loadDeskReceipts(canCreate, api.uploads)])
      .then(([list, pending]) => {
        if (cancelled || gen !== listGen.current) return;
        setRows(list);
        for (const receipt of pending) uploadStore.recover("mockup", receipt);
        setReceipts(pending);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败，再试一次");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canCreate, reload]);

  const boardLive = rows.some((row) => row.job_status === "queued" || row.job_status === "running");
  useEffect(() => {
    if (!boardLive) return;
    const id = window.setInterval(() => {
      void refreshList();
    }, 2500);
    return () => window.clearInterval(id);
  }, [boardLive]);

  const reconcileUpload = shouldReconcileUpload("mockup", localUpload, receipts);
  useEffect(() => {
    if (!canCreate || !reconcileUpload) return;
    let cancelled = false;
    const reconcile = () => {
      void api
        .uploads()
        .then((pending) => {
          if (cancelled) return;
          for (const receipt of pending) uploadStore.recover("mockup", receipt);
          setReceipts(pending);
        })
        .catch(() => undefined);
    };
    reconcile();
    const interval = window.setInterval(reconcile, UPLOAD_RECOVERY_INTERVAL_MS);
    const stop = window.setTimeout(() => window.clearInterval(interval), UPLOAD_TIMEOUT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(stop);
    };
  }, [canCreate, localUpload?.clientUploadId, localUpload?.phase, reconcileUpload]);

  const filteredRows = useMemo(
    () =>
      rows.filter((row) =>
        matchesDeskQuery(submitted, mockTitle(row), ...row.files.map((file) => file.name)),
      ),
    [rows, submitted],
  );
  const allPendingItems = useMemo(
    () => pendingUploadItems("mockup", localUpload, receipts),
    [localUpload, receipts],
  );
  const pendingItems = useMemo(
    () => pendingUploadItems("mockup", localUpload, receipts, submitted),
    [localUpload, receipts, submitted],
  );
  const pendingCards = useMemo(
    () => pendingItems.map((item) => pendingUploadCard(item, "待打样")),
    [pendingItems],
  );
  const pendingByKey = useMemo(() => new Map(pendingItems.map((item) => [item.key, item])), [pendingItems]);
  const board = useMemo(
    () => ({
      running: filteredRows.filter((row) => mockCol(row) === "running"),
      failed: filteredRows.filter((row) => mockCol(row) === "failed"),
      done: filteredRows.filter((row) => mockCol(row) === "done"),
    }),
    [filteredRows],
  );
  const totalCount = filteredRows.length + pendingItems.length;
  const allCount = rows.length + allPendingItems.length;
  const showSearch = Boolean(submitted) || allCount > 0;
  const showBoard = shouldShowTaskBoard(totalCount, submitted) && totalCount > 0;
  const tableRows = useMemo(
    () => [...pendingCards, ...filteredRows.map(toMockCard)],
    [pendingCards, filteredRows],
  );

  function openPending(item: PendingUploadItem) {
    const action = pendingUploadOpenAction(item);
    if (action === "active") {
      onCompose();
      return;
    }
    if (action === "resume") {
      if (!item.receipt) return;
      onResumeReceipt(item.receipt);
      return;
    }
    if (!item.receipt || !item.productName) return;
    const receipt = item.receipt;
    const productName = item.productName;
    modal.confirm({
      title: "开始打样这单？",
      content: `品名：${productName}。上传文件已由服务器确认，开始后会进入打样队列。`,
      okText: "开始打样",
      cancelText: "先不开始",
      onOk: async () => {
        try {
          const next = await api.startMockup({ receipt, title: productName, product_name: productName });
          uploadStore.clear("mockup", receipt);
          setReceipts((current) => current.filter((saved) => saved.id !== receipt));
          message.success("已开始打样。");
          rememberMockupHandoff(next);
          onOpenJob(next.id);
        } catch (err) {
          message.error(err instanceof Error ? err.message : "无法开始打样");
          throw err;
        }
      },
    });
  }

  function openCard(id: string) {
    const pending = pendingByKey.get(id);
    if (pending) openPending(pending);
    else onOpenJob(id);
  }

  return (
    <section className="mockup-desk">
      <div className="desk-head">
        <div>
          <h1 className="page-title">打样台</h1>
          <p className="page-lead">交差「盒子长什么样」。点进度或已出图进打样单。</p>
        </div>
        <Space wrap>
          {showSearch ? (
            <Input.Search
              allowClear
              placeholder="搜品名或文件名"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              onClear={() => {
                setQ("");
                setSubmitted("");
              }}
              onSearch={(value) => setSubmitted(value.trim())}
              style={{ width: 240 }}
            />
          ) : null}
          {showBoard ? (
            <Segmented
              value={layout}
              onChange={(value) => setLayout(value as Layout)}
              options={[
                { label: "看板", value: "board" },
                { label: "表格", value: "table" },
              ]}
            />
          ) : null}
          {canCreate ? (
            <Button type="primary" onClick={onCompose}>
              进入工作台
            </Button>
          ) : null}
        </Space>
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title={error}
          action={
            <Button size="small" onClick={() => setReload((count) => count + 1)}>
              再试一次
            </Button>
          }
        />
      ) : null}
      {!showBoard ? (
        <div className="desk-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              loading ? (
                <div>读取打样单…</div>
              ) : submitted ? (
                <div>没有找到这个品名或文件名</div>
              ) : (
                <div>
                  <div>还没有打样单</div>
                  <div className="desk-empty-hint">右上角进入工作台，交一份 .ai 平面稿</div>
                </div>
              )
            }
          >
            {loading ? null : submitted ? (
              <Button
                onClick={() => {
                  setQ("");
                  setSubmitted("");
                }}
              >
                清空
              </Button>
            ) : canCreate ? (
              <Button type="primary" onClick={onCompose}>
                进入工作台
              </Button>
            ) : null}
          </Empty>
        </div>
      ) : layout === "board" ? (
        <div className="review-board">
          <DeskCol
            title="打样中"
            hint="上传中、待打样或机器运行"
            rows={[...pendingCards, ...board.running.map(toMockCard)]}
            onOpen={openCard}
          />
          <DeskCol title="打样失败" hint="点进去看原因" rows={board.failed.map(toMockCard)} onOpen={onOpenJob} />
          <DeskCol title="已出图" hint="点进去打开打样单" rows={board.done.map(toMockCard)} onOpen={onOpenJob} />
        </div>
      ) : (
        <Table<DeskCardRow>
          rowKey="id"
          loading={loading}
          dataSource={tableRows}
          pagination={false}
          scroll={{ x: 760 }}
          onRow={(row) => ({ onClick: () => openCard(row.id), style: { cursor: "pointer" } })}
          columns={[
            { title: "品名 / 文件", dataIndex: "title" },
            {
              title: "状态",
              width: 180,
              render: (_, row) => (
                <div>
                  <Tag color={row.statusColor}>{row.statusText}</Tag>
                  {row.live ? <div className="review-card-live">{row.live}</div> : null}
                </div>
              ),
            },
            { title: "工作时间", dataIndex: "at", width: 180, render: (value: string) => deskClock(value) },
            { title: "使用人", dataIndex: "actor", width: 100, render: (value: string) => value || "—" },
            { title: "", key: "open", width: 100, render: () => <Button type="link">打开</Button> },
          ]}
        />
      )}
    </section>
  );
}

function receiptFromSnapshot(snapshot: UploadSnapshot | null): PendingUploadReceipt | null {
  if (!snapshot?.receipt || snapshot.phase !== "ready") return null;
  return {
    id: snapshot.receipt,
    files: snapshot.files.map((file) => ({ ...file, received: file.bytes, last_modified: file.lastModified })),
    bytes: snapshot.files.reduce((sum, file) => sum + file.bytes, 0),
    received: snapshot.files.reduce((sum, file) => sum + file.bytes, 0),
    created_at: snapshot.createdAt,
    kind: snapshot.kind,
    phase: "ready",
  };
}

export function MockupNewPage({
  canCreate,
  receiptId,
  onCreated,
  onBack,
}: {
  canCreate: boolean;
  receiptId?: string | null;
  onCreated: (id: string) => void;
  onBack: () => void;
}) {
  const { message, modal } = App.useApp();
  const upload = useUploadSnapshot("mockup");
  const localReceipt = receiptFromSnapshot(upload);
  const localMatches = Boolean(receiptId && localReceipt?.id === receiptId);
  const [resumeSource, setResumeSource] = useState<"local" | "remote">(() => (!receiptId || localMatches ? "local" : "remote"));
  const [restoredReceipt, setRestoredReceipt] = useState<PendingUploadReceipt | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [productName, setProductName] = useState(resumeSource === "local" ? upload?.productName || "" : "");
  const [submitting, setSubmitting] = useState(false);
  const mounted = useRef(false);
  useUploadReceiptRecovery("mockup", upload, canCreate && resumeSource === "local");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (resumeSource !== "local" || !upload) return;
    setProductName(upload.productName || "");
  }, [resumeSource, upload?.clientUploadId, upload?.productName]);

  useEffect(() => {
    if (!canCreate || resumeSource === "local" || !receiptId) {
      setRestoredReceipt(null);
      setResumeError(null);
      return;
    }
    let cancelled = false;
    setResumeError(null);
    void api
      .uploads()
      .then((list) => {
        if (cancelled) return;
        const found = list.find((item) => item.id === receiptId && item.kind === "mockup") || null;
        if (found?.phase === "paused") {
          uploadStore.restore("mockup", found);
          setProductName(found.product_name || "");
          setResumeSource("local");
          setRestoredReceipt(null);
          return;
        }
        setRestoredReceipt(found);
        if (found) {
          setProductName(found.product_name || "");
        } else {
          setResumeError("这份上传回执已过期或已经开工，请返回打样台刷新。");
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setResumeError(err instanceof Error ? err.message : "上传回执读取失败");
      });
    return () => {
      cancelled = true;
    };
  }, [canCreate, receiptId, resumeSource]);

  const receipt = resumeSource === "local" ? upload?.receipt || null : restoredReceipt?.id || null;
  const files = resumeSource === "local" ? upload?.files || [] : restoredReceipt?.files || [];
  const ai = files.find((file) => file.field === "file" || file.field === "ai");
  const busy = resumeSource === "local" && uploadIsBusy(upload);

  function updateName(next: string) {
    setProductName(next);
    if (resumeSource === "local") uploadStore.updateMeta("mockup", { productName: next });
  }

  function takeFile(next: File | null) {
    let name = productName;
    if (next && !name.trim()) {
      name = stemFromFilename(next.name);
      setProductName(name);
    }
    const state = uploadStore.replaceFile("mockup", "ai", next, { productName: name });
    if (state.phase === "failed" && state.error) message.error(state.error);
    else if (next) message.success("已选平面稿");
  }

  async function run() {
    const name = productName.trim();
    if (!name) {
      message.warning("品名必填。");
      return;
    }
    if (!receipt) {
      message.warning("请先等文件传完。");
      return;
    }
    setSubmitting(true);
    try {
      const next = await api.startMockup({
        receipt,
        title: name,
        product_name: name,
      });
      uploadStore.clear("mockup", receipt);
      rememberMockupHandoff(next);
      if (!mounted.current) return;
      onCreated(next.id);
    } catch (err) {
      if (mounted.current) message.error(err instanceof Error ? err.message : "打样失败");
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  function confirmAbandon() {
    modal.confirm({
      title: "放弃这次上传？",
      content: "暂存文件会删除；以后需要时要重新选择并上传。",
      okText: "放弃上传",
      okButtonProps: { danger: true },
      cancelText: "继续保留",
      onOk: async () => {
        try {
          if (resumeSource === "remote" && restoredReceipt) {
            const result = await api.discardUpload(restoredReceipt.id);
            if (!result.ok) throw new Error("这份上传已经过期或已经开工");
            setRestoredReceipt(null);
          } else {
            await uploadStore.abandon("mockup");
          }
          message.success("已放弃这次上传，文件资源已释放。");
          onBack();
        } catch (err) {
          message.error(err instanceof Error ? err.message : "无法放弃这次上传");
          throw err;
        }
      },
    });
  }

  if (!canCreate) {
    return (
      <section className="new-form mockup-desk">
        <header className="page-head">
          <h1 className="page-title">打样工作台</h1>
          <button type="button" className="btn-ghost" onClick={onBack}>返回</button>
        </header>
        <Alert type="warning" showIcon title="当前账号只有查看权限，不能上传或新建打样单。" />
      </section>
    );
  }

  return (
    <section className="new-form mockup-desk">
      <header className="page-head">
        <div>
          <h1 className="page-title">打样工作台</h1>
          <p className="page-lead">先交平面稿。本机要有 Blender。</p>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <button type="button" className="btn-ghost" disabled={submitting} onClick={onBack}>
            返回
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!receipt || busy || submitting}
            onClick={() => void run()}
          >
            {submitting ? "正在开工" : busy ? "上传中" : "开始打样"}
          </button>
        </div>
      </header>
      <div className="new-meta">
        <label className="new-meta-name">
          品名
          <input
            maxLength={80}
            placeholder="选平面稿后自动填，可改"
            value={productName}
            onChange={(event) => updateName(event.target.value)}
          />
        </label>
      </div>
      {resumeError ? <Alert type="error" showIcon title={resumeError} /> : null}
      <UploadProgressSlot
        snapshot={resumeSource === "local" ? upload : null}
        receipt={resumeSource === "remote" ? restoredReceipt : null}
        readyText="上传成功，可以开始打样"
        onRetry={resumeSource === "local" ? () => uploadStore.retry("mockup") : undefined}
        onDiscard={files.length ? confirmAbandon : undefined}
      />
      <div className="upload-row is-single">
        <UploadWell
          icon="/brand/ui/well-pdf.svg"
          title="平面稿"
          hint="把 .ai 拖到这里"
          accept=".ai"
          fileName={ai?.name}
          fileBytes={ai?.bytes}
          disabled={resumeSource === "remote"}
          onFile={takeFile}
          onReject={() => message.warning("只收 .ai 稿件。")}
        >
          <span className="upload-well-btn">{ai ? "更换平面稿" : "选取平面稿"}</span>
        </UploadWell>
      </div>
    </section>
  );
}

export function MockupJobPage({ jobId, canAdmin, onBack }: JobProps & { canAdmin: boolean }) {
  const { message } = App.useApp();
  const [job, setJob] = useState<MockupJob | null>(() => mockupHandoffFor(jobId));
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState("");
  const [glbFs, setGlbFs] = useState(false);
  const glbBox = useRef<HTMLDivElement>(null);
  const hudTimer = useRef<number | null>(null);
  const announced = useRef("");
  const lastGlbFs = useRef(false);
  const seededJobId = useRef(jobId);
  const waiting = Boolean(job) && shouldShowWaitCard(job);

  function notice(text: string) {
    setHud(text);
    if (hudTimer.current != null) window.clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => setHud(""), HUD_MS);
  }

  useEffect(() => {
    return () => {
      if (hudTimer.current != null) window.clearTimeout(hudTimer.current);
      if (isElementFullscreen(glbBox.current)) void exitElementFullscreen().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    function onFs() {
      const el = glbBox.current;
      const on = isElementFullscreen(el);
      setGlbFs(on);
      if (on === lastGlbFs.current) return;
      lastGlbFs.current = on;
      if (el) pingViewerAfterFullscreen(el);
    }
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (seededJobId.current !== jobId) {
      seededJobId.current = jobId;
      setJob(mockupHandoffFor(jobId));
    }
    setError(null);
    announced.current = "";
    void api
      .mockup(jobId)
      .then((next) => {
        if (cancelled) return;
        setError(null);
        forgetMockupHandoff(jobId);
        setJob(next);
        announced.current = `${next.id}:${next.status}`;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          forgetMockupHandoff(jobId);
          setJob(null);
        }
        setError(err instanceof Error ? err.message : "加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    if (!job?.id || !waiting) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      void api
        .mockup(job.id)
        .then((next) => {
          if (cancelled) return;
          setError(null);
          setJob(next);
          if (shouldShowWaitCard(next)) return;
          const key = `${next.id}:${next.status}`;
          if (announced.current === key) return;
          announced.current = key;
          if (next.status === "failed") message.error(mockupFailReason(next.error || next.job_error));
          else if (next.status === "done") message.success("打样完成。白底给备案，GLB 可全屏截图。");
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof ApiError && err.status === 404) {
            forgetMockupHandoff(job.id);
            setJob(null);
          }
          setError(err instanceof Error ? err.message : "打样单读不到");
        });
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [job?.id, waiting, message]);

  if (error) {
    return (
      <section>
        <header className="page-head">
          <h1 className="page-title">打样单</h1>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回打样台
          </button>
        </header>
        <Alert type="error" showIcon title={error} />
      </section>
    );
  }

  if (!job) {
    return (
      <section>
        <header className="page-head">
          <h1 className="page-title">打样单</h1>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回打样台
          </button>
        </header>
        <div className="desk-empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="打开打样单…" />
        </div>
      </section>
    );
  }

  if (waiting) {
    return (
      <section className="mockup-sheet">
        <header className="page-head">
          <div>
            <h1 className="page-title">{mockTitle(job)}</h1>
            <p className="page-lead">打样还在跑。可以回打样台，进度仍在历史记录里。</p>
          </div>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回打样台
          </button>
        </header>
        <WaitCard
          job="打样"
          jobStatus={job.job_status || (job.status === "queued" || job.status === "running" ? job.status : "queued")}
          queueAhead={job.queue_ahead}
          stage={job.job_stage}
          stageLabel={job.job_stage_label}
          etaS={job.job_eta_s}
        />
      </section>
    );
  }

  if (job.structure_status === "review_required" || job.structure_status === "unsupported") {
    return (
      <section className="mockup-sheet">
        <header className="page-head">
          <div>
            <h1 className="page-title">{mockTitle(job)}</h1>
            <p className="page-lead">
              {structureStatusLabel(job)}。结构确认前不会启动 Blender，也不会把这单记成上传失败。
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回打样台
          </button>
        </header>
        <StructureConfirmPanel
          key={job.id}
          job={job}
          canAdmin={canAdmin}
          onConfirmed={setJob}
        />
      </section>
    );
  }

  const whiteA = (job.files || []).find((f) => f.key === "white_a");
  const whiteB = (job.files || []).find((f) => f.key === "white_b");
  const hasGlb = (job.files || []).some((f) => f.key === "glb");
  const hasPpt = (job.files || []).some((f) => f.key === "ppt");

  return (
    <section className="mockup-sheet">
      <header className="page-head">
        <div>
          <h1 className="page-title">{mockTitle(job)}</h1>
          <p className="page-lead">打样单。白底是正面+侧面、反面+侧面；GLB 全屏转一转再截图。</p>
        </div>
        <div className="mockup-sheet-head-actions">
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回打样台
          </button>
          {hasPpt ? (
            <a
              className="btn-ghost"
              href={fileHref(job.id, "ppt", true)}
              download
              onClick={() => notice(downloadHudLine("PPT"))}
            >
              下载 PPT
            </a>
          ) : (
            <button type="button" className="btn-ghost" onClick={() => notice(missingPptHud())}>
              下载 PPT
            </button>
          )}
        </div>
      </header>

      {job.status === "failed" ? (
        <Alert type="error" showIcon title={mockupFailReason(job.error || job.job_error)} />
      ) : null}

      <div className="mockup-sheet-photos">
        {whiteA ? (
          <WhiteShot
            jobId={job.id}
            fileKey="white_a"
            alt="正面与侧面白底"
            caption="正面 + 侧面"
            downloadName={whiteA.name}
            onDownload={() => notice(downloadHudLine("白底"))}
          />
        ) : (
          <figure className="mockup-sheet-photo">
            <div className="mockup-sheet-frame">
              <p className="page-lead">还没有正面+侧面。</p>
            </div>
            <figcaption className="mockup-sheet-cap">正面 + 侧面</figcaption>
          </figure>
        )}
        {whiteB ? (
          <WhiteShot
            jobId={job.id}
            fileKey="white_b"
            alt="反面与侧面白底"
            caption="反面 + 侧面"
            downloadName={whiteB.name}
            onDownload={() => notice(downloadHudLine("白底"))}
          />
        ) : (
          <figure className="mockup-sheet-photo">
            <div className="mockup-sheet-frame">
              <p className="page-lead">还没有反面+侧面。</p>
            </div>
            <figcaption className="mockup-sheet-cap">反面 + 侧面</figcaption>
          </figure>
        )}
        {hasGlb ? (
          <figure className="mockup-sheet-photo">
            <div className="mockup-sheet-frame mockup-sheet-glb" ref={glbBox}>
              <model-viewer
                src={fileHref(job.id, "glb")}
                camera-controls
                environment-image="neutral"
                exposure="0.9"
                shadow-intensity="1"
                shadow-softness="0.25"
                tone-mapping="commerce"
                interaction-prompt="none"
              />
              <button
                type="button"
                className="mockup-dl mockup-dl-fs"
                aria-label={glbFs ? "退出全屏" : "全屏截图"}
                onClick={() => {
                  const el = glbBox.current;
                  if (!el) return;
                  if (isElementFullscreen(el)) {
                    void exitElementFullscreen().catch(() => undefined);
                    return;
                  }
                  void enterElementFullscreen(el).catch(() => notice("全屏打不开"));
                }}
              >
                {glbFs ? "退出" : "全屏"}
              </button>
              <a
                className="mockup-dl mockup-dl-corner"
                href={fileHref(job.id, "glb", true)}
                download
                aria-label="下载 GLB"
                onClick={() => notice(downloadHudLine("GLB"))}
              >
                下载
              </a>
            </div>
            <figcaption className="mockup-sheet-cap">GLB</figcaption>
          </figure>
        ) : (
          <figure className="mockup-sheet-photo">
            <div className="mockup-sheet-frame">
              <Empty description={job.status === "done" ? "没有 GLB。看上面的失败原因。" : "GLB 还没出"} />
            </div>
            <figcaption className="mockup-sheet-cap">GLB</figcaption>
          </figure>
        )}
      </div>
      {hud && typeof document !== "undefined"
        ? createPortal(
            <p className="mockup-hud" role="status" aria-live="polite">
              {hud}
            </p>,
            document.body,
          )
        : null}
    </section>
  );
}

function WhiteShot({
  jobId,
  fileKey,
  alt,
  caption,
  downloadName,
  onDownload,
}: {
  jobId: string;
  fileKey: "white_a" | "white_b";
  alt: string;
  caption: string;
  downloadName?: string;
  onDownload: () => void;
}) {
  const [bad, setBad] = useState(false);
  return (
    <figure className="mockup-sheet-photo">
      <div className="mockup-sheet-frame">
        {bad ? (
          <p className="page-lead">这张白底图坏了，回到打样台重新打。</p>
        ) : (
          <img src={fileHref(jobId, fileKey)} alt={alt} onError={() => setBad(true)} />
        )}
        {bad ? null : (
          <a
            className="mockup-dl mockup-dl-corner"
            href={fileHref(jobId, fileKey, true)}
            download={downloadName}
            aria-label={`下载${caption}`}
            onClick={onDownload}
          >
            下载
          </a>
        )}
      </div>
      <figcaption className="mockup-sheet-cap">{caption}</figcaption>
    </figure>
  );
}
