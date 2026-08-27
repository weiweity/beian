import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Empty, Input, Segmented, Space, Table, Tag } from "antd";
import { api, ApiError, UPLOAD_TIMEOUT_MS, type PendingUploadReceipt, type TaskSummary } from "../api";
import { UPLOAD_RECOVERY_INTERVAL_MS, uploadStore, useUploadSnapshot } from "../uploadStore";
import { compareBoardProgress, liveJobLine } from "./waitCard";
import { shouldShowTaskBoard } from "./tasksBoard";
import { PENDING_REVIEW, deskClock, type DeskCardRow } from "./deskBoard";
import { DeskCol } from "./DeskCol";
import {
  pendingUploadCard,
  pendingUploadItems,
  loadDeskReceipts,
  shouldReconcileUpload,
  type PendingUploadItem,
} from "./uploadDesk";

type Props = {
  canCreate: boolean;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onResumeReceipt: (receipt: string) => void;
};

type Layout = "board" | "table";
type Col = "comparing" | "failed" | "review" | "done";

function statusLabel(row: TaskSummary) {
  if (row.status === "completed") return { text: "已签字", color: "default" as const };
  if (row.status === "in_review" || row.status === "pending_review") {
    return { text: PENDING_REVIEW, color: "warning" as const };
  }
  if (row.status === "compare_failed" || row.job_status === "failed") {
    return { text: "对照失败", color: "error" as const };
  }
  if (row.status === "comparing") return { text: "正在对照", color: "processing" as const };
  return { text: row.status, color: "default" as const };
}

function toDeskCard(row: TaskSummary): DeskCardRow {
  const status = statusLabel(row);
  return {
    id: row.id,
    title: row.product_name || row.title,
    statusText: status.text,
    statusColor: status.color,
    actor: row.owner,
    at: row.job_started_at || row.created_at,
    live: liveJobLine({
      job_status: row.job_status,
      job_stage_label: row.job_stage_label,
      job_eta_s: row.job_eta_s,
      queue_ahead: row.queue_ahead,
      kind: row.job_kind === "rework" ? "rework" : "compare",
    }),
    error: row.error || row.job_error,
    progress: columnOf(row) === "comparing" ? compareBoardProgress(row) : undefined,
  };
}

function columnOf(row: TaskSummary): Col {
  if (row.board) return row.board;
  if (row.status === "completed") return "done";
  if (row.status === "pending_review" || row.status === "in_review") return "review";
  if (row.status === "compare_failed" || row.job_status === "failed") return "failed";
  return "comparing";
}

