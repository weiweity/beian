import { useState } from "react";
import { Alert, App, Button, Form, Input, Radio, Typography, Upload } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import type { UploadFile } from "antd/es/upload/interface";
import { api } from "../api";

type Props = { onCreated: (id: string) => void };

export function NewTaskPage({ onCreated }: Props) {
  const { message } = App.useApp();
  const [excel, setExcel] = useState<UploadFile[]>([]);
  const [pdf, setPdf] = useState<UploadFile[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function onFinish(values: { product_name: string; pack_surface: string }) {
    const excelFile = excel[0]?.originFileObj;
    const pdfFile = pdf[0]?.originFileObj;
    const productName = (values.product_name || "").trim();
    if (!productName) {
      message.warning("品名必填。");
      return;
    }
    if (!excelFile || !pdfFile) {
      message.warning("请同时选择 Excel 和包装 PDF。");
      return;
    }
    const fd = new FormData();
    fd.append("product_name", productName);
    fd.append("title", productName);
    fd.append("pack_surface", values.pack_surface);
    fd.append("excel", excelFile);
    fd.append("pdf", pdfFile);
    setSubmitting(true);
    try {
      const task = await api.uploadExcelPdf(fd);
      message.success("已开始对照。结论还要你来定。");
      onCreated(task.id);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "上传失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <Typography.Title level={3}>新建 Excel↔PDF</Typography.Title>
      <Typography.Paragraph type="secondary">
        一次只传一对：确认单 Excel 和包装 PDF。品名用来以后找这单。
      </Typography.Paragraph>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title="机审只标疑点。OCR 认不清会写成「待人工确认」，不会自动过审。"
      />
      <Form
        layout="vertical"
        initialValues={{ pack_surface: "carton" }}
        onFinish={(v) => void onFinish(v)}
        style={{ maxWidth: 560 }}
      >
        <Form.Item
          label="品名"
          name="product_name"
          rules={[{ required: true, message: "品名必填" }]}
        >
          <Input maxLength={80} placeholder="包装上的中文品名" />
        </Form.Item>
        <Form.Item label="包装面" name="pack_surface">
          <Radio.Group>
            <Radio.Button value="carton">花盒</Radio.Button>
            <Radio.Button value="pouch">膜袋</Radio.Button>
          </Radio.Group>
        </Form.Item>
        <Form.Item label="Excel" required>
          <Upload.Dragger
            maxCount={1}
            accept=".xlsx"
            fileList={excel}
            beforeUpload={() => false}
            onChange={({ fileList }) => setExcel(fileList.slice(-1))}
            disabled={submitting}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p>{excel[0]?.name || "把确认单 .xlsx 拖到这里"}</p>
          </Upload.Dragger>
        </Form.Item>
        <Form.Item label="包装 PDF" required>
          <Upload.Dragger
            maxCount={1}
            accept=".pdf"
            fileList={pdf}
            beforeUpload={() => false}
            onChange={({ fileList }) => setPdf(fileList.slice(-1))}
            disabled={submitting}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p>{pdf[0]?.name || "把包装 PDF 拖到这里"}</p>
          </Upload.Dragger>
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={submitting}>
          {submitting ? `正在对照 ${excel[0]?.name || ""}` : "开始对照"}
        </Button>
      </Form>
    </section>
  );
}
