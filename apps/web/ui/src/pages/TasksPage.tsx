import { useEffect, useState } from "react";
import { Alert, Button, Empty, Input, Space, Table, Tag, Typography } from "antd";
import { api, ApiError, type TaskSummary } from "../api";

type Props = {
  onCreate: () => void;
  onOpen: (id: string) => void;
};

function statusLabel(row: TaskSummary) {
  if (row.status === "completed") return { text: "已签字", color: "default" as const };
  if (row.status === "in_review" || row.status === "pending_review") {
    return { text: "待她判", color: "warning" as const };
  }
  return { text: row.status, color: "default" as const };
}

export function TasksPage({ onCreate, onOpen }: Props) {
  const [rows, setRows] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .tasks(submitted || undefined)
      .then((list) => {
        if (!cancelled) setRows(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) setError("未登录，请重新用飞书进入。");
        else setError(err instanceof Error ? err.message : "加载失败，再试一次");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [submitted]);

  const emptyText = error
    ? error
    : submitted
      ? "没有找到这个品名"
      : "还没有审核单";

  return (
    <section>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }} wrap>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            审稿台
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: "4px 0 0" }}>
            待签在上。机审只标疑点，结论由你来写。
          </Typography.Paragraph>
        </div>
        <Space>
          <Input.Search
            allowClear
            placeholder="搜品名"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onSearch={(v) => setSubmitted(v.trim())}
            style={{ width: 240 }}
          />
          <Button type="primary" onClick={onCreate}>
            新建 Excel↔PDF
          </Button>
        </Space>
      </Space>
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title={error}
          action={
            <Button size="small" onClick={() => setSubmitted((s) => s)}>
              再试一次
            </Button>
          }
        />
      ) : null}
      <Table<TaskSummary>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        locale={{
          emptyText: (
            <Empty description={emptyText} image={Empty.PRESENTED_IMAGE_SIMPLE}>
              {submitted ? (
                <Button
                  onClick={() => {
                    setQ("");
                    setSubmitted("");
                  }}
                >
                  清空
                </Button>
              ) : (
                <Button type="primary" onClick={onCreate}>
                  新建 Excel↔PDF
                </Button>
              )}
            </Empty>
          ),
        }}
        pagination={false}
        columns={[
          {
            title: "品名",
            render: (_, row) => row.product_name || row.title,
          },
          { title: "标题", dataIndex: "title" },
          {
            title: "状态",
            dataIndex: "status",
            width: 120,
            render: (_, row) => {
              const s = statusLabel(row);
              return <Tag color={s.color}>{s.text}</Tag>;
            },
          },
          { title: "创建", dataIndex: "created_at", width: 220 },
          {
            title: "",
            key: "open",
            width: 100,
            render: (_, row) => (
              <Button type="link" onClick={() => onOpen(row.id)}>
                打开
              </Button>
            ),
          },
        ]}
      />
    </section>
  );
}