export function TasksPage({ canCreate, onCreate, onOpen, onResumeReceipt }: Props) {
  const { message, modal } = App.useApp();
  const localUpload = useUploadSnapshot("compare");
  const [rows, setRows] = useState<TaskSummary[]>([]);
  const [receipts, setReceipts] = useState<PendingUploadReceipt[]>([]);
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
    void Promise.all([
      api.tasks(submitted || undefined),
      loadDeskReceipts(canCreate, api.uploads),
    ])
      .then(([tasks, pending]) => {
        if (cancelled) return;
        setRows(tasks);
        for (const receipt of pending) uploadStore.recover("compare", receipt);
        setReceipts(pending);
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
  }, [canCreate, submitted, reload]);

  const live = rows.some((row) => columnOf(row) === "comparing");
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

  const reconcileUpload = shouldReconcileUpload("compare", localUpload, receipts);
  useEffect(() => {
    if (!canCreate || !reconcileUpload) return;
    let cancelled = false;
    const reconcile = () => {
      void api
        .uploads()
        .then((pending) => {
          if (cancelled) return;
          for (const receipt of pending) uploadStore.recover("compare", receipt);
          setReceipts(pending);
        })
        .catch(() => undefined);
    };
    reconcile();
    const interval = window.setInterval(reconcile, UPLOAD_RECOVERY_INTERVAL_MS);
    const stop = window.setTimeout(() => window.clearInterval(interval), UPLOAD_TIMEOUT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(stop);
    };
  }, [canCreate, localUpload?.clientUploadId, localUpload?.phase, reconcileUpload]);

  const pendingItems = useMemo(
    () => pendingUploadItems("compare", localUpload, receipts, submitted),
    [localUpload, receipts, submitted],
  );
  const pendingCards = useMemo(
    () => pendingItems.map((item) => pendingUploadCard(item, "待对照")),
    [pendingItems],
  );
  const pendingByKey = useMemo(() => new Map(pendingItems.map((item) => [item.key, item])), [pendingItems]);
  const board = useMemo(
    () => ({
      comparing: rows.filter((row) => columnOf(row) === "comparing"),
      failed: rows.filter((row) => columnOf(row) === "failed"),
      review: rows.filter((row) => columnOf(row) === "review"),
      done: rows.filter((row) => columnOf(row) === "done"),
    }),
    [rows],
  );
  const totalCount = rows.length + pendingItems.length;
  const showSearch = Boolean(submitted) || totalCount > 0;
  const showBoard = shouldShowTaskBoard(totalCount, submitted) && totalCount > 0;
  const tableRows = useMemo(() => [...pendingCards, ...rows.map(toDeskCard)], [pendingCards, rows]);

  function openPending(item: PendingUploadItem) {
    if (!item.receipt) {
      onCreate();
      return;
    }
    if (!item.productName) {
      onResumeReceipt(item.receipt);
      return;
    }
    const receipt = item.receipt;
    const productName = item.productName;
    modal.confirm({
      title: "开始对照这单？",
      content: `品名：${productName}。上传文件已由服务器确认，开始后会进入对照队列。`,
      okText: "开始对照",
      cancelText: "先不开始",
      onOk: async () => {
        try {
          const next = await api.startTask({
            receipt,
            product_name: productName,
            title: productName,
            pack_surface: localUpload?.receipt === receipt ? localUpload.packSurface : undefined,
          });
          uploadStore.clear("compare", receipt);
          setReceipts((current) => current.filter((saved) => saved.id !== receipt));
          message.success("已开始对照。结论还要你来定。");
          onOpen(next.id);
        } catch (err) {
          message.error(err instanceof Error ? err.message : "无法开始对照");
          throw err;
        }
      },
    });
  }

  function openCard(id: string) {
    const pending = pendingByKey.get(id);
    if (pending) openPending(pending);
    else onOpen(id);
  }

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
              placeholder="搜品名或文件名"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              onClear={() => {
                setQ("");
                setSubmitted("");
              }}
              onSearch={(value) => setSubmitted(value.trim())}
              style={{ width: 240 }}
            />
          ) : null}
          {showBoard ? (
            <Segmented
              value={layout}
              onChange={(value) => setLayout(value as Layout)}
              options={[
                { label: "看板", value: "board" },
                { label: "表格", value: "table" },
              ]}
            />
          ) : null}
          {canCreate ? (
            <Button type="primary" onClick={onCreate}>
              进入工作台
            </Button>
          ) : null}
        </Space>
      </div>
      {error ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title={error}
          action={
            <Button size="small" onClick={() => setReload((count) => count + 1)}>
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
              ) : submitted ? (
                <div>没有找到这个品名或文件名</div>
              ) : (
                <div>
                  <div>还没有审核单</div>
                  <div className="desk-empty-hint">右上角进入工作台，把 Excel 和备案/包装 PDF 交上来对照</div>
                </div>
              )
            }
          >
            {loading ? null : submitted ? (
              <Button
                onClick={() => {
                  setQ("");
                  setSubmitted("");
                }}
              >
                清空
              </Button>
            ) : canCreate ? (
              <Button type="primary" onClick={onCreate}>
                进入工作台
              </Button>
            ) : null}
          </Empty>
        </div>
      ) : layout === "board" ? (
        <div className="review-board is-four">
          <DeskCol
            title="对照中"
            hint="上传中、待对照或机器运行"
            rows={[...pendingCards, ...board.comparing.map(toDeskCard)]}
            onOpen={openCard}
          />
          <DeskCol title="对照失败" hint="中断了，点开看原因" rows={board.failed.map(toDeskCard)} onOpen={onOpen} />
          <DeskCol title="待审核" hint="要人写结论" rows={board.review.map(toDeskCard)} onOpen={onOpen} />
          <DeskCol title="已签字" hint="结论已记下" rows={board.done.map(toDeskCard)} onOpen={onOpen} />
        </div>
      ) : (
        <Table<DeskCardRow>
          rowKey="id"
          loading={loading}
          dataSource={tableRows}
          pagination={false}
          scroll={{ x: 760 }}
          onRow={(row) => ({ onClick: () => openCard(row.id), style: { cursor: "pointer" } })}
          columns={[
            { title: "品名 / 文件", dataIndex: "title" },
            {
              title: "状态",
              width: 180,
              render: (_, row) => (
                <div>
                  <Tag color={row.statusColor}>{row.statusText}</Tag>
                  {row.live ? <div className="review-card-live">{row.live}</div> : null}
                </div>
              ),
            },
            { title: "工作时间", dataIndex: "at", width: 180, render: (value: string) => deskClock(value) },
            { title: "使用人", dataIndex: "actor", width: 100, render: (value: string) => value || "—" },
            { title: "", key: "open", width: 100, render: () => <Button type="link">打开</Button> },
          ]}
        />
      )}
    </section>
  );
}
