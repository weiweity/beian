import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Checkbox, DatePicker, Empty, Segmented, Select, Table, Tag } from "antd";
import type { Dayjs } from "dayjs";
import { api, ApiError, transientApiFailure, type MockupJob, type PendingUploadReceipt, type TaskSummary } from "../api";
import { uploadStore, useUploadSnapshot, type UploadKind } from "../uploadStore";
import {
  filterHistoryRows,
  historyActors,
  historyCanDelete,
  historyHasLive,
  historyMockRow,
  historyRowKey,
  historySelectionState,
  historyTaskRow,
  historyUploadRow,
  type HistoryKindFilter,
  type HistoryRow,
  type HistoryTimeFilter,
} from "./historyRows";
import { pendingUploadItems } from "./uploadDesk";

type Props = {
  canCreate: boolean;
  canDelete: boolean;
  onOpenTask: (id: string) => void;
  onOpenMockup: (id: string) => void;
  onOpenUpload: (kind: UploadKind, id?: string | null) => void;
};

type Row = HistoryRow;

export type HistoryRowAction = "open-task" | "open-mockup" | "open-upload" | "toggle" | "blocked";

export function historyRowAction(row: Row, editing: boolean): HistoryRowAction {
  if (!editing) {
    if (row.resource === "upload") return "open-upload";
    return row.resource === "task" ? "open-task" : "open-mockup";
  }
  return historyCanDelete(row) ? "toggle" : "blocked";
}

