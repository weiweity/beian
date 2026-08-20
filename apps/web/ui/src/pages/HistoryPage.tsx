import { useEffect, useMemo, useState } from "react";
import { Alert, Empty } from "antd";
import { api, ApiError, type MockupJob, type TaskSummary } from "../api";

type Props = {
  onOpenTask: (id: string) => void;
  onOpenMockup: () => void;
};

type Row =
  | { kind: "审稿"; id: string; title: string; meta: string; at: string }
  | { kind: "打样"; id: string; title: string; meta: string; at: string };

function taskMeta(row: TaskSummary) {
  if (row.status === "completed") return "已签字";
  if (row.status === "in_review" || row.status === "pending_review") return "待她判";
  if (row.status === "compare_failed") return "对照失败";
  if (row.status === "comparing") return "对照中";
  return row.status;
}

function mockMeta(row: MockupJob) {
  if (row.status === "done") return "已出图";
  if (row.status === "failed") return row.error || "失败";
  if (row.status === "running" || row.status === "queued") return "打样中";
  return row.status;
}

export function HistoryPage({ onOpenTask, onOpenMockup }: Props) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [jobs, setJobs] = useState<MockupJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.tasks(), api.mockups().catch(() => [] as MockupJob[])])
      .then(([t, m]) => {
        if (cancelled) return;
        setTasks(t);
        setJobs(m);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) setError("未登录，请重新用飞书进入。");
        else setError(err instanceof Error ? err.message : "加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    const out: Row[] = [
      ...tasks.map((t) => ({
        kind: "审稿" as const,
        id: t.id,
        title: t.product_name || t.title,
        meta: taskMeta(t),
        at: t.created_at || "",
      })),
      ...jobs.map((j) => ({
        kind: "打样" as const,
        id: j.id,
        title: j.files[0]?.name || j.id.slice(0, 8),
        meta: mockMeta(j),
        at: j.created_at || "",
      })),
    ];
    out.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    return out;
  }, [tasks, jobs]);

  return (
    <section>
      <header className="page-head">
        <div>
          <h1 className="page-title">历史记录</h1>
          <p className="page-lead">审稿和打样混在一起。不是第三张台。</p>
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
        <div className="history-list">
          {rows.map((row) => (
            <button
              key={`${row.kind}-${row.id}`}
              type="button"
              className="history-row"
              onClick={() => (row.kind === "审稿" ? onOpenTask(row.id) : onOpenMockup())}
            >
              <div>
                <div className="history-kind">{row.kind}</div>
                <div className="review-card-name">{row.title}</div>
              </div>
              <span className="review-card-meta">{row.meta}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
