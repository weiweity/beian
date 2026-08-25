import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, App, Button, Empty } from "antd";
import { api, type MockupJob } from "../api";
import { UploadWell } from "../chrome/UploadWell";
import { WaitCard } from "../chrome/WaitCard";
import { mockupFailReason, mockupFailTag } from "./mockupError";
import { liveJobLine, shouldShowWaitCard } from "./waitCard";
import { stemFromFilename } from "./stemName";
import { UPLOAD_TOO_LARGE, bytesTooLarge } from "../uploadLimit";
import { HUD_MS, downloadHudLine, missingPptHud } from "./mockupHud";
import { type DeskCardRow } from "./deskBoard";
import { DeskCol } from "./DeskCol";
import { shouldShowTaskBoard } from "./tasksBoard";
import {
  enterElementFullscreen,
  exitElementFullscreen,
  isElementFullscreen,
  pingViewerAfterFullscreen,
} from "./mockupFullscreen";
import "@google/model-viewer";

type DeskProps = { onOpenJob: (id: string) => void };
type JobProps = { jobId: string; onBack: () => void };

function mockLabel(row: MockupJob) {
  if (row.status === "done") return { text: "已出图", color: "success" as const };
  if (row.status === "failed") return { text: mockupFailTag(), color: "error" as const };
  if (row.status === "queued" || row.status === "running") return { text: "打样中", color: "processing" as const };
  return { text: row.status, color: "default" as const };
}

function mockCol(row: MockupJob): "running" | "failed" | "done" {
  if (row.status === "done") return "done";
  if (row.status === "failed" || row.job_status === "failed") return "failed";
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
  onOpenJob,
  onBack,
  onCompose,
}: {
  openId?: string | null;
  composing?: boolean;
  onOpenJob: (id: string) => void;
  onBack: () => void;
  onCompose?: () => void;
}) {
  if (openId) return <MockupJobPage jobId={openId} onBack={onBack} />;
  if (composing) {
    return <MockupNewPage onCreated={onOpenJob} onBack={onBack} />;
  }
  return <MockupPage onOpenJob={onOpenJob} onCompose={onCompose || (() => undefined)} />;
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
    live: liveJobLine({ ...row, kind: "mockup" }),
    error: row.status === "failed" ? mockupFailReason(row.error || row.job_error) : null,
  };
}

