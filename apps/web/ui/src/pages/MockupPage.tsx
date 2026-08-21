import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Space, Typography } from "antd";
import { api, type MockupJob } from "../api";
import { UploadWell } from "../chrome/UploadWell";
import { WaitCard } from "../chrome/WaitCard";
import { shouldShowWaitCard } from "./waitCard";
import "@google/model-viewer";

function mockupWaiting(job: MockupJob | null): boolean {
  if (!job) return false;
  if (job.status === "queued" || job.status === "running") return true;
  return shouldShowWaitCard(job);
}

export function MockupPage() {
  const { message } = App.useApp();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<MockupJob | null>(null);
  const announced = useRef("");

  const jobWaiting = mockupWaiting(job);
  const waiting = busy || jobWaiting;

  useEffect(() => {
    if (!job?.id || !jobWaiting) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      void api
        .mockup(job.id)
        .then((next) => {
          if (cancelled) return;
          setJob(next);
          if (next.status === "queued" || next.status === "running" || shouldShowWaitCard(next)) return;
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

  async function run() {
    if (!file) {
      message.warning("先选平面 PDF 或 AI");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    setBusy(true);
    setJob(null);
    announced.current = "";
    try {
      const next = await api.createMockup(fd);
      setJob(next);
      if (next.status === "queued" || next.status === "running" || shouldShowWaitCard(next)) return;
      announced.current = `${next.id}:${next.status}`;
      if (next.status === "failed") message.error(next.error || next.job_error || "打样失败");
      else if (next.status === "done") message.success("打样完成。白底图给备案，GLB 可本机打开截图。");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "打样失败");
    } finally {
      setBusy(false);
    }
  }

  if (waiting) {
    return (
      <WaitCard
        job="打样"
        jobStatus={job?.job_status || (job?.status === "queued" || job?.status === "running" ? job.status : undefined)}
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

      <div className="upload-row" style={{ gridTemplateColumns: "1fr" }}>
        <UploadWell
          icon="/brand/ui/well-pdf.svg"
          title="平面稿"
          hint="把平面 PDF / AI 拖到这里"
          accept=".pdf,.ai"
          fileName={file?.name}
          disabled={busy}
          onFile={setFile}
        >
          <span className="upload-well-btn">选取平面稿</span>
        </UploadWell>
      </div>

      {job?.status === "failed" ? (
        <Alert type="error" showIcon title={job.error || job.job_error || "失败"} />
      ) : null}

      {job?.status === "done" ? (
        <div>
          <Typography.Title level={5}>产物</Typography.Title>
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
