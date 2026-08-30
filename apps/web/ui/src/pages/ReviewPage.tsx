import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, App, Button, Empty, Input } from "antd";
import { ApiError, api, type Decision, type FieldHit, type TaskDetail, type TaskPage } from "../api";
import { WaitCard } from "../chrome/WaitCard";
import { forgetReviewHandoff, reviewHandoffFor } from "../jobHandoff";
import { fittedPage, panBy, resetZoom, zoomAt, zoomCss, zoomToBox } from "./canvasZoom";
import { overlayFromBox, overlaysForHit, pickHitBox, pinHitGroupsForPage, resolvePageMetrics } from "./pinBox";
import {
  enterElementFullscreen,
  exitElementFullscreen,
  fullscreenFailureMessage,
  isElementFullscreen,
} from "./mockupFullscreen";
import {
  clampDockBox,
  clampDockPlace,
  dockVisual,
  readBoxesOn,
  readDockBox,
  readStoredDockPlace,
  readPinsOn,
  REVIEW_DOCK_LAYER,
  resizeDockHandle,
  sidebarDockPlace,
  skipPackSheetField,
  writeBoxesOn,
  writeDockBox,
  writeDockPlace,
  writePinsOn,
  type DockBox,
  type DockHandle,
  type DockPlace,
} from "./reviewDock";
import { detailLoadState, shouldShowWaitCard } from "./waitCard";
import { reviewHits, shouldUseReworkView } from "./reviewVersion";
import { ReviewDockPanel } from "./ReviewDockPanel";
import { buildRevisionList, partitionReviewHits, withLocalNotes } from "./reviewEvidence";
import {
  prepareReviewMedia,
  prepareReviewMediaAfterFailure,
  type PreparedReviewMedia,
} from "./reviewMedia";

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

function pageList(task: TaskDetail | null): TaskPage[] {
  const raw = task?.pages;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p) => p && (p.url || p.name));
}

function statusLead(task: TaskDetail | null, pageIdx: number, pages: TaskPage[]) {
  const pageNo = pages[pageIdx]?.page || pageIdx + 1;
  if (!task) return "核对页";
  if (task.status === "completed") return `核对页 · 第 ${pageNo} 页 · 已签字`;
  if (isReviewable(task.status)) return `核对页 · 点字段，图上定位。第 ${pageNo} 页 · 待审核`;
  if (task.status === "compare_failed") return `核对页 · 第 ${pageNo} 页 · 对照中断`;
  return `核对页 · 第 ${pageNo} 页`;
}

