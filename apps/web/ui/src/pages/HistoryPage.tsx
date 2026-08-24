import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Empty, Popconfirm, Table, Tag } from "antd";
import { api, ApiError, type MockupJob, type TaskSummary } from "../api";
import { historyHasLive, historyMockRow, historyTaskRow, type HistoryRow } from "./historyRows";

type Props = {
  onOpenTask: (id: string) => void;
  onOpenMockup: (id: string) => void;
};

type Row = HistoryRow;

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
    const out = [...tasks.map(historyTaskRow), ...jobs.map(historyMockRow)];
    out.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    return out;
  }, [tasks, jobs]);

  const live = historyHasLive(rows);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(id);
  }, [live]);

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
          <p className="page-lead">审稿和打样分列。进行中的也在这里，点进去看进度。</p>
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
              width: 220,
              render: (_, row) => (
                <div>
                  <Tag color={row.color}>{row.status}</Tag>
                  {row.live ? <div className="review-card-live">{row.live}</div> : null}
                </div>
              ),
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
