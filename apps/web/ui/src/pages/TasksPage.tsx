import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Input, Segmented, Space, Table, Tag } from "antd";
import { api, ApiError, type TaskSummary } from "../api";
import { shouldShowTaskBoard } from "./tasksBoard";

type Props = {
  onCreate: () => void;
  onOpen: (id: string) => void;
};

type Layout = "board" | "table";
type Col = "comparing" | "failed" | "review" | "done";

function statusLabel(row: TaskSummary) {
  if (row.status === "completed") return { text: "已签字", color: "default" as const };
  if (row.status === "in_review" || row.status === "pending_review") {
    return { text: "待她判", color: "warning" as const };
  }
  if (row.status === "compare_failed" || row.job_status === "failed") {
    return { text: "对照失败", color: "error" as const };
  }
  if (row.status === "comparing") return { text: "正在对照", color: "processing" as const };
  return { text: row.status, color: "default" as const };
}

function columnOf(row: TaskSummary): Col {
  if (row.board) return row.board;
  if (row.status === "completed") return "done";
  if (row.status === "pending_review" || row.status === "in_review") return "review";
  if (row.status === "compare_failed" || row.job_status === "failed") return "failed";
  return "comparing";
}

export function TasksPage({ onCreate, onOpen }: Props) {
  const [rows, setRows] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [layout, setLayout] = useState<Layout>("board");
  const [reload, setReload] = useState(0);

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
  }, [submitted, reload]);

  const live = rows.some((r) => columnOf(r) === "comparing");

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      void api
        .tasks(submitted || undefined)
        .then((list) => {
          if (!cancelled) setRows(list);
        })
        .catch(() => undefined);
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [live, submitted]);

  const showSearch = Boolean(submitted) || rows.length > 0;
  const showBoard = shouldShowTaskBoard(rows.length, submitted);
  const board = useMemo(
    () => ({
      comparing: rows.filter((r) => columnOf(r) === "comparing"),
      failed: rows.filter((r) => columnOf(r) === "failed"),
      review: rows.filter((r) => columnOf(r) === "review"),
      done: rows.filter((r) => columnOf(r) === "done"),
    }),
    [rows],
  );

  return (
    <section>
      <div className="desk-head">
        <div>
          <h1 className="page-title">审核单</h1>
          <p className="page-lead">待签在上。机审只标疑点，结论由你来写。</p>
        </div>
        <Space wrap>
          {showSearch ? (
            <Input.Search
              allowClear
              placeholder="搜品名"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onSearch={(v) => setSubmitted(v.trim())}
              style={{ width: 240 }}
            />
          ) : null}
          {showBoard ? (
            <Segmented
              value={layout}
              onChange={(v) => setLayout(v as Layout)}
              options={[
                { label: "看板", value: "board" },
                { label: "表格", value: "table" },
              ]}
            />
          ) : null}
          <Button type="primary" onClick={onCreate}>
            新建 Excel↔PDF
          </Button>
        </Space>
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title={error}
          action={
            <Button size="small" onClick={() => setReload((n) => n + 1)}>
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
                <div>读取审核单…</div>
              ) : (
                <div>
                  <div>还没有审核单</div>
                  <div className="desk-empty-hint">把 Excel 和备案/包装 PDF 交上来对照</div>
                </div>
              )
            }
          >
            {loading ? null : (
              <Button type="primary" onClick={onCreate}>
                新建 Excel↔PDF
              </Button>
            )}
          </Empty>
        </div>
      ) : layout === "board" ? (
        <div className="review-board is-four">
          <BoardCol title="对照中" hint="机器还在跑" rows={board.comparing} onOpen={onOpen} />
          <BoardCol title="对照失败" hint="中断了，点开看原因" rows={board.failed} onOpen={onOpen} />
          <BoardCol title="待她判" hint="要人写结论" rows={board.review} onOpen={onOpen} />
          <BoardCol title="已签字" hint="结论已记下" rows={board.done} onOpen={onOpen} />
        </div>
      ) : (
        <Table<TaskSummary>
          rowKey="id"
          loading={loading}
          dataSource={rows}
          locale={{
            emptyText: (
              <Empty
                description={submitted ? "没有找到这个品名" : "还没有审核单"}
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              >
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
      )}
    </section>
  );
}

function BoardCol({
  title,
  hint,
  rows,
  onOpen,
}: {
  title: string;
  hint: string;
  rows: TaskSummary[];
  onOpen: (id: string) => void;
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
          const s = statusLabel(row);
          return (
            <button key={row.id} type="button" className="review-card" onClick={() => onOpen(row.id)}>
              <div className="review-card-name">{row.product_name || row.title}</div>
              <div className="review-card-meta">
                <Tag color={s.color}>{s.text}</Tag>
                {row.owner ? <span>{row.owner}</span> : null}
              </div>
              {row.error ? <div className="review-card-err">{row.error}</div> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
