import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, App, Button, Empty, Input, Space, Tag } from "antd";
import { ApiError, api, type Decision, type FieldHit, type TaskDetail, type TaskPage } from "../api";
import { WaitCard } from "../chrome/WaitCard";
import { panBy, resetZoom, zoomAt, zoomCss, zoomToBox } from "./canvasZoom";
import { doubtLines, excelText, pdfText } from "./hitText";
import { hitOnPage, overlayFromBox, overlaysForHit, pickHitBox, resolvePageMetrics } from "./pinBox";
import {
  clampDockBox,
  clampDockPlace,
  dockCanvasInset,
  dockVisual,
  readBoxesOn,
  readDockBox,
  readPinsOn,
  resizeDockHandle,
  sidebarDockPlace,
  skipPackSheetField,
  writeBoxesOn,
  writeDockBox,
  writeDockOpen,
  writeDockPlace,
  writePinsOn,
  type DockBox,
  type DockHandle,
  type DockPlace,
} from "./reviewDock";
import { shouldShowWaitCard } from "./waitCard";

function browserStore(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

type Props = {
  taskId: string | null;
  onBack: () => void;
};

function isReviewable(status?: string) {
  return status === "pending_review" || status === "in_review";
}

function isReworkable(task: TaskDetail | null) {
  if (!task) return false;
  if (Array.isArray(task.pages_v2) && task.pages_v2.length > 0) return false;
  if (task.status === "pending_review" || task.status === "in_review") return true;
  return task.status === "completed" && task.complete_kind === "rework";
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

function statusLead(task: TaskDetail | null, pageIdx: number, pages: TaskPage[]) {
  const pageNo = pages[pageIdx]?.page || pageIdx + 1;
  if (!task) return "核对页";
  if (task.status === "completed") return `核对页 · 第 ${pageNo} 页 · 已签字`;
  if (isReviewable(task.status)) return `核对页 · 点字段，图上定位。第 ${pageNo} 页 · 待她判`;
  if (task.status === "compare_failed") return `核对页 · 第 ${pageNo} 页 · 对照中断`;
  return `核对页 · 第 ${pageNo} 页`;
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
  const [nat, setNat] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(resetZoom);
  const [dockOpen, setDockOpen] = useState(true);
  const [pinsOn, setPinsOn] = useState(() => readPinsOn(browserStore()));
  const [boxesOn, setBoxesOn] = useState(() => readBoxesOn(browserStore()));
  const [toolsOpen, setToolsOpen] = useState(true);
  const viewRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const zoomElRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const zoomRef = useRef(zoom);
  const dockOpenRef = useRef(true);
  const [dockBox, setDockBox] = useState<DockBox>(() => readDockBox(browserStore()));
  const [dockPlace, setDockPlace] = useState<DockPlace>(() =>
    sidebarDockPlace(typeof window === "undefined" ? { w: 1200, h: 800 } : { w: window.innerWidth, h: window.innerHeight }, readDockBox(browserStore())),
  );
  const panDrag = useRef<{ x: number; y: number } | null>(null);
  const panRaf = useRef<number | null>(null);
  const wheelEnd = useRef<number | null>(null);
  const dockResize = useRef<{
    x: number;
    y: number;
    box: DockBox;
    place: DockPlace;
    corner: DockHandle;
  } | null>(null);
  const dockDrag = useRef<{ x: number; y: number; place: DockPlace } | null>(null);
  const pendingFit = useRef<number | null>(null);
  const fitHitRef = useRef<(i: number) => void>(() => undefined);
  const canvasShellRef = useRef<HTMLDivElement>(null);
  const waiting = shouldShowWaitCard(task);
  const canvasReady = Boolean(
    !waiting &&
      pageList(useV2 ? { ...(task as TaskDetail), pages: task?.pages_v2 } : task)[pageIdx]?.url,
  );

  function paintZoom(next: typeof zoom) {
    const el = zoomElRef.current;
    if (el) el.style.transform = zoomCss(next);
  }

  function commitZoom(next: typeof zoom) {
    zoomRef.current = next;
    paintZoom(next);
    setZoom(next);
  }

  useLayoutEffect(() => {
    paintZoom(zoomRef.current);
  });

  function pageRoom() {
    if (typeof window === "undefined") return { w: 800, h: 600 };
    return { w: window.innerWidth, h: window.innerHeight };
  }

  function commitDock(box: DockBox, place?: DockPlace) {
    const room = pageRoom();
    const nextBox = clampDockBox(box, room);
    const nextPlace = clampDockPlace(place || dockPlace, room, nextBox);
    setDockBox(nextBox);
    setDockPlace(nextPlace);
    writeDockBox(browserStore(), nextBox);
    writeDockPlace(browserStore(), nextPlace);
  }

  function endPan(target?: EventTarget | null) {
    if (target instanceof HTMLElement) target.classList.remove("is-panning");
    else viewRef.current?.classList.remove("is-panning");
    if (panRaf.current != null) {
      window.cancelAnimationFrame(panRaf.current);
      panRaf.current = null;
    }
    paintZoom(zoomRef.current);
    setZoom(zoomRef.current);
    panDrag.current = null;
  }

  function paintDock(next: { box: DockBox; place: DockPlace }) {
    const el = dockRef.current;
    if (!el) return;
    const shown = dockVisual(dockOpenRef.current, next.box, next.place, pageRoom());
    el.style.width = `${shown.box.w}px`;
    el.style.height = `${shown.box.h}px`;
    el.style.top = `${shown.place.top}px`;
    el.style.right = `${shown.place.right}px`;
  }

  function markDockBusy(on: boolean) {
    dockRef.current?.classList.toggle("is-busy", on);
  }

  function readCanvasInset() {
    const canvas = canvasShellRef.current;
    const dock = dockRef.current;
    if (!canvas || !dock) return null;
    const cr = canvas.getBoundingClientRect();
    const dr = dock.getBoundingClientRect();
    return dockCanvasInset(
      { left: cr.left, top: cr.top, width: cr.width, height: cr.height },
      { left: dr.left, top: dr.top, width: dr.width, height: dr.height },
    );
  }

  function paintCanvasInset() {
    const next = readCanvasInset();
    const view = viewRef.current;
    if (!next || !view) return next;
    view.style.marginLeft = `${next.left}px`;
    view.style.marginRight = `${next.right}px`;
    return next;
  }

  function syncCanvasInset() {
    paintCanvasInset();
  }

  function toggleDock() {
    const next = !dockOpenRef.current;
    dockOpenRef.current = next;
    setDockOpen(next);
    writeDockOpen(browserStore(), next);
  }

  function onDockResizeMove(e: React.PointerEvent) {
    const start = dockResize.current;
    if (!start) return;
    const next = resizeDockHandle(
      start.box,
      start.place,
      { dx: e.clientX - start.x, dy: e.clientY - start.y },
      pageRoom(),
      start.corner,
    );
    paintDock(next);
    paintCanvasInset();
  }

  function onDockMove(e: React.PointerEvent) {
    const start = dockDrag.current;
    if (!start) return;
    const next = clampDockPlace(
      {
        top: start.place.top + (e.clientY - start.y),
        right: start.place.right - (e.clientX - start.x),
      },
      pageRoom(),
      dockBox,
    );
    paintDock({ box: dockBox, place: next });
    paintCanvasInset();
  }

  function endDockMove() {
    const start = dockDrag.current;
    dockDrag.current = null;
    markDockBusy(false);
    if (!start) return;
    const el = dockRef.current;
    if (!el) return;
    const room = pageRoom();
    commitDock(dockBox, {
      top: el.offsetTop,
      right: Math.max(8, room.w - el.offsetLeft - dockBox.w),
    });
  }

  function endDockResize() {
    const start = dockResize.current;
    dockResize.current = null;
    markDockBusy(false);
    if (!start) return;
    const el = dockRef.current;
    if (el) {
      commitDock(
        { w: el.offsetWidth, h: el.offsetHeight },
        {
          top: el.offsetTop,
          right: Math.max(8, pageRoom().w - el.offsetLeft - el.offsetWidth),
        },
      );
    } else commitDock(start.box, start.place);
  }

  useLayoutEffect(() => {
    const room = pageRoom();
    const box = clampDockBox(readDockBox(browserStore()), room);
    const side = document.querySelector(".sidebar");
    const dockLeft =
      side instanceof HTMLElement ? Math.round(side.getBoundingClientRect().left) : 20;
    const place = sidebarDockPlace(room, box, dockLeft);
    dockOpenRef.current = true;
    setDockOpen(true);
    writeDockOpen(browserStore(), true);
    setDockBox(box);
    setDockPlace(place);
    writeDockPlace(browserStore(), place);
  }, []);

  useLayoutEffect(() => {
    syncCanvasInset();
  }, [dockOpen, dockBox, dockPlace, waiting, canvasReady]);

  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    function onEnd(e: TransitionEvent) {
      if (e.target !== el) return;
      if (e.propertyName === "width" || e.propertyName === "height" || e.propertyName === "top") {
        syncCanvasInset();
      }
    }
    el.addEventListener("transitionend", onEnd);
    return () => el.removeEventListener("transitionend", onEnd);
  }, [canvasReady]);

  useEffect(() => {
    function fit() {
      const room = pageRoom();
      setDockBox((cur) => {
        const nextBox = clampDockBox(cur, room);
        setDockPlace((p) => clampDockPlace(p, room, nextBox));
        return nextBox;
      });
    }
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  function dockHandle(corner: DockHandle) {
    return (
      <button
        type="button"
        className={`notes-resize notes-resize-${corner}`}
        aria-label="缩放核对窗"
        onPointerDown={(e) => {
          if (e.button !== 0 || !dockOpenRef.current) return;
          e.preventDefault();
          e.stopPropagation();
          markDockBusy(true);
          dockResize.current = { x: e.clientX, y: e.clientY, box: dockBox, place: dockPlace, corner };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={onDockResizeMove}
        onPointerUp={endDockResize}
        onPointerCancel={endDockResize}
        onLostPointerCapture={endDockResize}
      />
    );
  }

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

  useEffect(() => {
    if (!taskId || !waiting) return;
    const id = window.setInterval(() => {
      void api
        .task(taskId)
        .then((next) => {
          setTask(next);
          if (shouldShowWaitCard(next)) return;
          const seed: Record<string, string> = {};
          for (const h of [...(next.hits || []), ...(next.hits_v2 || [])]) {
            if (h.id && h.note) seed[h.id] = h.note;
          }
          if (Object.keys(seed).length) setNotes((prev) => ({ ...seed, ...prev }));
          if (next.conclusion) setConclusion((cur) => cur || next.conclusion || "");
          if (next.job_kind !== "rework" || next.job_status === "failed") return;
          if (
            (Array.isArray(next.hits_v2) && next.hits_v2.length > 0) ||
            (Array.isArray(next.pages_v2) && next.pages_v2.length > 0)
          ) {
            setUseV2(true);
          }
          message.success("已对照第二份 PDF。请核对上一轮有错的字段。");
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) {
            setError("这单已经不在了");
            setTask(null);
          }
        });
    }, 2500);
    return () => window.clearInterval(id);
  }, [taskId, waiting]);

  const hits = ((useV2 ? task?.hits_v2 : task?.hits) || []).filter((h) => !skipPackSheetField(h.field));
  const pages = pageList(useV2 ? { ...(task as TaskDetail), pages: task?.pages_v2 } : task);
  const page = pages[pageIdx];
  const signed = task?.status === "completed";
  const reviewable = isReviewable(task?.status);
  const reworkable = isReworkable(task);
  const current = hits[active];

  const pageNo = Number(page?.page || pageIdx + 1);
  const metrics = resolvePageMetrics(page, nat);
  const pinHits = useMemo(() => {
    return hits.map((h, i) => ({ h, i })).filter(({ h }) => hitOnPage(h, pageNo));
  }, [hits, pageNo]);
  const currentBox = current ? pickHitBox(current.bboxes, Number(current.page) || pageNo) : null;

  useEffect(() => {
    setNat(null);
    commitZoom(resetZoom());
  }, [page?.url]);

  useEffect(() => {
    const i = pendingFit.current;
    if (i == null || !metrics) return;
    const id = window.requestAnimationFrame(() => {
      pendingFit.current = null;
      fitHitRef.current(i);
    });
    return () => window.cancelAnimationFrame(id);
  }, [metrics, pageIdx, page?.url]);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const ox = e.clientX - rect.left;
      const oy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomRef.current = zoomAt(zoomRef.current, zoomRef.current.scale * factor, ox, oy);
      if (panRaf.current == null) {
        panRaf.current = window.requestAnimationFrame(() => {
          panRaf.current = null;
          paintZoom(zoomRef.current);
        });
      }
      if (wheelEnd.current != null) window.clearTimeout(wheelEnd.current);
      wheelEnd.current = window.setTimeout(() => {
        wheelEnd.current = null;
        setZoom(zoomRef.current);
      }, 80);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelEnd.current != null) window.clearTimeout(wheelEnd.current);
    };
  }, [page?.url, waiting]);

  if (!taskId) {
    return (
      <Empty description="还没有打开审核单">
        <Button onClick={onBack}>回到任务</Button>
      </Empty>
    );
  }

  async function decide(hit: FieldHit, decision: Decision) {
    if (!task || !hit.id || !reviewable) return;
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
    if (!task || !reworkable) return;
    const fd = new FormData();
    fd.append("pdf", file);
    setBusy(true);
    try {
      const next = await api.rework(task.id, fd);
      setTask(next);
      if (shouldShowWaitCard(next)) return;
      setUseV2(true);
      message.success("已对照第二份 PDF。请核对上一轮有错的字段。");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "对红失败");
    } finally {
      setBusy(false);
    }
  }

  async function signOff() {
    if (!task || !reviewable) return;
    setBusy(true);
    try {
      const next = await api.complete(task.id, { conclusion });
      setTask(next);
      message.success("已记录你的结论，不是系统过审");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "还不能签字");
    } finally {
      setBusy(false);
    }
  }

  function fitHit(i: number) {
    const h = hits[i];
    const el = viewRef.current;
    if (!h || !metrics || !el) return;
    const box = pickHitBox(h.bboxes, Number(h.page) || pageNo);
    if (!box) {
      commitZoom(resetZoom());
      return;
    }
    commitZoom(zoomToBox(box, metrics, { width: el.clientWidth, height: el.clientHeight }));
  }
  fitHitRef.current = fitHit;

  function pickHit(i: number) {
    setActive(i);
    const p = Number(hits[i]?.page || 0);
    const idx = pages.findIndex((pg) => Number(pg.page) === p);
    if (idx >= 0 && idx !== pageIdx) {
      pendingFit.current = i;
      setPageIdx(idx);
      return;
    }
    window.requestAnimationFrame(() => fitHitRef.current(i));
  }

  if (!task && !error) {
    return (
      <div className="desk-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="打开核对页…" />
      </div>
    );
  }
  if (waiting && task) {
    return (
      <WaitCard
        job={task.job_kind === "rework" ? "对红" : "对照"}
        jobStatus={task.job_status}
        queueAhead={task.queue_ahead}
        stage={task.job_stage}
        stageLabel={task.job_stage_label}
        etaS={task.job_eta_s}
      />
    );
  }

  return (
    <section className="review-page" ref={pageRef}>
      <header className="page-head">
        <div>
          <h1 className="page-title">{task?.product_name || task?.title || "核对页"}</h1>
          <p className="page-lead">{statusLead(task, pageIdx, pages)}</p>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回列表
          </button>
          {Array.isArray(task?.pages_v2) && task.pages_v2.length > 0 ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setUseV2((v) => !v);
                setPageIdx(0);
                setActive(0);
                commitZoom(resetZoom());
              }}
            >
              {useV2 ? "看这一版" : "看上一版"}
            </button>
          ) : (
            <button
              type="button"
              className="btn-ghost"
              disabled={!reworkable || busy}
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
              上传改稿 PDF
            </button>
          )}
          {pages.length > 1
            ? pages.map((p, i) => (
                <button
                  key={p.url || i}
                  type="button"
                  className={i === pageIdx ? "btn-primary" : "btn-ghost"}
                  onClick={() => setPageIdx(i)}
                >
                  第 {p.page || i + 1} 页
                </button>
              ))
            : null}
          {reviewable ? (
            <label className="review-conclusion">
              <Input
                aria-label="结论"
                placeholder="结论，签字要用"
                value={conclusion}
                disabled={busy}
                onChange={(e) => setConclusion(e.target.value)}
              />
            </label>
          ) : signed && conclusion ? (
            <span className="review-conclusion-done">{conclusion}</span>
          ) : null}
          <button
            type="button"
            className="btn-primary"
            disabled={!reviewable || busy || !conclusion.trim()}
            onClick={() => void signOff()}
          >
            {hits.some((h) => h.decision === "issue") ? "签字并待设计改稿" : "签字"}
          </button>
        </div>
      </header>

      {error ? <Alert type="error" title={error} style={{ marginBottom: 16 }} /> : null}
      {task?.error || task?.job_error ? (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} title={task.error || task.job_error} />
      ) : null}
      {task && reviewable && hits.length === 0 ? (
        <Alert type="info" showIcon style={{ marginBottom: 16 }} title="机审没标出疑点，仍要你过一遍" />
      ) : null}
      {signed ? (
        <Alert type="success" showIcon style={{ marginBottom: 16 }} title="已签字，不是系统过审" />
      ) : null}

      <div className="review-desk">
        <div className="canvas glass-pane" ref={canvasShellRef}>
          {page?.url ? (
            <div
              className="canvas-view"
              ref={viewRef}
              onDragStart={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                panDrag.current = { x: e.clientX, y: e.clientY };
                e.currentTarget.classList.add("is-panning");
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = panDrag.current;
                if (!d) return;
                e.preventDefault();
                const dx = e.clientX - d.x;
                const dy = e.clientY - d.y;
                d.x = e.clientX;
                d.y = e.clientY;
                const next = panBy(zoomRef.current, dx, dy);
                zoomRef.current = next;
                if (panRaf.current == null) {
                  panRaf.current = window.requestAnimationFrame(() => {
                    panRaf.current = null;
                    paintZoom(zoomRef.current);
                  });
                }
              }}
              onPointerUp={(e) => endPan(e.currentTarget)}
              onPointerCancel={(e) => endPan(e.currentTarget)}
              onLostPointerCapture={(e) => endPan(e.currentTarget)}
            >
              <div className="canvas-zoom" ref={zoomElRef} style={{ transform: zoomCss(zoom) }}>
                <img
                  src={page.url}
                  alt=""
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    if (img.naturalWidth > 1 && img.naturalHeight > 1) {
                      setNat({ width: img.naturalWidth, height: img.naturalHeight });
                    }
                  }}
                />
                {pinHits.map(({ h, i }) => {
                  const overlays = overlaysForHit(h.bboxes, pageNo, metrics);
                  const preferred = pickHitBox(h.bboxes, pageNo);
                  const pin = preferred && metrics ? overlayFromBox(preferred, metrics) : null;
                  return (
                    <Fragment key={h.id || i}>
                      {boxesOn
                        ? overlays.map((ov, k) => (
                            <span
                              key={`${h.id || i}-box-${k}`}
                              className={`hit-box ${ov.kind === "warn" ? "is-warn" : ""} ${i === active ? "is-on" : "is-dim"}`.trim()}
                              style={{ left: ov.left, top: ov.top, width: ov.width, height: ov.height }}
                            />
                          ))
                        : null}
                      {pinsOn && pin ? (
                        <button
                          type="button"
                          className={i === active ? "pin is-on" : "pin is-dim"}
                          style={{ left: pin.pinLeft, top: pin.pinTop }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => pickHit(i)}
                        >
                          {i + 1}
                        </button>
                      ) : null}
                    </Fragment>
                  );
                })}
              </div>
              <div className="canvas-tools" onPointerDown={(e) => e.stopPropagation()}>
                {toolsOpen ? (
                  <>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        const el = viewRef.current;
                        if (!el) return;
                        commitZoom(
                          zoomAt(zoomRef.current, zoomRef.current.scale * 1.2, el.clientWidth / 2, el.clientHeight / 2),
                        );
                      }}
                    >
                      放大
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        const el = viewRef.current;
                        if (!el) return;
                        commitZoom(
                          zoomAt(zoomRef.current, zoomRef.current.scale / 1.2, el.clientWidth / 2, el.clientHeight / 2),
                        );
                      }}
                    >
                      缩小
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => commitZoom(resetZoom())}>
                      复位
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        const next = !pinsOn;
                        setPinsOn(next);
                        writePinsOn(browserStore(), next);
                      }}
                    >
                      {pinsOn ? "隐藏钉" : "显示钉"}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => {
                        const next = !boxesOn;
                        setBoxesOn(next);
                        writeBoxesOn(browserStore(), next);
                      }}
                    >
                      {boxesOn ? "隐藏框" : "显示框"}
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => setToolsOpen(false)}>
                      收缩
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn-ghost" onClick={() => setToolsOpen(true)}>
                    标记
                  </button>
                )}
              </div>
            </div>
          ) : (
            <Empty
              description={
                task?.status === "compare_failed" || task?.job_status === "failed"
                  ? "对照中断，这一页没有图。看上面的原因，或回看板重传一对。"
                  : "这一页还没有图"
              }
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              style={{ padding: 48 }}
            />
          )}
          <p className="page-lead" style={{ padding: "0 16px 12px" }}>
            紫框 已命中 · 黄框 待核对 · 钉和框可分开关 · 拖动画布会暂时藏框 · 滚轮缩放
          </p>
        </div>

        </div>
        {typeof document !== "undefined"
          ? createPortal(
          <aside
            ref={dockRef}
            className={dockOpen ? "notes glass-pane is-float" : "notes glass-pane is-float is-shut"}
            style={(() => {
              const shown = dockVisual(dockOpen, dockBox, dockPlace, pageRoom());
              return {
                width: shown.box.w,
                height: shown.box.h,
                top: shown.place.top,
                right: shown.place.right,
              };
            })()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div
              className="notes-toolbar"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                if (e.target instanceof HTMLElement && e.target.closest("button")) return;
                e.preventDefault();
                markDockBusy(true);
                dockDrag.current = { x: e.clientX, y: e.clientY, place: dockPlace };
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }}
              onPointerMove={onDockMove}
              onPointerUp={endDockMove}
              onPointerCancel={endDockMove}
              onLostPointerCapture={endDockMove}
            >
              <p className="field-label" style={{ color: "var(--muted)", margin: 0 }}>
                当前字段
              </p>
              <button type="button" className="notes-toggle" onClick={toggleDock}>
                <span className="notes-toggle-mark" aria-hidden />
                {dockOpen ? "收起" : hits.length ? `展开 ${hits.length}` : "展开"}
              </button>
            </div>
            <div className="notes-body" aria-hidden={!dockOpen}>
            <div className="notes-grid">
              <div className="notes-field">
                {current ? (
                  <>
                    <div className="hit-now">
                      <strong style={{ fontSize: 18, display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <span className="hit-no">{active + 1}</span>
                        {current.field || "字段"}
                      </strong>
                      {statusTag(current.status)}
                    </div>
                    {doubtLines(current).length ? (
                      <div className="pair pair-doubt">
                        <p className="pair-k">疑点 / 错误点</p>
                        <ul className="doubt-list">
                          {doubtLines(current).map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <div className="pair">
                      <p className="pair-k">Excel 应印</p>
                      <p className="pair-v mono">{excelText(current)}</p>
                    </div>
                    <div className="pair">
                      <p className="pair-k">稿上 OCR</p>
                      <p className="pair-v mono">{pdfText(current, current.field)}</p>
                    </div>
                    <p className="pair-k">
                      {currentBox
                        ? `包装定位 · 页 ${current.page ?? "?"} · 点定位`
                        : "包装定位 · 这一条没有图上位置"}
                    </p>
                    {reviewable && current.id ? (
                      <Space wrap>
                        <Button size="small" onClick={() => void decide(current, "confirm")}>
                          一致
                        </Button>
                        <Button size="small" danger onClick={() => void decide(current, "issue")}>
                          有错
                        </Button>
                        <Button size="small" onClick={() => void decide(current, "ignore")}>
                          忽略
                        </Button>
                        <Button size="small" onClick={() => void copyList()}>
                          复制改稿清单
                        </Button>
                      </Space>
                    ) : (
                      <Button size="small" onClick={() => void copyList()}>
                        复制改稿清单
                      </Button>
                    )}
                    <Input
                      placeholder="给你自己看的话，会进改稿清单"
                      value={current.id ? notes[current.id] || "" : ""}
                      disabled={!reviewable || !current.id}
                      onChange={(e) => {
                        if (!current.id) return;
                        setNotes((prev) => ({ ...prev, [current.id as string]: e.target.value }));
                      }}
                    />
                  </>
                ) : (
                  <p className="page-lead">
                    {task?.status === "compare_failed" || task?.job_status === "failed"
                      ? "对照没跑完，没有机审条目。"
                      : "没有机审条目。仍请翻页看一遍。"}
                  </p>
                )}
              </div>
              <div className="notes-hits">
                <p className="field-label" style={{ margin: 0 }}>
                  疑点列表
                </p>
                <div className="hit-list">
                  {hits.map((h, i) => (
                    <button
                      key={h.id || i}
                      type="button"
                      className={i === active ? "hit-card is-on" : "hit-card"}
                      onClick={() => pickHit(i)}
                    >
                      <div className="hit-now">
                        <strong style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <span className="hit-no">{i + 1}</span>
                          {h.field || "字段"}
                        </strong>
                        {statusTag(h.status)}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {task?.rework_check && task.rework_check.length > 0 ? (
              <div className="notes-foot">
                <p className="field-label">对红</p>
                {task.rework_check.map((row) => (
                  <div key={row.field} className="hit-card">
                    <strong>{row.field}</strong>
                    <div>上一版：{row.v1_status}</div>
                    <div>这一版：{row.v2_status}</div>
                  </div>
                ))}
              </div>
            ) : null}
            </div>
            {dockHandle("n")}
            {dockHandle("s")}
            {dockHandle("e")}
            {dockHandle("w")}
            {dockHandle("nw")}
            {dockHandle("ne")}
            {dockHandle("sw")}
            {dockHandle("se")}
          </aside>,
              document.body,
            )
          : null}
    </section>
  );
}