function clock(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function HistoryPage({ canCreate, canDelete, onOpenTask, onOpenMockup, onOpenUpload }: Props) {
  const { message, modal } = App.useApp();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [jobs, setJobs] = useState<MockupJob[]>([]);
  const [uploads, setUploads] = useState<PendingUploadReceipt[]>([]);
  const compareUpload = useUploadSnapshot("compare");
  const mockupUpload = useUploadSnapshot("mockup");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [kind, setKind] = useState<HistoryKindFilter>("全部");
  const [time, setTime] = useState<HistoryTimeFilter>("全部");
  const [actor, setActor] = useState("");
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const loadGen = useRef(0);

  function load() {
    const g = ++loadGen.current;
    return Promise.all([
      api.tasks(),
      api.mockups().catch(() => [] as MockupJob[]),
      canCreate ? api.uploads().catch(() => [] as PendingUploadReceipt[]) : Promise.resolve([] as PendingUploadReceipt[]),
    ]).then(([t, m, u]) => {
      if (g !== loadGen.current) return;
      setTasks(t);
      setJobs(m);
      setUploads(u);
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
  }, [canCreate]);

  const rows = useMemo(() => {
    const pending = [
      ...pendingUploadItems("compare", compareUpload, uploads),
      ...pendingUploadItems("mockup", mockupUpload, uploads),
    ].map(historyUploadRow);
    const out = [...pending, ...tasks.map(historyTaskRow), ...jobs.map(historyMockRow)];
    out.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    return out;
  }, [compareUpload, jobs, mockupUpload, tasks, uploads]);

  const live = historyHasLive(rows);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(id);
  }, [live]);

  const actors = useMemo(() => historyActors(rows), [rows]);
  const visibleRows = useMemo(
    () =>
      filterHistoryRows(rows, {
        kind,
        time,
        actor,
        range: range
          ? {
              from: range[0].startOf("day").toDate(),
              to: range[1].endOf("day").toDate(),
            }
          : null,
      }),
    [actor, kind, range, rows, time],
  );
  const selection = useMemo(() => historySelectionState(visibleRows, selected), [selected, visibleRows]);

  useEffect(() => {
    if (actor && !actors.includes(actor)) setActor("");
  }, [actor, actors]);

  useEffect(() => {
    const current = new Set(visibleRows.filter(historyCanDelete).map(historyRowKey));
    setSelected((keys) => keys.filter((key) => current.has(key)));
  }, [visibleRows]);

  function toggle(row: Row) {
    if (!historyCanDelete(row)) return;
    const key = historyRowKey(row);
    setSelected((keys) => (keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key]));
  }

  function toggleAll(checked: boolean) {
    setSelected(checked ? selection.keys : []);
  }

  function activateRow(row: Row) {
    const action = historyRowAction(row, editing);
    if (action === "toggle") toggle(row);
    else if (action === "open-task") onOpenTask(row.id);
    else if (action === "open-mockup") onOpenMockup(row.id);
    else if (action === "open-upload" && row.uploadKind) onOpenUpload(row.uploadKind, row.uploadId);
  }

  async function removeOnce(row: Row): Promise<void> {
    if (row.resource === "task") {
      const result = await api.deleteTask(row.id);
      if (!result.ok) throw new Error("服务器没有确认删除审核单");
      return;
    }
    if (row.resource === "mockup") {
      const result = await api.deleteMockup(row.id);
      if (!result.ok) throw new Error("服务器没有确认删除打样单");
      return;
    }
    if (row.uploadId) {
      const result = await api.discardUpload(row.uploadId);
      if (!result.ok) throw new Error("这份上传已经开工、过期或不属于当前账号");
      return;
    }
    if (row.uploadKind) await uploadStore.abandon(row.uploadKind);
  }

  async function removeWithRetry(row: Row): Promise<void> {
    try {
      await removeOnce(row);
    } catch (err) {
      if (!transientApiFailure(err)) throw err;
      await new Promise((resolve) => window.setTimeout(resolve, 800));
      await removeOnce(row);
    }
  }

  async function removeMany(targets: Row[]) {
    setBusy(true);
    const failures: Array<{ title: string; reason: string }> = [];
    try {
      for (const row of targets) {
        try {
          await removeWithRetry(row);
        } catch (err) {
          failures.push({ title: row.title, reason: err instanceof Error ? err.message : "删除请求失败" });
        }
      }
      try {
        await load();
      } catch {
        message.warning("记录已处理，但列表刷新失败，请稍后再进历史记录确认。 ");
      }
      if (failures.length) {
        const summary = `已删除 ${targets.length - failures.length} 条，${failures.length} 条未删除`;
        modal.warning({
          className: "history-delete-modal",
          centered: true,
          title: null,
          content: (
            <div className="history-delete-errors">
              <strong className="history-delete-summary">{summary}</strong>
              {failures.map((failure) => (
                <p key={`${failure.title}-${failure.reason}`}><strong>{failure.title}</strong>：{failure.reason}</p>
              ))}
            </div>
          ),
        });
      }
      else message.success(`已删除 ${targets.length} 条记录`);
      setSelected([]);
    } finally {
      setBusy(false);
    }
  }

  function confirmRemove() {
    const chosen = rows.filter((row) => selected.includes(historyRowKey(row)) && historyCanDelete(row));
    if (!chosen.length) return;
    modal.confirm({
      className: "history-delete-modal",
      centered: true,
      title: `删除这 ${chosen.length} 条记录？`,
      content: "会删除选中的记录及其本地稿件或结果文件；已经发出的飞书消息不会撤回。删除后不能恢复。",
      okText: "删除记录",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: () => removeMany(chosen),
    });
  }

  return (
    <section className={`history-page${editing ? " is-editing" : ""}`}>
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
        <>
          <div className="history-filterbar" aria-label="历史记录筛选">
            {canDelete ? (
              <Button
                className="history-edit"
                type={editing ? "primary" : "default"}
                onClick={() => {
                  setEditing((value) => !value);
                  setSelected([]);
                }}
              >
                {editing ? "完成" : "编辑"}
              </Button>
            ) : null}
            <Segmented<HistoryKindFilter>
              aria-label="类型"
              options={["全部", "审稿台", "打样台"]}
              value={kind}
              onChange={setKind}
            />
            <Segmented<HistoryTimeFilter>
              aria-label="时间"
              options={["全部", "今天", "近 7 天", "近 30 天"]}
              value={time}
              onChange={(value) => {
                setTime(value);
                setRange(null);
              }}
            />
            <DatePicker.RangePicker
              aria-label="日期范围"
              className="history-range"
              value={range}
              placeholder={["开始日期", "结束日期"]}
              onChange={(value) => {
                setRange(value?.[0] && value[1] ? [value[0], value[1]] : null);
                if (value?.[0] && value[1]) setTime("全部");
              }}
            />
            {actors.length > 1 ? (
              <Select
                aria-label="生成人"
                className="history-actor"
                value={actor || undefined}
                placeholder="全部生成人"
                allowClear
                options={actors.map((name) => ({ label: name, value: name }))}
                onChange={(value) => setActor(value || "")}
              />
            ) : null}
            <span className="history-filter-count" aria-live="polite">
              {visibleRows.length} 条
            </span>
          </div>
          <div className="history-table-shell">
            <Table<Row>
              rowKey={historyRowKey}
              dataSource={visibleRows}
              pagination={false}
              scroll={{ x: 760 }}
              locale={{ emptyText: "没有符合筛选的记录" }}
              rowClassName={(row) => (!historyCanDelete(row) && editing ? "history-row-locked" : "")}
              onRow={(row) => ({
                onClick: () => activateRow(row),
                style: { cursor: editing && !historyCanDelete(row) ? "not-allowed" : "pointer" },
              })}
              columns={[
                ...(editing
                  ? [
                      {
                        title: (
                          <Checkbox
                            aria-label="全选可删除记录"
                            checked={selection.all}
                            indeterminate={selection.some}
                            disabled={!selection.keys.length}
                            onChange={(event) => toggleAll(event.target.checked)}
                          >
                            全选
                          </Checkbox>
                        ),
                        key: "select",
                        width: 104,
                        render: (_: unknown, row: Row) => (
                          <span
                            className="history-select-hitbox"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Checkbox
                              aria-label={`选择 ${row.title}`}
                              checked={selected.includes(historyRowKey(row))}
                              disabled={!historyCanDelete(row)}
                              onChange={() => toggle(row)}
                            />
                          </span>
                        ),
                      },
                    ]
                  : []),
                { title: "类型", dataIndex: "kind", width: 100 },
                {
                  title: "品名",
                  dataIndex: "title",
                  render: (_: unknown, row: Row) =>
                    editing ? (
                      <span>{row.title}</span>
                    ) : (
                      <button
                        type="button"
                        className="history-record-button"
                        aria-label={`打开${row.kind}记录：${row.title}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          activateRow(row);
                        }}
                      >
                        {row.title}
                      </button>
                    ),
                },
                { title: "生成时间", dataIndex: "at", width: 180, render: (v: string) => clock(v) },
                {
                  title: "状态",
                  dataIndex: "status",
                  width: 220,
                  render: (_: unknown, row: Row) => (
                    <div>
                      <Tag color={row.color}>{row.status}</Tag>
                      {row.live ? <div className="review-card-live">{row.live}</div> : null}
                    </div>
                  ),
                },
                { title: "生成人", dataIndex: "actor", width: 120, render: (v: string) => v || "—" },
              ]}
            />
          </div>
          {editing ? (
            <div className="history-bulkbar" role="toolbar" aria-label="批量删除记录">
              <Checkbox
                checked={selection.all}
                indeterminate={selection.some}
                disabled={!selection.keys.length}
                onChange={(event) => toggleAll(event.target.checked)}
              >
                全选
              </Checkbox>
              <strong>已选 {selected.length} 条</strong>
              <span>进行中的记录不会被选中</span>
              <Button danger type="primary" loading={busy} disabled={!selected.length} onClick={confirmRemove}>
                删除
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