export function MockupPage({
  onOpenJob,
  onCompose,
}: DeskProps & { onCompose: () => void }) {
  const [rows, setRows] = useState<MockupJob[]>([]);
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
    void api
      .mockups()
      .then((list) => {
        if (cancelled || gen !== listGen.current) return;
        setRows(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const boardLive = rows.some((r) => mockCol(r) === "running");
  useEffect(() => {
    if (!boardLive) return;
    const id = window.setInterval(() => {
      void refreshList();
    }, 2500);
    return () => window.clearInterval(id);
  }, [boardLive]);

  const board = useMemo(
    () => ({
      running: rows.filter((r) => mockCol(r) === "running"),
      failed: rows.filter((r) => mockCol(r) === "failed"),
      done: rows.filter((r) => mockCol(r) === "done"),
    }),
    [rows],
  );
  const showBoard = shouldShowTaskBoard(rows.length, "");

  return (
    <section className="mockup-desk">
      <div className="desk-head">
        <div>
          <h1 className="page-title">打样台</h1>
          <p className="page-lead">交差「盒子长什么样」。点进度或已出图进打样单。</p>
        </div>
        <Button type="primary" onClick={onCompose}>
          进入工作台
        </Button>
      </div>
      {!showBoard ? (
        <div className="desk-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div>
                <div>还没有打样单</div>
                <div className="desk-empty-hint">右上角进入工作台，交一份 .ai 平面稿</div>
              </div>
            }
          >
            <Button type="primary" onClick={onCompose}>
              进入工作台
            </Button>
          </Empty>
        </div>
      ) : (
        <div className="review-board">
          <DeskCol title="打样中" hint="点进去看进度" rows={board.running.map(toMockCard)} onOpen={onOpenJob} />
          <DeskCol title="打样失败" hint="点进去看原因" rows={board.failed.map(toMockCard)} onOpen={onOpenJob} />
          <DeskCol title="已出图" hint="点进去打开打样单" rows={board.done.map(toMockCard)} onOpen={onOpenJob} />
        </div>
      )}
    </section>
  );
}

export function MockupNewPage({
  onCreated,
  onBack,
}: {
  onCreated: (id: string) => void;
  onBack: () => void;
}) {
  const { message } = App.useApp();
  const [file, setFile] = useState<File | null>(null);
  const [productName, setProductName] = useState("");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  function takeFile(next: File | null) {
    setFile(next);
    setReceipt(null);
    setPct(0);
    if (next) {
      message.success("已选平面稿");
      if (!productName.trim()) setProductName(stemFromFilename(next.name));
    }
  }

  useEffect(() => {
    if (!file) return;
    if (bytesTooLarge(file.size)) return;
    let cancelled = false;
    const ac = new AbortController();
    const fd = new FormData();
    fd.append("file", file);
    setUploading(true);
    void api
      .stageUpload(
        fd,
        (n) => {
          if (!cancelled) setPct(n);
        },
        ac.signal,
      )
      .then((res) => {
        if (cancelled) return;
        setReceipt(res.receipt);
        setPct(100);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setReceipt(null);
        message.error(err instanceof Error ? err.message : "上传失败");
      })
      .finally(() => {
        if (!cancelled) setUploading(false);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [file, message]);

  async function run() {
    if (busy) return;
    if (!file) {
      message.warning("先选 .ai 稿件");
      return;
    }
    if (bytesTooLarge(file.size)) {
      message.error(UPLOAD_TOO_LARGE);
      return;
    }
    if (!receipt) {
      message.warning("请先等文件传完。");
      return;
    }
    setBusy(true);
    try {
      const next = await api.startMockup({
        receipt,
        title: productName.trim() || stemFromFilename(file.name),
      });
      onCreated(next.id);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "打样失败");
      setBusy(false);
    }
  }

  if (busy) return <WaitCard job="打样" jobStatus="queued" />;

  return (
    <section className="new-form mockup-desk">
      <header className="page-head">
        <div>
          <h1 className="page-title">打样工作台</h1>
          <p className="page-lead">先交平面稿。本机要有 Blender。</p>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !receipt || uploading}
            onClick={() => void run()}
          >
            {uploading ? `上传中 ${pct}%` : "开始打样"}
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
            onChange={(e) => setProductName(e.target.value)}
          />
        </label>
      </div>
      <div className="upload-row" style={{ gridTemplateColumns: "1fr" }}>
        <UploadWell
          icon="/brand/ui/well-pdf.svg"
          title="平面稿"
          hint="把 .ai 拖到这里"
          accept=".ai"
          fileName={file?.name}
          fileBytes={file?.size}
          disabled={busy}
          onFile={takeFile}
          onReject={() => message.warning("只收 .ai 稿件。")}
        >
          <span className="upload-well-btn">{file ? "更换平面稿" : "选取平面稿"}</span>
        </UploadWell>
      </div>
    </section>
  );
}

export function MockupJobPage({ jobId, onBack }: JobProps) {
  const { message } = App.useApp();
  const [job, setJob] = useState<MockupJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState("");
  const [glbFs, setGlbFs] = useState(false);
  const glbBox = useRef<HTMLDivElement>(null);
  const hudTimer = useRef<number | null>(null);
  const announced = useRef("");
  const lastGlbFs = useRef(false);
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
    void api
      .mockup(jobId)
      .then((next) => {
        if (cancelled) return;
        setJob(next);
        announced.current = `${next.id}:${next.status}`;
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
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
          setJob(next);
          if (shouldShowWaitCard(next)) return;
          const key = `${next.id}:${next.status}`;
          if (announced.current === key) return;
          announced.current = key;
          if (next.status === "failed") message.error(mockupFailReason(next.error || next.job_error));
          else if (next.status === "done") message.success("打样完成。白底给备案，GLB 可全屏截图。");
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "打样单读不到");
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


