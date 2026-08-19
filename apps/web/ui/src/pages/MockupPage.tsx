import { useState } from "react";
import { Alert, App, Button, Empty, Space, Typography, Upload } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import type { UploadFile } from "antd/es/upload/interface";
import { api, type MockupJob } from "../api";
import "@google/model-viewer";

export function MockupPage() {
  const { message } = App.useApp();
  const [file, setFile] = useState<UploadFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<MockupJob | null>(null);

  async function run() {
    const src = file[0]?.originFileObj;
    if (!src) {
      message.warning("先选平面 PDF 或 AI");
      return;
    }
    const fd = new FormData();
    fd.append("file", src);
    setBusy(true);
    try {
      const next = await api.createMockup(fd);
      setJob(next);
      if (next.status === "failed") message.error(next.error || "打样失败");
      else message.success("打样完成。白底图给备案，GLB 可本机打开截图。");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "打样失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ maxWidth: 720 }}>
      <Typography.Title level={3}>打样台</Typography.Title>
      <Typography.Paragraph type="secondary">
        对完字之后在这里交差「盒子长什么样」。交付是 2 张白底、1 份 PPT、1 个可旋转 GLB（自己截图）。
        不是网页里转着玩当验收。
      </Typography.Paragraph>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title="本机要有 Blender。流水线仍是仓库里的 Python worker，网页只负责交文件。"
      />
      <Upload.Dragger
        maxCount={1}
        accept=".pdf,.ai"
        fileList={file}
        beforeUpload={() => false}
        onChange={({ fileList }) => setFile(fileList.slice(-1))}
        disabled={busy}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p>{file[0]?.name || "把平面 PDF / AI 拖到这里"}</p>
      </Upload.Dragger>
      <Button type="primary" style={{ marginTop: 16 }} loading={busy} onClick={() => void run()}>
        开始打样
      </Button>

      {job?.status === "failed" ? (
        <Alert type="error" showIcon style={{ marginTop: 16 }} title={job.error || "失败"} />
      ) : null}

      {job?.status === "done" ? (
        <div style={{ marginTop: 24 }}>
          <Typography.Title level={5}>产物</Typography.Title>
          <Space wrap>
            {job.files.map((f) => (
              <Button key={f.key} href={`/api/mockups/${job.id}/files/${f.key}`}>
                下载 {f.key === "white_a" ? "白底 A" : f.key === "white_b" ? "白底 B" : f.key === "ppt" ? "PPT" : f.key === "glb" ? "GLB" : f.name}
              </Button>
            ))}
          </Space>
          {job.files.some((f) => f.key === "glb") ? (
            <div style={{ marginTop: 16 }}>
              <model-viewer
                src={`/api/mockups/${job.id}/files/glb`}
                camera-controls
                style={{ width: "100%", height: 360, background: "#fff", border: "1px solid #dee0e3" }}
              />
              <Typography.Paragraph type="secondary">可旋转，自己截图交差。白底图不要带尺寸标注再交备案。</Typography.Paragraph>
            </div>
          ) : (
            <Empty style={{ marginTop: 16 }} description="没有 GLB。看上面的失败原因。" />
          )}
        </div>
      ) : null}
    </section>
  );
}
