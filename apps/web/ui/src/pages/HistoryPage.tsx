import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Empty, Popconfirm, Table, Tag } from "antd";
import { api, ApiError, type MockupJob, type TaskSummary } from "../api";

type Props = {
  onOpenTask: (id: string) => void;
  onOpenMockup: (id: string) => void;
};

type Row = {
  kind: "审稿台" | "打样台";
  id: string;
  title: string;
  status: string;
  color: "default" | "warning" | "error" | "processing" | "success";
  at: string;
  actor: string;
};

function taskRow(row: TaskSummary): Row {
  let status = row.status;
  let color: Row["color"] = "default";
  if (row.status === "completed") {
    status = "已签字";
    color = "success";
  } else if (row.status === "in_review" || row.status === "pending_review") {
    status = "待她判";
    color = "warning";
  } else if (row.status === "compare_failed" || row.job_status === "failed") {
    status = row.job_error || row.error || "对照失败";
    color = "error";
  } else if (row.status === "comparing") {
    status = "对照中";
    color = "processing";
  }
  return {
    kind: "审稿台",
    id: row.id,
    title: row.product_name || row.title,
    status,
    color,
    at: row.created_at || "",
    actor: row.completed_by || row.owner || "",
  };
}

function mockRow(row: MockupJob): Row {
  let status = "打样";
  let color: Row["color"] = "default";
  if (row.status === "done") {
    status = "已出图";
    color = "success";
  } else if (row.status === "failed") {
    status = "打样中断";
    color = "error";
  } else if (row.status === "running" || row.status === "queued") {
    status = "打样中";
    color = "processing";
  } else {
    status = row.status;
  }
  return {
    kind: "打样台",
    id: row.id,
    title: row.title || row.files[0]?.name || row.id.slice(0, 8),
    status,
    color,
    at: row.created_at || "",
    actor: row.owner || "",
  };
}

function clock(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function HistoryPage({ onOpenTask, onOpenMockup }: Props) {
  const { message } = App.useApp();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [jobs, setJobs] = useState<MockupJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const loadGen = useRef(0);

  function load() {
    const g = ++loadGen.current;
    return Promise.all([api.tasks(), api.mockups().catch(() => [] as MockupJob[])]).then(([t, m]) => {
      if (g !== loadGen.current) return;
      setTasks(t);
      setJobs(m);
    });
  }

  useEffect(() => {
    let cancelled = false;
    load().catch((err: unknown) => {
      if (cancelled) return;
      if (err instanceof ApiError && err.status === 401) setError("未登录，请重新用飞书进入。");
      else setError(err instanceof Error ? err.message : "加载失败");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    const out = [...tasks.map(taskRow), ...jobs.map(mockRow)];
    out.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    return out;
  }, [tasks, jobs]);

  async function remove(row: Row) {
    setBusy(row.id);
    try {
      if (row.kind === "审稿台") await api.deleteTask(row.id);
      else await api.deleteMockup(row.id);
      await load();
      message.success("已删除");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "删不掉");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <header className="page-head">
        <div>
          <h1 className="page-title">历史记录</h1>
          <p className="page-lead">审稿和打样分列。不是第三张台。</p>
        </div>
      </header>
      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} /> : null}
      {rows.length === 0 && !error ? (
        <div className="desk-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有记录。审稿台签过的单、本机跑过的打样会落在这里。"
          />
        </div>
      ) : (
        <Table<Row>
          rowKey={(r) => `${r.kind}-${r.id}`}
          dataSource={rows}
          pagination={false}
          onRow={(row) => ({
            onClick: () => (row.kind === "审稿台" ? onOpenTask(row.id) : onOpenMockup(row.id)),
            style: { cursor: "pointer" },
          })}
          columns={[
            { title: "类型", dataIndex: "kind", width: 100 },
            { title: "品名", dataIndex: "title" },
            { title: "生成时间", dataIndex: "at", width: 180, render: (v: string) => clock(v) },
            {
              title: "状态",
              dataIndex: "status",
              width: 140,
              render: (_, row) => <Tag color={row.color}>{row.status}</Tag>,
            },
            { title: "生成人", dataIndex: "actor", width: 120, render: (v: string) => v || "—" },
            {
              title: "删除",
              key: "del",
              width: 88,
              render: (_, row) => (
                <Popconfirm
                  title="删掉这单？"
                  okText="删除"
                  cancelText="取消"
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    void remove(row);
                  }}
                  onCancel={(e) => e?.stopPropagation()}
                >
                  <Button
                    type="link"
                    danger
                    size="small"
                    disabled={row.color === "processing"}
                    loading={busy === row.id}
                    onClick={(e) => e.stopPropagation()}
                  >
                    删除
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}