export function ReviewPage({ taskId, onBack }: Props) {
  const { message } = App.useApp();
  const [task, setTask] = useState<TaskDetail | null>(() => reviewHandoffFor(taskId));
  const [error, setError] = useState<string | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [active, setActive] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [conclusion, setConclusion] = useState("");
  const [busy, setBusy] = useState(false);
  const [useV2, setUseV2] = useState(false);
  const [nat, setNat] = useState<{ width: number; height: number } | null>(null);
  const [reviewMedia, setReviewMedia] = useState<PreparedReviewMedia | null>(null);
  const [reviewMediaError, setReviewMediaError] = useState<string | null>(null);
  const [viewSize, setViewSize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(resetZoom);
  const [dockOpen, setDockOpen] = useState(true);
  const [pinsOn, setPinsOn] = useState(() => readPinsOn(browserStore()));
  const [boxesOn, setBoxesOn] = useState(() => readBoxesOn(browserStore()));
  const [toolsOpen, setToolsOpen] = useState(true);
  const [reviewFullscreen, setReviewFullscreen] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const zoomElRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const zoomRef = useRef(zoom);
  const laidRef = useRef({ imgW: 0, imgH: 0, offsetX: 0, offsetY: 0 });
  const dockOpenRef = useRef(true);
  const dockPlaceModeRef = useRef<"default" | "user">(
    readStoredDockPlace(browserStore()) ? "user" : "default",
  );
  const [dockFrame, setDockFrame] = useState<{ box: DockBox; place: DockPlace }>(() => {
    const box = readDockBox(browserStore());
    const room = typeof window === "undefined"
      ? { w: 1200, h: 800 }
      : { w: window.innerWidth, h: window.innerHeight };
    return { box, place: sidebarDockPlace(room, box) };
  });
  const { box: dockBox, place: dockPlace } = dockFrame;
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
  const busyDepthRef = useRef(0);
  const decisionQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const seededTaskId = useRef(taskId);
  const reviewMediaLoad = useRef<AbortController | null>(null);
  const waiting = shouldShowWaitCard(task);
  const loadState = detailLoadState(task, error);

  function beginBusy() {
    busyDepthRef.current += 1;
    setBusy(true);
  }

  function endBusy() {
    busyDepthRef.current = Math.max(0, busyDepthRef.current - 1);
    if (busyDepthRef.current === 0) setBusy(false);
  }

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

  function defaultDockPlace(room: { w: number; h: number }, box: DockBox) {
    const side = document.querySelector(".sidebar");
    const dockLeft = side instanceof HTMLElement ? Math.round(side.getBoundingClientRect().left) : 20;
    return sidebarDockPlace(room, box, dockLeft);
  }

  useEffect(() => {
    if (typeof document === "undefined") return;
    function onFullscreenChange() {
      setReviewFullscreen(isElementFullscreen(pageRef.current));
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    };
  }, []);

  function commitDock(box: DockBox, place?: DockPlace, open = dockOpenRef.current) {
    const room = pageRoom();
    const nextBox = clampDockBox(box, room);
    const nextPlace = dockVisual(open, nextBox, place || dockPlace, room).place;
    dockPlaceModeRef.current = "user";
    setDockFrame({ box: nextBox, place: nextPlace });
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
    el.style.left = `${shown.place.left}px`;
    el.style.right = "auto";
  }

  function markDockBusy(on: boolean) {
    dockRef.current?.classList.toggle("is-busy", on);
  }

  function toggleDock() {
    const next = !dockOpenRef.current;
    const nextPlace = dockVisual(next, dockBox, dockPlace, pageRoom()).place;
    dockOpenRef.current = next;
    setDockOpen(next);
    setDockFrame({ box: dockBox, place: nextPlace });
    writeDockPlace(browserStore(), nextPlace);
  }

  function onDockResizeMove(e: React.PointerEvent) {
    const start = dockResize.current;
    if (!start) return;
    const room = pageRoom();
    const resized = resizeDockHandle(
      start.box,
      start.place,
      { dx: e.clientX - start.x, dy: e.clientY - start.y },
      room,
      start.corner,
    );
    const next = {
      box: resized.box,
      place: clampDockPlace(resized.place, room, resized.box),
    };
    paintDock(next);
  }

  function onDockMove(e: React.PointerEvent) {
    const start = dockDrag.current;
    if (!start) return;
    const room = pageRoom();
    const shown = dockVisual(dockOpenRef.current, dockBox, start.place, room);
    const next = clampDockPlace(
      {
        top: start.place.top + (e.clientY - start.y),
        left: start.place.left + (e.clientX - start.x),
      },
      room,
      shown.box,
    );
    paintDock({ box: dockBox, place: next });
  }

  function endDockMove() {
    const start = dockDrag.current;
    dockDrag.current = null;
    markDockBusy(false);
    if (!start) return;
    const el = dockRef.current;
    if (!el) return;
    commitDock(dockBox, {
      top: el.offsetTop,
      left: el.offsetLeft,
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
          left: el.offsetLeft,
        },
      );
    } else commitDock(start.box, start.place);
  }

  useLayoutEffect(() => {
    const room = pageRoom();
    const box = clampDockBox(readDockBox(browserStore()), room);
    const storedPlace = readStoredDockPlace(browserStore());
    dockPlaceModeRef.current = storedPlace ? "user" : "default";
    const place = storedPlace
      ? clampDockPlace(storedPlace, room, box)
      : defaultDockPlace(room, box);
    dockOpenRef.current = true;
    setDockOpen(true);
    setDockFrame({ box, place });
  }, []);

  useEffect(() => {
    function fit() {
      const room = pageRoom();
      setDockFrame((current) => {
        const box = clampDockBox(current.box, room);
        const place = dockPlaceModeRef.current === "default"
          ? defaultDockPlace(room, box)
          : dockVisual(dockOpenRef.current, box, current.place, room).place;
        return { box, place };
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
    if (seededTaskId.current !== taskId) {
      seededTaskId.current = taskId;
      setTask(reviewHandoffFor(taskId));
    }
    setError(null);
    void api
      .task(taskId)
      .then((t) => {
        if (cancelled) return;
        setError(null);
        forgetReviewHandoff(taskId);
        setTask(t);
        setUseV2(shouldUseReworkView(t));
        const seed: Record<string, string> = {};
        for (const h of [...(t.hits || []), ...(t.hits_v2 || [])]) {
          if (h.id && h.note) seed[h.id] = h.note;
        }
        setNotes(seed);
        if (t.conclusion) setConclusion(t.conclusion);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          forgetReviewHandoff(taskId);
          setTask(null);
        }
        setError(err instanceof Error ? err.message : "加载失败");
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
          setError(null);
          setTask(next);
          if (shouldShowWaitCard(next)) return;
          const seed: Record<string, string> = {};
          for (const h of [...(next.hits || []), ...(next.hits_v2 || [])]) {
            if (h.id && h.note) seed[h.id] = h.note;
          }
          if (Object.keys(seed).length) setNotes((prev) => ({ ...seed, ...prev }));
          if (next.conclusion) setConclusion((cur) => cur || next.conclusion || "");
          if (next.job_kind !== "rework" || next.job_status === "failed") return;
          if (shouldUseReworkView(next)) setUseV2(true);
          message.success("已对照第二份 PDF。请核对上一轮有错的字段。");
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) {
            forgetReviewHandoff(taskId);
            setError("这单已经不在了");
            setTask(null);
          }
        });
    }, 2500);
    return () => window.clearInterval(id);
  }, [taskId, waiting]);

  const hits = reviewHits(task, useV2).filter((h) => !skipPackSheetField(h.field));
  const pages = pageList(useV2 ? { ...(task as TaskDetail), pages: task?.pages_v2 } : task);
  const page = pages[pageIdx];
  const signed = task?.status === "completed";
  const reviewable = isReviewable(task?.status);
  const reworkable = isReworkable(task);
  const current = hits[active];
  const firstIssueIndex = partitionReviewHits(hits).issues[0]?.index ?? 0;

  useEffect(() => {
    setActive(firstIssueIndex);
  }, [task?.id, useV2, hits.length, firstIssueIndex]);

  const pageNo = Number(page?.page || pageIdx + 1);
  const metrics = resolvePageMetrics(page, nat);
  const laid = metrics && viewSize ? fittedPage(metrics, viewSize) : { imgW: 0, imgH: 0, offsetX: 0, offsetY: 0 };
  laidRef.current = laid;
  const pinHits = useMemo(() => {
    return pinHitGroupsForPage(hits, pageNo);
  }, [hits, pageNo]);
  const currentBox = current ? pickHitBox(current.bboxes, Number(current.page) || pageNo) : null;

  useEffect(() => {
    let cancelled = false;
    reviewMediaLoad.current?.abort();
    const controller = new AbortController();
    reviewMediaLoad.current = controller;
    setReviewMedia(null);
    setReviewMediaError(null);
    setNat(
      Number(page?.width) > 1 && Number(page?.height) > 1
        ? { width: Number(page?.width), height: Number(page?.height) }
        : null,
    );
    commitZoom(resetZoom());
    if (page) {
      void prepareReviewMedia(page, { signal: controller.signal })
        .then((media) => {
          if (cancelled || controller.signal.aborted) return;
          setReviewMedia(media);
          setNat({ width: media.width, height: media.height });
        })
        .catch((err: unknown) => {
          if (!cancelled && !controller.signal.aborted) {
            setReviewMediaError(err instanceof Error ? err.message : "高清核对图加载失败");
          }
        });
    }
    return () => {
      cancelled = true;
      controller.abort();
      reviewMediaLoad.current?.abort();
      reviewMediaLoad.current = null;
    };
  }, [page?.url, page?.raster_url, page?.width, page?.height]);

  function recoverDisplayedReviewMedia(failedMedia: PreparedReviewMedia) {
    if (!page) return;
    if (failedMedia.source === "raster") {
      setReviewMedia(null);
      setReviewMediaError("高清核对图显示失败，请刷新后重试");
      return;
    }
    reviewMediaLoad.current?.abort();
    const controller = new AbortController();
    reviewMediaLoad.current = controller;
    setReviewMedia(null);
    setReviewMediaError(null);
    void prepareReviewMediaAfterFailure(page, failedMedia.url, { signal: controller.signal })
      .then((media) => {
        if (controller.signal.aborted) return;
        setReviewMedia(media);
        setNat({ width: media.width, height: media.height });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setReviewMediaError(err instanceof Error ? err.message : "高清核对图显示失败，请刷新后重试");
        }
      });
  }

  useEffect(() => {
    const i = pendingFit.current;
    if (i == null || !metrics) return;
    const id = window.requestAnimationFrame(() => {
      pendingFit.current = null;
      fitHitRef.current(i);
    });
    return () => window.cancelAnimationFrame(id);
  }, [metrics, pageIdx, page?.url]);

  useLayoutEffect(() => {
    const node = viewRef.current;
    if (!node) return;
    const read = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      setViewSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(node);
    return () => ro.disconnect();
  }, [page?.url, waiting]);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const parked = laidRef.current;
      const ox = e.clientX - rect.left - parked.offsetX;
      const oy = e.clientY - rect.top - parked.offsetY;
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

  function decide(hit: FieldHit, decision: Decision, note = ""): Promise<boolean> {
    const targetTaskId = task?.id;
    if (!targetTaskId || !hit.id || !reviewable) return Promise.resolve(false);
    const hitId = hit.id;
    const operation = decisionQueueRef.current.then(async () => {
      beginBusy();
      try {
        const next = await api.decide(targetTaskId, {
          hit_id: hitId,
          decision,
          note,
        });
        setTask((currentTask) => (currentTask?.id === targetTaskId ? next : currentTask));
        return true;
      } catch (err) {
        message.error(err instanceof Error ? err.message : "记录失败");
        return false;
      } finally {
        endBusy();
      }
    });
    decisionQueueRef.current = operation;
    return operation;
  }

  async function copyList() {
    if (!task) return;
    const { text, count } = buildRevisionList(
      task.product_name || task.title,
      withLocalNotes(hits, notes),
    );
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制 ${count} 条给设计`);
    } catch {
      message.error("复制失败，请手动选中文字");
    }
  }

  async function uploadRework(file: File) {
    if (!task || !reworkable) return;
    if (!(await decisionQueueRef.current)) {
      message.error("字段结论或备注还没保存，暂不能对红");
      return;
    }
    const fd = new FormData();
    fd.append("pdf", file);
    beginBusy();
    try {
      const next = await api.rework(task.id, fd);
      setTask(next);
      if (shouldShowWaitCard(next)) return;
      setUseV2(true);
      message.success("已对照第二份 PDF。请核对上一轮有错的字段。");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "对红失败");
    } finally {
      endBusy();
    }
  }

  async function signOff() {
    if (!task || !reviewable) return;
    if (!(await decisionQueueRef.current)) {
      message.error("字段结论或备注还没保存，暂不能签字");
      return;
    }
    beginBusy();
    try {
      const next = await api.complete(task.id, { conclusion });
      setTask(next);
      message.success("已记录你的结论，不是系统过审");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "还不能签字");
    } finally {
      endBusy();
    }
  }

  async function toggleReviewFullscreen() {
    const root = pageRef.current;
    if (!root) return;
    try {
      if (isElementFullscreen(root)) await exitElementFullscreen();
      else await enterElementFullscreen(root);
    } catch (cause) {
      message.error(fullscreenFailureMessage(cause));
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

  if (loadState === "error") {
    return (
      <section className="review-page">
        <header className="page-head">
          <h1 className="page-title">审核单</h1>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回列表
          </button>
        </header>
        <Alert type="error" showIcon title={error || "审核单加载失败"} />
      </section>
    );
  }
  if (loadState === "loading") {
    return (
      <div className="desk-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="打开核对页…" />
      </div>
    );
  }
  if (loadState === "waiting" && task) {
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

  const dockPortalTarget =
    typeof document === "undefined"
      ? null
      : reviewFullscreen && pageRef.current
        ? pageRef.current
        : document.body;

  return (
    <section
      className={reviewFullscreen ? "review-page is-fullscreen" : "review-page"}
      data-testid="review-root"
      ref={pageRef}
    >
      <header className="page-head">
        <div>
          <h1 className="page-title">{task?.product_name || task?.title || "核对页"}</h1>
          <p className="page-lead">{statusLead(task, pageIdx, pages)}</p>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回列表
          </button>
          <button
            type="button"
            className="btn-ghost review-fullscreen-toggle"
            aria-pressed={reviewFullscreen}
            onClick={() => void toggleReviewFullscreen()}
          >
            {reviewFullscreen ? "退出全屏" : "全屏核对"}
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
            <label className="review-conclusion review-sign-layer">
              <Input
                aria-label="结论"
                placeholder="结论，签字要用"
                value={conclusion}
                disabled={busy}
                onChange={(e) => setConclusion(e.target.value)}
              />
            </label>
          ) : signed && conclusion ? (
            <span className="review-conclusion-done review-sign-layer">{conclusion}</span>
          ) : null}
          <button
            type="button"
            className="btn-primary review-sign-layer"
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
        <div className="canvas glass-pane">
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
              <div
                className="canvas-zoom"
                ref={zoomElRef}
                style={{
                  transform: zoomCss(zoom),
                  width: laid.imgW > 1 ? laid.imgW : undefined,
                  height: laid.imgH > 1 ? laid.imgH : undefined,
                }}
              >
                {reviewMedia ? (
                  <img
                    src={reviewMedia.url}
                    alt=""
                    decoding="sync"
                    fetchPriority="high"
                    draggable={false}
                    onDragStart={(e) => e.preventDefault()}
                    onError={() => recoverDisplayedReviewMedia(reviewMedia)}
                  />
                ) : (
                  <div className={reviewMediaError ? "review-media-status is-error" : "review-media-status"}>
                    {reviewMediaError || "正在载入高清核对面…"}
                  </div>
                )}
                {(reviewMedia ? pinHits : []).map(({ h, i, indices }) => {
                  const overlays = overlaysForHit(h.bboxes, pageNo, metrics);
                  const preferred = pickHitBox(h.bboxes, pageNo);
                  const pin = preferred && metrics ? overlayFromBox(preferred, metrics) : null;
                  const pairActive = indices.includes(active);
                  return (
                    <Fragment key={h.id || i}>
                      {boxesOn
                        ? overlays.map((ov, k) => (
                            <span
                              key={`${h.id || i}-box-${k}`}
                              className={`hit-box ${ov.kind === "warn" ? "is-warn" : ""} ${pairActive ? "is-on" : "is-dim"}`.trim()}
                              style={{ left: ov.left, top: ov.top, width: ov.width, height: ov.height }}
                            />
                          ))
                        : null}
                      {pinsOn && pin ? (
                        <button
                          type="button"
                          className={pairActive ? "pin is-on" : "pin is-dim"}
                          style={{ left: pin.pinLeft, top: pin.pinTop }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => pickHit(pairActive ? active : i)}
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
                        const parked = laidRef.current;
                        commitZoom(
                          zoomAt(
                            zoomRef.current,
                            zoomRef.current.scale * 1.2,
                            el.clientWidth / 2 - parked.offsetX,
                            el.clientHeight / 2 - parked.offsetY,
                          ),
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
                        const parked = laidRef.current;
                        commitZoom(
                          zoomAt(
                            zoomRef.current,
                            zoomRef.current.scale / 1.2,
                            el.clientWidth / 2 - parked.offsetX,
                            el.clientHeight / 2 - parked.offsetY,
                          ),
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
        {dockPortalTarget
          ? createPortal(
          <aside
            ref={dockRef}
            data-testid="review-dock"
            className={dockOpen ? "notes glass-pane is-float" : "notes glass-pane is-float is-shut"}
            style={(() => {
              const shown = dockVisual(dockOpen, dockBox, dockPlace, pageRoom());
              return {
                width: shown.box.w,
                height: shown.box.h,
                top: shown.place.top,
                left: shown.place.left,
                zIndex: REVIEW_DOCK_LAYER,
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
              <ReviewDockPanel
                hits={hits}
                active={active}
                current={current}
                fullscreen={reviewFullscreen}
                currentHasBox={Boolean(currentBox)}
                reviewable={reviewable}
                busy={busy}
                note={current?.id ? notes[current.id] || "" : ""}
                emptyMessage={
                  task?.status === "compare_failed" || task?.job_status === "failed"
                    ? "对照没跑完，没有机审条目。"
                    : "没有机审条目。仍请翻页看一遍。"
                }
                reworkCheck={task?.rework_check}
                onPick={pickHit}
                onDecide={(hit, decision, note) => void decide(hit, decision, note)}
                onNoteCommit={(hit, decision, note) => void decide(hit, decision, note)}
                onCopy={() => void copyList()}
                onNoteChange={(value) => {
                  if (!current?.id) return;
                  setNotes((prev) => ({ ...prev, [current.id as string]: value }));
                }}
              />
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
              dockPortalTarget,
            )
          : null}
    </section>
  );
}
