import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Empty, Input, Space, Tag, Typography } from "antd";
import { api, type Decision, type FieldHit, type TaskDetail, type TaskPage } from "../api";

type Props = {
  taskId: string | null;
  onBack: () => void;
};

function excelText(h: FieldHit) {
  return h.excel || h.excel_value || h.expected || "—";
}

function pdfText(h: FieldHit) {
  return h.pdf || h.found || "—";
}

function statusTag(status?: string) {
  const s = status || "";
  if (s.includes("待人工") || s.includes("不清")) return <Tag color="warning">待人工确认</Tag>;
  if (s.includes("疑")) return <Tag color="warning">{s}</Tag>;
  if (s.includes("缺") || s.includes("误")) return <Tag color="error">{s}</Tag>;
  if (s.includes("一致")) return <Tag>{s}</Tag>;
  return <Tag>{s || "—"}</Tag>;
}

function pageList(task: TaskDetail | null): TaskPage[] {
  const raw = task?.pages;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p) => p && (p.url || p.name));
}

function boxLeft(b: Record<string, unknown>, width: number) {
  const x = Number(b.x ?? b.left ?? 0);
  const w = Number(width || 1);
  return `${(x / w) * 100}%`;
}

function boxTop(b: Record<string, unknown>, height: number) {
  const y = Number(b.y ?? b.top ?? 0);
  const h = Number(height || 1);
  return `${(y / h) * 100}%`;
}

function buildList(productName: string, hits: FieldHit[]) {
  const issues = hits.filter((h) => h.decision === "issue");
  const lines = [
    "待设计改稿",
    `品名：${productName || "—"}`,
    ...issues.map((h, i) => {
      const note = h.note ? `（${h.note}）` : "";
      return `${i + 1}. ${h.field || "字段"} / 第${h.page ?? "?"}页 / Excel：${excelText(h)} / 稿上：${pdfText(h)}${note}`;
    }),
  ];
  return { text: lines.join("\n"), count: issues.length };
}

