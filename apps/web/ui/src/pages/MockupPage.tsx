import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Alert, App, Button, ConfigProvider, Empty, Input, Segmented, Space, Table, Tag, theme as antdTheme } from "antd";
import { api, ApiError, isUploadReceiptExpired, UPLOAD_TIMEOUT_MS, type MockupJob, type PendingUploadReceipt } from "../api";
import {
  forgetMockupHandoff,
  mockupHandoffFor,
  rememberMockupHandoff,
} from "../jobHandoff";
import { UploadProgressSlot } from "../chrome/UploadProgressSlot";
import { UploadWell } from "../chrome/UploadWell";
import { WaitCard } from "../chrome/WaitCard";
import { mockupFailReason, mockupFailTag } from "./mockupError";
import { AdminRotateFront, StructureConfirmPanel } from "./StructureConfirmPanel";
import { structureIssueCopy, structureStatusLabel } from "./mockupStructure";
import { liveJobLine, mockupBoardProgress, shouldShowWaitCard } from "./waitCard";
import { stemFromFilename } from "./stemName";
import { HUD_MS, downloadHudLine, missingPptHud } from "./mockupHud";
import { panBy, resetZoom, zoomAt, zoomCss, type ZoomState } from "./canvasZoom";
import { listedReadFaces, READ_FACE_LABEL, readFaceKey } from "./mockupReadFaces";
import {
  BACKDROP_LABEL,
  BACKDROP_PRESETS,
  backdropFrameClass,
  blobFromLitStill,
  blobFromStudioStill,
  canvasFilterSupported,
  clampStudioLight,
  composeStudioStill,
  containRect,
  glbExposure,
  jobHasGround,
  jobHasReviewCard,
  jobHasSet,
  loadStillImage,
  stillSetKey,
  parseBackdropPreset,
  readBackdropPreset,
  reviewCardKey,
  stillsFilter,
  studioBackdrop,
  writeBackdropPreset,
  type BackdropPreset,
  STUDIO_LIGHT_DEFAULT,
  STUDIO_LIGHT_MAX,
  STUDIO_LIGHT_MIN,
} from "./mockupStudio";
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
  if (row.structure_status === "review_required") {
    return row.structure_code === "structure_face_mapping_incomplete"
      ? { text: "待选正面", color: "warning" as const }
      : { text: "打样失败", color: "error" as const };
  }
  if (row.structure_status === "unsupported") return { text: "结构暂不支持", color: "error" as const };
  if (row.status === "failed") return { text: mockupFailTag(), color: "error" as const };
  if (row.status === "queued" || row.status === "running") return { text: "打样中", color: "processing" as const };
  return { text: row.status, color: "default" as const };
}

