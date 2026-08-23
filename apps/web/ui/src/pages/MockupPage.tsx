import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Empty, Space, Tag, Typography } from "antd";
import { api, type MockupJob } from "../api";
import { UploadWell } from "../chrome/UploadWell";
import { WaitCard } from "../chrome/WaitCard";
import { shouldShowWaitCard } from "./waitCard";
import { stemFromFilename } from "./stemName";
import "@google/model-viewer";

type Props = { openId?: string | null };

function mockLabel(row: MockupJob) {
  if (row.status === "done") return { text: "已出图", color: "success" as const };
  if (row.status === "failed") return { text: row.error || row.job_error || "打样中断", color: "error" as const };
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

export function MockupPage({ openId }: Props) {
  const { message } = App.useApp();
  const [file, setFile] = useState<File | null>(null);
  const [productName, setProductName] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<MockupJob | null>(null);
  const [rows, setRows] = useState<MockupJob[]>([]);
  const announced = useRef("");

  const jobWaiting = Boolean(job) && shouldShowWaitCard(job);
  const waiting = busy || jobWaiting;

  function refreshList() {
    return api.mockups().then(setRows).catch(() => undefined);
  }

  useEffect(() => {
    void refreshList();
  }, []);

  useEffect(() => {
    if (!openId) return;
    void api
      .mockup(openId)
      .then((next) => {
        setJob(next);
        announced.current = `${next.id}:${next.status}`;
      })
      .catch(() => undefined);
  }, [openId]);

  useEffect(() => {
    if (!job?.id || !jobWaiting) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      void api
        .mockup(job.id)
        .then((next) => {
          if (cancelled) return;
          setJob(next);
          void refreshList();
          if (shouldShowWaitCard(next)) return;
          const key = `${next.id}:${next.status}`;
          if (announced.current === key) return;
          announced.current = key;
          if (next.status === "failed") message.error(next.error || next.job_error || "打样失败");
          else if (next.status === "done") message.success("打样完成。白底图给备案，GLB 可本机打开截图。");
        })
        .catch(() => undefined);
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [job?.id, jobWaiting, message]);

  function takeFile(next: File | null) {
    setFile(next);
    if (next) {
      message.success("已选平面稿");
      if (!productName.trim()) setProductName(stemFromFilename(next.name));
    }
  }

  async function run() {
    if (busy) return;
    if (!file) {
      message.warning("先选 .ai 稿件");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("title", productName.trim() || stemFromFilename(file.name));
    setBusy(true);
    setJob(null);
    announced.current = "";
    try {
      const next = await api.createMockup(fd);
      setJob(next);
      void refreshList();
      if (shouldShowWaitCard(next)) return;
      announced.current = `${next.id}:${next.status}`;
      if (next.status === "failed") message.error(next.error || next.job_error || "打样失败");
      else if (next.status === "done") message.success("打样完成。白底图给备案，GLB 可本机打开截图。");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "打样失败");
    } finally {
      setBusy(false);
    }
  }

  const board = useMemo(
    () => ({
      running: rows.filter((r) => mockCol(r) === "running"),
      failed: rows.filter((r) => mockCol(r) === "failed"),
      done: rows.filter((r) => mockCol(r) === "done"),
    }),
    [rows],
  );

  if (waiting) {
    return (
      <WaitCard
        job="打样"
        jobStatus={job?.job_status || (job?.status === "queued" || job?.status === "running" ? job.status : "queued")}
        queueAhead={job?.queue_ahead}
        stageLabel={job?.job_stage_label}
        etaS={job?.job_eta_s}
      />
    );
  }

  return (
    <section className="new-form">
      <header className="page-head">
        <div>
          <h1 className="page-title">打样台</h1>
          <p className="page-lead">交差「盒子长什么样」。白底给备案，GLB 自己截图。不是网页里转着玩当验收。</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => void run()}>
          开始打样
        </button>
      </header>

      <Alert
        type="info"
        showIcon
        title="本机要有 Blender。流水线仍是仓库里的 Python worker，网页只负责交文件。"
      />

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

      {rows.length > 0 ? (
        <div className="review-board" style={{ marginTop: 20 }}>
          <MockCol title="打样中" hint="本机还在跑" rows={board.running} currentId={job?.id} onOpen={setJob} />
          <MockCol title="打样失败" hint="中断了，点开看原因" rows={board.failed} currentId={job?.id} onOpen={setJob} />
          <MockCol title="已出图" hint="白底和 GLB" rows={board.done} currentId={job?.id} onOpen={setJob} />
        </div>
      ) : (
        <p className="page-lead" style={{ marginTop: 16 }}>
          还没有打样单。选平面稿后点开始打样。
        </p>
      )}

      {job?.status === "failed" ? (
        <Alert type="error" showIcon style={{ marginTop: 16 }} title={job.error || job.job_error || "失败"} />
      ) : null}

      {job?.status === "done" ? (
        <div style={{ marginTop: 16 }}>
          <Typography.Title level={5}>{mockTitle(job)}</Typography.Title>
          <Space wrap>
            {(job.files || []).map((f) => (
              <Button key={f.key} href={`/api/mockups/${job.id}/files/${f.key}`}>
                下载{" "}
                {f.key === "white_a"
                  ? "白底 A"
                  : f.key === "white_b"
                    ? "白底 B"
                    : f.key === "ppt"
                      ? "PPT"
                      : f.key === "glb"
                        ? "GLB"
                        : f.name}
              </Button>
            ))}
          </Space>
          {(job.files || []).some((f) => f.key === "glb") ? (
            <div style={{ marginTop: 16 }}>
              <model-viewer
                src={`/api/mockups/${job.id}/files/glb`}
                camera-controls
                style={{
                  width: "100%",
                  height: 360,
                  background: "var(--stage)",
                  border: "1px solid var(--line)",
                  borderRadius: 16,
                }}
              />
              <Typography.Paragraph type="secondary">
                可旋转，自己截图交差。白底图不要带尺寸标注再交备案。
              </Typography.Paragraph>
            </div>
          ) : (
            <Empty style={{ marginTop: 16 }} description="没有 GLB。看上面的失败原因。" />
          )}
        </div>
      ) : null}
    </section>
  );
}

function MockCol({
  title,
  hint,
  rows,
  currentId,
  onOpen,
}: {
  title: string;
  hint: string;
  rows: MockupJob[];
  currentId?: string;
  onOpen: (job: MockupJob) => void;
}) {
  return (
    <div className="review-col">
      <div className="review-col-head">
        <strong>{title}</strong>
        <span>{rows.length}</span>
      </div>
      <p className="review-col-hint">{hint}</p>
      <div className="review-col-list">
        {rows.length === 0 ? <div className="review-col-empty">没有单</div> : null}
        {rows.map((row) => {
          const s = mockLabel(row);
          return (
            <button
              key={row.id}
              type="button"
              className={row.id === currentId ? "review-card is-on" : "review-card"}
              onClick={() => onOpen(row)}
            >
              <div className="review-card-name">{mockTitle(row)}</div>
              <div className="review-card-meta">
                <Tag color={s.color}>{s.text}</Tag>
                {row.owner ? <span>{row.owner}</span> : null}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