export function ReviewPage({ taskId, onBack }: Props) {
  const { message } = App.useApp();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [active, setActive] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [conclusion, setConclusion] = useState("");
  const [busy, setBusy] = useState(false);
  const [useV2, setUseV2] = useState(false);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    void api
      .task(taskId)
      .then((t) => {
        if (cancelled) return;
        setTask(t);
        const seed: Record<string, string> = {};
        for (const h of t.hits || []) {
          if (h.id && h.note) seed[h.id] = h.note;
        }
        setNotes(seed);
        if (t.conclusion) setConclusion(t.conclusion);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const hits = (useV2 ? task?.hits_v2 : task?.hits) || [];
  const pages = pageList(useV2 ? { ...(task as TaskDetail), pages: task?.pages_v2 } : task);
  const page = pages[pageIdx];
  const signed = task?.status === "completed";

  const pinHits = useMemo(() => {
    return hits
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => {
        const p = Number(h.page || 0);
        const cur = Number(page?.page || pageIdx + 1);
        return !p || p === cur;
      });
  }, [hits, page, pageIdx]);

  if (!taskId) {
    return (
      <Empty description="还没有打开审核单">
        <Button onClick={onBack}>回到任务</Button>
      </Empty>
    );
  }

  async function decide(hit: FieldHit, decision: Decision) {
    if (!task || !hit.id || signed) return;
    setBusy(true);
    try {
      const next = await api.decide(task.id, {
        hit_id: hit.id,
        decision,
        note: notes[hit.id],
      });
      setTask(next);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "记录失败");
    } finally {
      setBusy(false);
    }
  }

  async function copyList() {
    if (!task) return;
    const { text, count } = buildList(task.product_name || task.title, hits);
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制 ${count} 条给设计`);
    } catch {
      message.error("复制失败，请手动选中文字");
    }
  }

  async function uploadRework(file: File) {
    if (!task) return;
    const fd = new FormData();
    fd.append("pdf", file);
    setBusy(true);
    try {
      const next = await api.rework(task.id, fd);
      setTask(next);
      setUseV2(true);
      message.success("已对照第二份 PDF。请核对上一轮有错的字段。");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "对红失败");
    } finally {
      setBusy(false);
    }
  }

  async function signOff() {
    if (!task) return;
    setBusy(true);
    try {
      const next = await api.complete(task.id, { conclusion, notify: true });
      setTask(next);
      message.success("已记录你的结论，不是系统过审");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "还不能签字");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button onClick={onBack}>返回列表</Button>
        {task?.pages_v2 ? (
          <Button type={useV2 ? "primary" : "default"} onClick={() => setUseV2((v) => !v)}>
            {useV2 ? "看这一版" : "看上一版"}
          </Button>
        ) : (
          <Button
            disabled={signed || busy}
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = ".pdf";
              input.onchange = () => {
                const f = input.files?.[0];
                if (f) void uploadRework(f);
              };
              input.click();
            }}
          >
            上传改稿 PDF（对红）
          </Button>
        )}
        {pages.length > 1
          ? pages.map((p, i) => (
              <Button key={p.url || i} type={i === pageIdx ? "primary" : "default"} onClick={() => setPageIdx(i)}>
                第 {p.page || i + 1} 页
              </Button>
            ))
          : null}
      </Space>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        {task?.product_name || task?.title || "审核"}
      </Typography.Title>
      {error ? <Alert type="error" title={error} style={{ marginBottom: 16 }} /> : null}
      {!task ? <Typography.Paragraph>正在对照，请稍候</Typography.Paragraph> : null}
      {task && hits.length === 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="机审没标出疑点，仍要你过一遍"
        />
      ) : null}
      {signed ? (
        <Alert type="success" showIcon style={{ marginBottom: 16 }} title="已签字，不是系统过审" />
      ) : null}

      <div className="review-desk">
        <div className="canvas">
          {page?.url ? (
            <div style={{ position: "relative" }}>
              <img src={page.url} alt="" />
              {pinHits.map(({ h, i }) => {
                const box = (h.bboxes && h.bboxes[0]) || {};
                const w = Number(page.width || 1);
                const ht = Number(page.height || 1);
                const hasBox = box && (box.x != null || box.left != null);
                return (
                  <button
                    key={h.id || i}
                    type="button"
                    className={i === active ? "pin is-on" : "pin"}
                    style={
                      hasBox
                        ? { left: boxLeft(box, w), top: boxTop(box, ht) }
                        : { left: `${12 + (i % 8) * 28}px`, top: "12px" }
                    }
                    onClick={() => setActive(i)}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          ) : (
            <Empty description="这一页还没有图" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 48 }} />
          )}
        </div>

        <aside className="notes">
          <Typography.Title level={5}>疑点</Typography.Title>
          {hits.length === 0 ? (
            <Typography.Paragraph type="secondary">没有机审条目。仍请翻页看一遍。</Typography.Paragraph>
          ) : (
            hits.map((h, i) => (
              <div
                key={h.id || i}
                className={i === active ? "hit-card is-on" : "hit-card"}
                onClick={() => {
                  setActive(i);
                  const p = Number(h.page || 0);
                  const idx = pages.findIndex((pg) => Number(pg.page) === p);
                  if (idx >= 0) setPageIdx(idx);
                }}
              >
                <Space wrap>
                  <strong>{i + 1}. {h.field || "字段"}</strong>
                  {statusTag(h.status)}
                  {h.decision && h.decision !== "pending" ? <Tag>{h.decision}</Tag> : null}
                </Space>
                <div className="mono">Excel：{excelText(h)}</div>
                <div className="mono">稿上：{pdfText(h)}</div>
                <Typography.Text type="secondary">第 {h.page ?? "?"} 页</Typography.Text>
                <Input
                  style={{ marginTop: 8 }}
                  placeholder="给你自己看的话，会进改稿清单"
                  value={h.id ? notes[h.id] || "" : ""}
                  disabled={signed || !h.id}
                  onChange={(e) => {
                    if (!h.id) return;
                    setNotes((prev) => ({ ...prev, [h.id as string]: e.target.value }));
                  }}
                />
                {!signed && h.id ? (
                  <Space style={{ marginTop: 8 }} wrap>
                    <Button size="small" onClick={() => void decide(h, "confirm")}>
                      一致
                    </Button>
                    <Button size="small" danger onClick={() => void decide(h, "issue")}>
                      有错
                    </Button>
                    <Button size="small" onClick={() => void decide(h, "ignore")}>
                      忽略
                    </Button>
                  </Space>
                ) : null}
              </div>
            ))
          )}

          {task?.rework_check && task.rework_check.length > 0 ? (
            <>
              <Typography.Title level={5}>对红</Typography.Title>
              {task.rework_check.map((row) => (
                <div key={row.field} className="hit-card">
                  <strong>{row.field}</strong>
                  <div>上一版：{row.v1_status}</div>
                  <div>这一版：{row.v2_status}</div>
                </div>
              ))}
            </>
          ) : null}

          <Typography.Title level={5} style={{ marginTop: 16 }}>
            写下结论
          </Typography.Title>
          <Input.TextArea
            rows={3}
            value={conclusion}
            disabled={signed}
            onChange={(e) => setConclusion(e.target.value)}
            placeholder="人话结论，不是系统过审"
          />
          <Space style={{ marginTop: 12 }} wrap>
            <Button onClick={() => void copyList()}>复制改稿清单</Button>
            <Button type="primary" loading={busy} disabled={signed} onClick={() => void signOff()}>
              {hits.some((h) => h.decision === "issue") ? "签字并待设计改稿" : "签字"}
            </Button>
          </Space>
        </aside>
      </div>
    </section>
  );
}