function mockCol(row: MockupJob): "running" | "failed" | "done" {
  if (row.status === "done") return "done";
  if (row.status === "failed" || row.status === "unsupported" || row.job_status === "failed") return "failed";
  if (row.structure_status === "unsupported") return "failed";
  if (row.structure_status === "review_required" && row.structure_code !== "structure_face_mapping_incomplete") {
    return "failed";
  }
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
  canConfirmStructure,
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
  canConfirmStructure: boolean;
  canAdmin?: boolean;
  onOpenJob: (id: string) => void;
  onBack: () => void;
  onCompose?: () => void;
  onResumeReceipt: (receipt: string) => void;
}) {
  let content: ReactNode;
  if (openId) {
    content = (
      <MockupJobPage
        jobId={openId}
        canCreate={canCreate}
        canConfirmStructure={canConfirmStructure}
        canAdmin={canAdmin}
        onBack={onBack}
      />
    );
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
  const pendingStarts = useRef(new Set<string>());

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
        if (pendingStarts.current.has(receipt)) return;
        pendingStarts.current.add(receipt);
        try {
          const next = await api.startMockup({ receipt, title: productName, product_name: productName });
          uploadStore.clear("mockup", receipt);
          setReceipts((current) => current.filter((saved) => saved.id !== receipt));
          message.success("已开始打样。");
          rememberMockupHandoff(next);
          onOpenJob(next.id);
        } catch (err) {
          if (isUploadReceiptExpired(err)) {
            uploadStore.clear("mockup", receipt);
            setReceipts((current) => current.filter((saved) => saved.id !== receipt));
            void refreshList();
            message.warning("这份上传已开工或过期，列表已刷新。");
          } else {
            message.error(err instanceof Error ? err.message : "无法开始打样");
          }
        } finally {
          pendingStarts.current.delete(receipt);
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
  const startLock = useRef(false);
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
    if (!canCreate || !receiptId) {
      setRestoredReceipt(null);
      setResumeError(null);
      return;
    }
    if (resumeSource === "local") {
      setRestoredReceipt(null);
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
    if (next) setResumeError(null);
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
    if (startLock.current) return;
    const name = productName.trim();
    if (!name) {
      message.warning("品名必填。");
      return;
    }
    if (!receipt) {
      message.warning("请先等文件传完。");
      return;
    }
    startLock.current = true;
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
      if (!mounted.current) return;
      if (isUploadReceiptExpired(err)) {
        uploadStore.clear("mockup", receipt);
        setRestoredReceipt(null);
        setResumeSource("local");
        setResumeError("这份上传已开工或过期，请重新选择文件上传。");
        message.warning("上传回执已失效，请重新上传。");
      } else {
        message.error(err instanceof Error ? err.message : "打样失败");
      }
    } finally {
      startLock.current = false;
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

export function MockupJobPage({
  jobId,
  canCreate,
  canConfirmStructure,
  canAdmin = false,
  onBack,
}: JobProps & { canCreate: boolean; canConfirmStructure: boolean; canAdmin?: boolean }) {
  const { message } = App.useApp();
  const [job, setJob] = useState<MockupJob | null>(() => mockupHandoffFor(jobId));
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState("");
  const [glbFs, setGlbFs] = useState(false);
  const [productLight, setProductLight] = useState(STUDIO_LIGHT_DEFAULT);
  const [backgroundLight, setBackgroundLight] = useState(STUDIO_LIGHT_DEFAULT);
  const [retrying, setRetrying] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [relighting, setRelighting] = useState(false);
  const [lightsOpen, setLightsOpen] = useState(false);
  const [backdrop, setBackdrop] = useState<BackdropPreset>(readBackdropPreset);
  const [highlightedReadFace, setHighlightedReadFace] = useState<string | null>(null);
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

  async function retry() {
    if (!job || retrying) return;
    setRetrying(true);
    try {
      const next = await api.retryMockup(job.id);
      setError(null);
      setJob(next);
      message.success("已用机上的稿重新排队。");
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : "重试失败");
    } finally {
      setRetrying(false);
    }
  }

  async function relightStudio() {
    if (!job || relighting) return;
    setRelighting(true);
    notice("正在重渲棚");
    try {
      const next = await api.relightMockupStudio(job.id);
      setError(null);
      setJob(next);
      notice("棚灯已重渲");
    } catch (err: unknown) {
      notice("");
      message.error(err instanceof Error ? err.message : "重渲棚失败");
    } finally {
      setRelighting(false);
    }
  }

  async function repairPrintFaces() {
    if (!job || repairing) return;
    setRepairing(true);
    notice("正在补印刷面");
    try {
      const next = await api.repairMockupPrintFaces(job.id);
      setError(null);
      setJob(next);
      notice("印刷面已补上");
    } catch (err: unknown) {
      const status = err instanceof ApiError ? err.status : 0;
      notice("");
      message.error(
        status === 404
          ? "这版还不能补切面"
          : err instanceof Error
            ? err.message
            : "补印刷面失败",
      );
    } finally {
      setRepairing(false);
    }
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
          else if (next.status === "done") message.success("打样完成。白底给备案，GLB 看形，下面印刷面读字。");
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
          <div className="mockup-sheet-head-actions">
            {canCreate ? (
              <button type="button" className="btn-ghost" disabled={retrying} onClick={() => void retry()}>
                {retrying ? "正在重试…" : "重试"}
              </button>
            ) : null}
            <button type="button" className="btn-ghost" onClick={onBack}>
              返回打样台
            </button>
          </div>
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
      <section className="mockup-sheet is-structure-confirm">
        <header className="page-head">
          <div>
            <h1 className="page-title">{mockTitle(job)}</h1>
            <p className="page-lead">
              {canAdmin && job.structure_input?.proposal_layers.length
                && !(job.structure_preview?.net_proposals || []).length
                ? `${structureStatusLabel(job)}。先选择真实结构线所在图层，再识别完整盒型。`
                : job.structure_status === "review_required" && (job.structure_preview?.net_proposals || []).length
                  ? "看一下包装展开图，点印有品名的那一面。"
                  : `${structureStatusLabel(job) || "这张稿现在打不了样"}。`}
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回打样台
          </button>
        </header>
        <StructureConfirmPanel
          key={job.id}
          job={job}
          canConfirmStructure={canConfirmStructure}
          canAdmin={canAdmin}
          onConfirmed={setJob}
        />
      </section>
    );
  }

  const whiteA = (job.files || []).find((f) => f.key === "white_a");
  const whiteB = (job.files || []).find((f) => f.key === "white_b");
  const groundA = (job.files || []).find((f) => f.key === "white_a_ground");
  const groundB = (job.files || []).find((f) => f.key === "white_b_ground");
  const hasGlb = (job.files || []).some((f) => f.key === "glb");
  const hasPpt = (job.files || []).some((f) => f.key === "ppt");
  const grounded = jobHasGround(job.files);
  const readFaces = listedReadFaces(job.files || []);
  const missingRequired = (["front", "back", "left", "right"] as const).filter((role) => !readFaces.includes(role));
  const canRepairPrint = Boolean(job.can_repair_print_faces);
  const showPrintAlert = job.status === "done" && missingRequired.length > 0;
  const printAlertCopy = canRepairPrint && canCreate
    ? "缺少印刷面图。可从已保存底稿补生成，不会重新打样。"
    : canCreate
      ? "这单没有可用底稿，无法补生成。请重新打样。"
      : "这单没有印刷面图。请联系能打样的人补或重打。";

  return (
    <section className="mockup-sheet">
      <header className="page-head">
        <div>
          <h1 className="page-title">{mockTitle(job)}</h1>
          <p className="page-lead">打样单。上面三张看形；下面印刷面读字。不要用 GLB 读小字。</p>
        </div>
        <div className="mockup-sheet-head-actions">
          <button
            type="button"
            className="btn-ghost"
            aria-expanded={lightsOpen}
            aria-controls="mockup-studio-lights"
            onClick={() => setLightsOpen((open) => !open)}
          >
            {lightsOpen ? "收起调灯" : "调灯"}
          </button>
          {canCreate && job.status === "failed" ? (
            <button type="button" className="btn-ghost" disabled={retrying} onClick={() => void retry()}>
              {retrying ? "正在重试…" : "重试"}
            </button>
          ) : null}
          {canCreate && job.status === "done" && job.can_relight_studio ? (
            <button type="button" className="btn-ghost" disabled={relighting} onClick={() => void relightStudio()}>
              {relighting ? "正在重渲棚" : "重渲棚"}
            </button>
          ) : null}
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回打样台
          </button>
          {grounded ? null : hasPpt ? (
            <a
              className="btn-ghost"
              href={fileHref(job.id, "ppt", true)}
              download
              onClick={() => notice(downloadHudLine("PPT"))}
            >
              下载 PPT
            </a>
          ) : grounded ? null : (
            <button type="button" className="btn-ghost" onClick={() => notice(missingPptHud())}>
              下载 PPT
            </button>
          )}
        </div>
      </header>
      <div className="mockup-backdrop-switch">
        <span className="mockup-backdrop-label" id="mockup-backdrop-label">
          背景
        </span>
        <Segmented
          aria-labelledby="mockup-backdrop-label"
          options={BACKDROP_PRESETS.map((preset) => ({
            label: BACKDROP_LABEL[preset],
            value: preset,
          }))}
          value={backdrop}
          onChange={(value) => {
            const next = parseBackdropPreset(value);
            setBackdrop(next);
            writeBackdropPreset(next);
          }}
        />
      </div>
      {lightsOpen ? (
        <div id="mockup-studio-lights">
          <StudioLightSliders
            productLight={productLight}
            backgroundLight={backgroundLight}
            onProductLight={setProductLight}
            onBackgroundLight={setBackgroundLight}
          />
        </div>
      ) : null}

      {job.status === "failed" ? (
        <Alert type="error" showIcon title={mockupFailReason(job.error || job.job_error)} />
      ) : null}

      {canAdmin && job.status === "done" ? (
        <AdminRotateFront job={job} onConfirmed={setJob} />
      ) : null}

      {showPrintAlert ? (
        <div className="mockup-print-alert" role="status" aria-live="polite">
          <p className="mockup-print-alert-copy">
            {repairing ? "正在补印刷面" : printAlertCopy}
          </p>
          {canRepairPrint && canCreate ? (
            <button
              type="button"
              className="btn-ghost"
              disabled={repairing}
              aria-busy={repairing || undefined}
              onClick={() => void repairPrintFaces()}
            >
              {repairing ? "正在补印刷面" : "补印刷面"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={grounded ? "mockup-sheet-photos is-grounded" : "mockup-sheet-photos"}>
        {groundA && whiteA ? (
          <GroundedShot
            jobId={job.id}
            files={job.files}
            fileKey="white_a"
            groundKey="white_a_ground"
            alt="正面与侧面成片"
            caption="正面 + 侧面"
            downloadName={whiteA.name}
            productLight={productLight}
            backgroundLight={backgroundLight}
            backdrop={backdrop}
            onProductLight={setProductLight}
            onBackgroundLight={setBackgroundLight}
            onDownload={() => notice(downloadHudLine("成片"))}
            onError={() => notice("导出失败")}
          />
        ) : whiteA ? (
          <WhiteShot
            jobId={job.id}
            fileKey="white_a"
            alt="正面与侧面白底"
            caption="正面 + 侧面"
            downloadName={whiteA.name}
            productLight={productLight}
            backgroundLight={backgroundLight}
            backdrop={backdrop}
            onProductLight={setProductLight}
            onBackgroundLight={setBackgroundLight}
            onDownload={() => notice(downloadHudLine("白底"))}
          />
        ) : (
          <figure className="mockup-sheet-photo">
            <div
              className={`mockup-sheet-frame${grounded ? " is-studio-ground" : ""} ${backdropFrameClass(backdrop)}`}
              style={{ background: studioBackdrop(backgroundLight, backdrop) }}
            >
              <p className="page-lead">还没有正面+侧面。</p>
            </div>
            <figcaption className="mockup-sheet-cap">正面 + 侧面</figcaption>
          </figure>
        )}
        {groundB && whiteB ? (
          <GroundedShot
            jobId={job.id}
            files={job.files}
            fileKey="white_b"
            groundKey="white_b_ground"
            alt="反面与侧面成片"
            caption="反面 + 侧面"
            downloadName={whiteB.name}
            productLight={productLight}
            backgroundLight={backgroundLight}
            backdrop={backdrop}
            onProductLight={setProductLight}
            onBackgroundLight={setBackgroundLight}
            onDownload={() => notice(downloadHudLine("成片"))}
            onError={() => notice("导出失败")}
          />
        ) : whiteB ? (
          <WhiteShot
            jobId={job.id}
            fileKey="white_b"
            alt="反面与侧面白底"
            caption="反面 + 侧面"
            downloadName={whiteB.name}
            productLight={productLight}
            backgroundLight={backgroundLight}
            backdrop={backdrop}
            onProductLight={setProductLight}
            onBackgroundLight={setBackgroundLight}
            onDownload={() => notice(downloadHudLine("白底"))}
          />
        ) : (
          <figure className="mockup-sheet-photo">
            <div
              className={`mockup-sheet-frame${grounded ? " is-studio-ground" : ""} ${backdropFrameClass(backdrop)}`}
              style={{ background: studioBackdrop(backgroundLight, backdrop) }}
            >
              <p className="page-lead">还没有反面+侧面。</p>
            </div>
            <figcaption className="mockup-sheet-cap">反面 + 侧面</figcaption>
          </figure>
        )}
        {hasGlb ? (
          <GlbShot
            jobId={job.id}
            boxRef={glbBox}
            backgroundLight={backgroundLight}
            productLight={productLight}
            backdrop={backdrop}
            glbFs={glbFs}
            onNotice={notice}
          />
        ) : (
          <figure className="mockup-sheet-photo">
            <div className="mockup-sheet-frame">
              <Empty description={job.status === "done" ? "没有立体模型" : "GLB 还没出"} />
            </div>
            <figcaption className="mockup-sheet-cap">GLB</figcaption>
          </figure>
        )}
      </div>
      {readFaces.length ? (
        <div className="mockup-read-chips" role="navigation" aria-label="跳到印刷面">
          <span className="mockup-backdrop-label">读字</span>
          {readFaces.map((role) => (
            <button
              key={role}
              type="button"
              className={highlightedReadFace === role ? "mockup-read-chip is-current" : "mockup-read-chip"}
              onClick={() => {
                setHighlightedReadFace(role);
                document.getElementById(`read-face-${role}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            >
              {READ_FACE_LABEL[role]}
            </button>
          ))}
        </div>
      ) : null}
      <section className="mockup-read-faces" aria-label="印刷面读字">
        <h2 className="mockup-read-title">读字</h2>
        <p className="page-lead">印刷面来自打样时已生成的各面图，不是 3D 截屏。滚轮或按钮可放到 6 倍。</p>
        {readFaces.length ? (
          <div className="mockup-read-grid">
            {readFaces.map((role) => {
              const fileKey = readFaceKey(role);
              const file = (job.files || []).find((item) => item.key === fileKey);
              return (
                <ReadFaceShot
                  key={fileKey}
                  jobId={job.id}
                  fileKey={fileKey}
                  label={READ_FACE_LABEL[role]}
                  highlighted={highlightedReadFace === role}
                  faceId={`read-face-${role}`}
                  downloadName={file?.name}
                  onDownload={() => notice(downloadHudLine("印刷面"))}
                />
              );
            })}
          </div>
        ) : showPrintAlert ? null : (
          <p className="page-lead">这单没有印刷面图。要读字请重新打样。</p>
        )}
      </section>
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

function ReadFaceShot({
  jobId,
  fileKey,
  label,
  downloadName,
  highlighted,
  faceId,
  onDownload,
}: {
  jobId: string;
  fileKey: string;
  label: string;
  downloadName?: string;
  highlighted?: boolean;
  faceId?: string;
  onDownload: () => void;
}) {
  const [bad, setBad] = useState(false);
  const [zoom, setZoom] = useState(resetZoom);
  const viewRef = useRef<HTMLDivElement>(null);
  const zoomElRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ZoomState>(zoom);
  const panDrag = useRef<{ x: number; y: number } | null>(null);
  const panRaf = useRef<number | null>(null);
  const wheelEnd = useRef<number | null>(null);
  zoomRef.current = zoom;

  const paintZoom = (next: ZoomState) => {
    const el = zoomElRef.current;
    if (el) el.style.transform = zoomCss(next);
  };

  const commitZoom = (next: ZoomState) => {
    zoomRef.current = next;
    paintZoom(next);
    setZoom(next);
  };

  const zoomFromCenter = (nextScale: number) => {
    const view = viewRef.current;
    const ox = view ? view.clientWidth / 2 : 0;
    const oy = view ? view.clientHeight / 2 : 0;
    commitZoom(zoomAt(zoomRef.current, nextScale, ox, oy));
  };

  useEffect(() => {
    const el = viewRef.current;
    if (!el || bad) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomRef.current = zoomAt(
        zoomRef.current,
        zoomRef.current.scale * factor,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      if (panRaf.current == null) {
        panRaf.current = window.requestAnimationFrame(() => {
          panRaf.current = null;
          paintZoom(zoomRef.current);
        });
      }
      if (wheelEnd.current != null) window.clearTimeout(wheelEnd.current);
      wheelEnd.current = window.setTimeout(() => {
        wheelEnd.current = null;
        setZoom(zoomRef.current);
      }, 80);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelEnd.current != null) window.clearTimeout(wheelEnd.current);
    };
  }, [bad]);

  const endPan = (target: HTMLElement) => {
    panDrag.current = null;
    target.classList.remove("is-panning");
    setZoom(zoomRef.current);
  };

  return (
    <figure className={highlighted ? "mockup-read-face is-highlight" : "mockup-read-face"} id={faceId}>
      <div
        className="mockup-read-frame"
        ref={viewRef}
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.button !== 0 || bad) return;
          if ((event.target as HTMLElement).closest("button, a")) return;
          event.preventDefault();
          panDrag.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.classList.add("is-panning");
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = panDrag.current;
          if (!drag) return;
          event.preventDefault();
          const next = panBy(zoomRef.current, event.clientX - drag.x, event.clientY - drag.y);
          drag.x = event.clientX;
          drag.y = event.clientY;
          zoomRef.current = next;
          if (panRaf.current == null) {
            panRaf.current = window.requestAnimationFrame(() => {
              panRaf.current = null;
              paintZoom(zoomRef.current);
            });
          }
        }}
        onPointerUp={(event) => endPan(event.currentTarget)}
        onPointerCancel={(event) => endPan(event.currentTarget)}
        onLostPointerCapture={(event) => endPan(event.currentTarget)}
      >
        {bad ? (
          <p className="page-lead">这张印刷面图坏了，重新打样后才能读字。</p>
        ) : (
          <div className="mockup-read-zoom" ref={zoomElRef} style={{ transform: zoomCss(zoom) }}>
            <img
              src={fileHref(jobId, fileKey)}
              alt={`${label}印刷面`}
              loading="lazy"
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
              onError={() => setBad(true)}
            />
          </div>
        )}
        {bad ? null : (
          <>
            <div className="mockup-read-tools">
              <button
                type="button"
                className="mockup-dl"
                aria-label={`缩小${label}印刷面`}
                onClick={() => zoomFromCenter(zoomRef.current.scale / 1.25)}
              >
                缩小
              </button>
              <button
                type="button"
                className="mockup-dl"
                aria-label={`恢复${label}印刷面 1 倍`}
                onClick={() => commitZoom(resetZoom())}
              >
                1×
              </button>
              <button
                type="button"
                className="mockup-dl"
                aria-label={`放大${label}印刷面`}
                onClick={() => zoomFromCenter(zoomRef.current.scale * 1.25)}
              >
                放大
              </button>
            </div>
            <a
              className="mockup-dl mockup-dl-fs"
              href={fileHref(jobId, fileKey)}
              target="_blank"
              rel="noreferrer"
              aria-label={`打开${label}印刷面`}
            >
              原图
            </a>
            <a
              className="mockup-dl mockup-dl-corner"
              href={fileHref(jobId, fileKey, true)}
              download={downloadName}
              aria-label={`下载${label}印刷面`}
              onClick={onDownload}
            >
              下载
            </a>
          </>
        )}
      </div>
      <figcaption className="mockup-sheet-cap">{label}</figcaption>
    </figure>
  );
}

function GlbShot({
  jobId,
  boxRef,
  backgroundLight,
  productLight,
  backdrop,
  glbFs,
  onNotice,
}: {
  jobId: string;
  boxRef: { current: HTMLDivElement | null };
  backgroundLight: number;
  productLight: number;
  backdrop: BackdropPreset;
  glbFs: boolean;
  onNotice: (text: string) => void;
}) {
  const fill = studioBackdrop(backgroundLight, backdrop);
  return (
    <figure className="mockup-sheet-photo">
      <div
        className={`mockup-sheet-frame mockup-sheet-glb ${backdropFrameClass(backdrop)}`}
        ref={boxRef}
        style={{ background: fill }}
      >
        <model-viewer
          src={fileHref(jobId, "glb")}
          camera-controls
          environment-image="neutral"
          exposure={glbExposure(productLight)}
          shadow-intensity="1"
          shadow-softness="0.25"
          tone-mapping="commerce"
          interaction-prompt="none"
          style={{
            background: fill,
            ["--poster-color" as string]: fill,
          }}
        />
        <button
          type="button"
          className="mockup-dl mockup-dl-fs"
          aria-label={glbFs ? "退出全屏" : "全屏截图"}
          onClick={() => {
            const el = boxRef.current;
            if (!el) return;
            if (isElementFullscreen(el)) {
              void exitElementFullscreen().catch(() => undefined);
              return;
            }
            void enterElementFullscreen(el).catch(() => onNotice("全屏打不开"));
          }}
        >
          {glbFs ? "退出" : "全屏"}
        </button>
        <a
          className="mockup-dl mockup-dl-corner"
          href={fileHref(jobId, "glb", true)}
          download
          aria-label="下载 GLB"
          onClick={() => onNotice(downloadHudLine("GLB"))}
        >
          下载
        </a>
      </div>
      <figcaption className="mockup-sheet-cap">GLB</figcaption>
    </figure>
  );
}

type PreviewSource = CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };

function closePreviewSource(image: PreviewSource | null | undefined): void {
  if (!image) return;
  if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
    image.close();
    return;
  }
  if (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement && image.src.startsWith("blob:")) {
    URL.revokeObjectURL(image.src);
  }
}

async function previewSource(url: string, destW: number, destH: number): Promise<PreviewSource> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("load");
  const blob = await response.blob();
  if (typeof createImageBitmap === "function") {
    const probe = await createImageBitmap(blob);
    const rect = containRect(destW, destH, probe.width, probe.height);
    const sized = await createImageBitmap(blob, {
      resizeWidth: Math.max(1, Math.round(rect.w)),
      resizeHeight: Math.max(1, Math.round(rect.h)),
    });
    probe.close();
    return sized;
  }
  const image = new Image();
  image.src = URL.createObjectURL(blob);
  await image.decode();
  return image;
}

async function previewStill(
  jobId: string,
  files: Array<{ key: string }> | undefined,
  key: "white_a" | "white_b" | "white_a_ground" | "white_b_ground" | "white_a_set" | "white_b_set",
  destW: number,
  destH: number,
): Promise<PreviewSource> {
  if (jobHasReviewCard(files, key)) {
    try {
      return await previewSource(fileHref(jobId, reviewCardKey(key)), destW, destH);
    } catch {
      /* card missing or 415: full still is still on disk */
    }
  }
  return previewSource(fileHref(jobId, key), destW, destH);
}

function GroundedShot({
  jobId,
  files,
  fileKey,
  groundKey,
  alt,
  caption,
  downloadName,
  productLight,
  backgroundLight,
  backdrop,
  onProductLight,
  onBackgroundLight,
  onDownload,
  onError,
  lazy,
}: {
  jobId: string;
  files?: Array<{ key: string }>;
  fileKey: "white_a" | "white_b";
  groundKey: "white_a_ground" | "white_b_ground";
  alt: string;
  caption: string;
  downloadName?: string;
  productLight: number;
  backgroundLight: number;
  backdrop: BackdropPreset;
  onProductLight: (value: number) => void;
  onBackgroundLight: (value: number) => void;
  onDownload: () => void;
  onError: () => void;
  lazy?: boolean;
}) {
  const [bad, setBad] = useState(false);
  const [ready, setReady] = useState(false);
  const [originalOpen, setOriginalOpen] = useState(false);
  const [visible, setVisible] = useState(!lazy);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<{ product: PreviewSource; ground: PreviewSource; set: PreviewSource | null } | null>(null);
  const exporting = useRef(false);

  useEffect(() => {
    if (!lazy || visible) return;
    const node = frameRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [lazy, visible]);

  useEffect(() => {
    if (!visible || bad) return;
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) return;
    const dpr = window.devicePixelRatio || 1;
    const destW = Math.max(1, Math.round(frame.clientWidth * dpr));
    const destH = Math.max(1, Math.round(frame.clientHeight * dpr));
    canvas.width = destW;
    canvas.height = destH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setBad(true);
      return;
    }
    ctx.fillStyle = studioBackdrop(backgroundLight, backdrop);
    ctx.fillRect(0, 0, destW, destH);
    setReady(false);
    let cancelled = false;
    void (async () => {
      let product: PreviewSource | null = null;
      let ground: PreviewSource | null = null;
      let set: PreviewSource | null = null;
      try {
        const setKey = stillSetKey(fileKey);
        [product, ground, set] = await Promise.all([
          previewStill(jobId, files, fileKey, destW, destH),
          previewStill(jobId, files, groundKey, destW, destH),
          jobHasSet(files, fileKey)
            ? previewStill(jobId, files, setKey, destW, destH).catch(() => null)
            : Promise.resolve(null),
        ]);
        void loadStillImage(fileHref(jobId, fileKey));
        void loadStillImage(fileHref(jobId, groundKey));
        if (set) void loadStillImage(fileHref(jobId, setKey));
        if (cancelled) {
          closePreviewSource(product);
          closePreviewSource(ground);
          closePreviewSource(set);
          return;
        }
        closePreviewSource(previewRef.current?.product);
        closePreviewSource(previewRef.current?.ground);
        closePreviewSource(previewRef.current?.set);
        previewRef.current = { product, ground, set };
        setReady(true);
      } catch {
        closePreviewSource(product);
        closePreviewSource(ground);
        closePreviewSource(set);
        if (!cancelled) setBad(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, bad, jobId, files, fileKey, groundKey]);

  useEffect(() => {
    if (!visible || bad || !ready) return;
    const canvas = canvasRef.current;
    const sources = previewRef.current;
    if (!canvas || !sources) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    composeStudioStill(ctx, canvas.width, canvas.height, sources.product, sources.ground, {
      productLight,
      backgroundLight,
      backdrop,
      set: sources.set,
      filterSupported: canvasFilterSupported(ctx),
    });
  }, [visible, bad, ready, productLight, backgroundLight, backdrop]);

  useEffect(() => {
    return () => {
      closePreviewSource(previewRef.current?.product);
      closePreviewSource(previewRef.current?.ground);
      closePreviewSource(previewRef.current?.set);
      previewRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!originalOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOriginalOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [originalOpen]);

  async function saveLit() {
    if (!ready || exporting.current) return;
    exporting.current = true;
    try {
      const setKey = stillSetKey(fileKey);
      const [product, ground, set] = await Promise.all([
        loadStillImage(fileHref(jobId, fileKey)),
        loadStillImage(fileHref(jobId, groundKey)),
        jobHasSet(files, fileKey)
          ? loadStillImage(fileHref(jobId, setKey)).catch(() => null)
          : Promise.resolve(null),
      ]);
      const blob = await blobFromStudioStill(product, ground, { productLight, backgroundLight, backdrop, set });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName || `${caption}.png`;
      link.click();
      URL.revokeObjectURL(url);
      onDownload();
    } catch {
      onError();
    } finally {
      exporting.current = false;
    }
  }

  return (
    <figure className="mockup-sheet-photo">
      <div
        className={`mockup-sheet-frame is-studio-ground ${backdropFrameClass(backdrop)}`}
        ref={frameRef}
        style={{ background: studioBackdrop(backgroundLight, backdrop) }}
      >
        {bad ? (
          <p className="page-lead">这张白底图坏了，回到打样台重新打。</p>
        ) : (
          <canvas ref={canvasRef} className="mockup-studio-canvas" aria-label={alt} />
        )}
        {bad ? null : (
          <>
            <button
              type="button"
              className="mockup-dl mockup-dl-fs"
              aria-label={`打开${caption}原图`}
              onClick={() => setOriginalOpen(true)}
            >
              原图
            </button>
            <button
              type="button"
              className="mockup-dl mockup-dl-corner"
              aria-label={`下载${caption}`}
              disabled={!ready}
              onClick={() => void saveLit()}
            >
              下载
            </button>
          </>
        )}
      </div>
      <figcaption className="mockup-sheet-cap">{caption}</figcaption>
      {originalOpen && !bad
        ? createPortal(
            <div
              className="mockup-still-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={`${caption}原图`}
              onClick={() => setOriginalOpen(false)}
            >
              <div className="mockup-still-lightbox-panel" onClick={(event) => event.stopPropagation()}>
                <div
                  className={`mockup-still-lightbox-stage is-studio-ground ${backdropFrameClass(backdrop)}`}
                  style={{ background: studioBackdrop(backgroundLight, backdrop) }}
                >
                  <GroundedLightboxStill
                    jobId={jobId}
                    files={files}
                    fileKey={fileKey}
                    groundKey={groundKey}
                    alt={alt}
                    productLight={productLight}
                    backgroundLight={backgroundLight}
                    backdrop={backdrop}
                    placeholder={previewRef.current}
                  />
                </div>
                <StudioLightSliders
                  productLight={productLight}
                  backgroundLight={backgroundLight}
                  onProductLight={onProductLight}
                  onBackgroundLight={onBackgroundLight}
                />
                <div className="mockup-still-lightbox-actions">
                  <button type="button" className="mockup-dl" disabled={!ready} onClick={() => void saveLit()}>
                    下载
                  </button>
                  <button type="button" className="mockup-dl" onClick={() => setOriginalOpen(false)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </figure>
  );
}

function GroundedLightboxStill({
  jobId,
  files,
  fileKey,
  groundKey,
  alt,
  productLight,
  backgroundLight,
  backdrop,
  placeholder,
}: {
  jobId: string;
  files?: Array<{ key: string }>;
  fileKey: "white_a" | "white_b";
  groundKey: "white_a_ground" | "white_b_ground";
  alt: string;
  productLight: number;
  backgroundLight: number;
  backdrop: BackdropPreset;
  placeholder?: { product: PreviewSource; ground: PreviewSource; set: PreviewSource | null } | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourcesRef = useRef<{ product: PreviewSource; ground: PreviewSource; set: PreviewSource | null } | null>(
    placeholder || null,
  );
  const [loaded, setLoaded] = useState(placeholder ? 1 : 0);
  useEffect(() => {
    if (placeholder && !sourcesRef.current) sourcesRef.current = placeholder;
    let cancelled = false;
    void (async () => {
      try {
        const setKey = stillSetKey(fileKey);
        const [product, ground, set] = await Promise.all([
          loadStillImage(fileHref(jobId, fileKey)),
          loadStillImage(fileHref(jobId, groundKey)),
          jobHasSet(files, fileKey)
            ? loadStillImage(fileHref(jobId, setKey)).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        sourcesRef.current = { product, ground, set };
        setLoaded((n) => n + 1);
      } catch {
        /* lightbox keeps the card placeholder or STUDIO_GROUND_FILL stage */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, files, fileKey, groundKey, placeholder]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const sources = sourcesRef.current;
    if (!canvas || !sources || !loaded) return;
    canvas.width = Number(sources.product.naturalWidth || sources.product.width || 0);
    canvas.height = Number(sources.product.naturalHeight || sources.product.height || 0);
    if (!canvas.width || !canvas.height) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    composeStudioStill(ctx, canvas.width, canvas.height, sources.product, sources.ground, {
      productLight,
      backgroundLight,
      backdrop,
      set: sources.set,
      filterSupported: canvasFilterSupported(ctx),
    });
  }, [loaded, productLight, backgroundLight, backdrop]);
  return <canvas ref={canvasRef} className="mockup-studio-lightbox-canvas" aria-label={alt} />;
}

function StudioLightSliders({
  productLight,
  backgroundLight,
  onProductLight,
  onBackgroundLight,
}: {
  productLight: number;
  backgroundLight: number;
  onProductLight: (value: number) => void;
  onBackgroundLight: (value: number) => void;
}) {
  return (
    <div className="mockup-studio-lights">
      <label className="mockup-studio-light">
        产品灯光
        <input
          aria-label="产品灯光"
          aria-valuemax={STUDIO_LIGHT_MAX}
          aria-valuemin={STUDIO_LIGHT_MIN}
          aria-valuenow={productLight}
          max={STUDIO_LIGHT_MAX}
          min={STUDIO_LIGHT_MIN}
          onChange={(event) => onProductLight(clampStudioLight(Number(event.target.value)))}
          step={0.02}
          type="range"
          value={productLight}
        />
      </label>
      <label className="mockup-studio-light">
        背景灯光
        <input
          aria-label="背景灯光"
          aria-valuemax={STUDIO_LIGHT_MAX}
          aria-valuemin={STUDIO_LIGHT_MIN}
          aria-valuenow={backgroundLight}
          max={STUDIO_LIGHT_MAX}
          min={STUDIO_LIGHT_MIN}
          onChange={(event) => onBackgroundLight(clampStudioLight(Number(event.target.value)))}
          step={0.02}
          type="range"
          value={backgroundLight}
        />
      </label>
    </div>
  );
}

function WhiteShot({
  jobId,
  fileKey,
  alt,
  caption,
  downloadName,
  productLight,
  backgroundLight,
  backdrop,
  onProductLight,
  onBackgroundLight,
  onDownload,
}: {
  jobId: string;
  fileKey: "white_a" | "white_b";
  alt: string;
  caption: string;
  downloadName?: string;
  productLight: number;
  backgroundLight: number;
  backdrop: BackdropPreset;
  onProductLight: (value: number) => void;
  onBackgroundLight: (value: number) => void;
  onDownload: () => void;
}) {
  const [bad, setBad] = useState(false);
  const [originalOpen, setOriginalOpen] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const exporting = useRef(false);
  const fill = studioBackdrop(backgroundLight, backdrop);
  const filter = stillsFilter(productLight);

  useEffect(() => {
    if (!originalOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOriginalOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [originalOpen]);

  async function saveLit() {
    const img = imgRef.current;
    if (!img || exporting.current) return;
    exporting.current = true;
    try {
      const blob = await blobFromLitStill(img, { productLight, backgroundLight, backdrop });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = downloadName || `${caption}.png`;
      link.click();
      URL.revokeObjectURL(url);
      onDownload();
    } catch {
      /* 导出失败不假装已经在下载 */
    } finally {
      exporting.current = false;
    }
  }

  return (
    <figure className="mockup-sheet-photo">
      <div className={`mockup-sheet-frame ${backdropFrameClass(backdrop)}`} style={{ background: fill }}>
        {bad ? (
          <p className="page-lead">这张白底图坏了，回到打样台重新打。</p>
        ) : (
          <img
            ref={imgRef}
            src={fileHref(jobId, fileKey)}
            alt={alt}
            onError={() => setBad(true)}
            style={{ filter }}
          />
        )}
        {bad ? null : (
          <>
            <button
              type="button"
              className="mockup-dl mockup-dl-fs"
              aria-label={`打开${caption}原图`}
              onClick={() => setOriginalOpen(true)}
            >
              原图
            </button>
            <button
              type="button"
              className="mockup-dl mockup-dl-corner"
              aria-label={`下载${caption}`}
              onClick={() => void saveLit()}
            >
              下载
            </button>
          </>
        )}
      </div>
      <figcaption className="mockup-sheet-cap">{caption}</figcaption>
      {originalOpen && !bad
        ? createPortal(
            <div
              className="mockup-still-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={`${caption}原图`}
              onClick={() => setOriginalOpen(false)}
            >
              <div className="mockup-still-lightbox-panel" onClick={(event) => event.stopPropagation()}>
                <div
                  className={`mockup-still-lightbox-stage ${backdropFrameClass(backdrop)}`}
                  style={{ background: fill }}
                >
                  <img src={fileHref(jobId, fileKey)} alt={alt} style={{ filter }} />
                </div>
                <StudioLightSliders
                  productLight={productLight}
                  backgroundLight={backgroundLight}
                  onProductLight={onProductLight}
                  onBackgroundLight={onBackgroundLight}
                />
                <div className="mockup-still-lightbox-actions">
                  <button type="button" className="mockup-dl" onClick={() => void saveLit()}>
                    下载
                  </button>
                  <button type="button" className="mockup-dl" onClick={() => setOriginalOpen(false)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </figure>
  );
}
