/**
 * OpenSeadragon 双栏审稿 viewer
 * - 单图 / A·B 双图
 * - bbox 像素框 → overlay
 * - fitBounds 聚焦命中
 * - 可选同步 pan/zoom
 */
/* global OpenSeadragon */
const ViewerOSD = (() => {
  let viewerSingle = null;
  let viewerA = null;
  let viewerB = null;
  let syncEnabled = true;
  let syncing = false;
  let mode = "none"; // none | single | compare
  let imgSize = { a: { w: 1, h: 1 }, b: { w: 1, h: 1 }, s: { w: 1, h: 1 } };
  /** 当前已打开的 URL，避免同页重复 destroy/open */
  let openUrls = { s: "", a: "", b: "" };
  let syncWired = false;
  /** 邻页预加载 Image 缓存 */
  const preloadCache = new Map();

  const PREFIX_ID = "osd-ov-";

  function destroyViewer(v) {
    if (v && !v.isDestroyed?.()) {
      try {
        v.destroy();
      } catch (_) {}
    }
    return null;
  }

  function destroyAll() {
    viewerSingle = destroyViewer(viewerSingle);
    viewerA = destroyViewer(viewerA);
    viewerB = destroyViewer(viewerB);
    mode = "none";
    openUrls = { s: "", a: "", b: "" };
    syncWired = false;
  }

  function absUrl(url) {
    let src = url || "";
    if (src && !src.startsWith("http") && !src.startsWith("data:")) {
      if (!src.startsWith("/")) src = "/" + src;
      src = window.location.origin + src;
    }
    return src;
  }

  function baseOpts(element) {
    return {
      element,
      prefixUrl: "/static/osd/images/",
      // 缩略图导航（本地 navigator_*.png）
      showNavigator: true,
      navigatorPosition: "BOTTOM_RIGHT",
      navigatorHeight: 96,
      navigatorWidth: 120,
      navigatorAutoFade: true,
      showNavigationControl: true,
      showRotationControl: false,
      showSequenceControl: false,
      showFlipControl: false,
      // 同源 PNG 不要开 Anonymous
      crossOriginPolicy: false,
      ajaxWithCredentials: false,
      animationTime: 0.28,
      blendTime: 0.08,
      constrainDuringPan: true,
      maxZoomPixelRatio: 4,
      minZoomImageRatio: 0.15,
      visibilityRatio: 0.25,
      zoomPerScroll: 1.25,
      homeFillsViewer: true,
      // 性能：大图不全量金字塔
      imageLoaderLimit: 4,
      maxImageCacheCount: 80,
      timeout: 60000,
      gestureSettingsMouse: {
        clickToZoom: false,
        dblClickToZoom: true,
        flickEnabled: true,
      },
    };
  }

  function preload(urls) {
    (urls || []).forEach((u) => {
      if (!u) return;
      const src = absUrl(u).split("?")[0];
      if (preloadCache.has(src)) return;
      const img = new Image();
      img.decoding = "async";
      img.src = src;
      preloadCache.set(src, img);
      // 上限防内存
      if (preloadCache.size > 24) {
        const first = preloadCache.keys().next().value;
        preloadCache.delete(first);
      }
    });
  }

  function openImage(viewer, url, sideKey) {
    return new Promise((resolve, reject) => {
      let src = absUrl(url);
      // 稳定 cache key：同资源不反复 ?osd= 破坏浏览器缓存
      const stable = src.split("?")[0];
      if (sideKey && openUrls[sideKey] === stable && viewer && viewer.world?.getItemCount?.() > 0) {
        try {
          viewer.viewport.resize();
          viewer.forceRedraw();
        } catch (_) {}
        resolve(viewer);
        return;
      }

      const onOpen = () => {
        viewer.removeHandler("open", onOpen);
        viewer.removeHandler("open-failed", onFail);
        if (sideKey) openUrls[sideKey] = stable;
        try {
          viewer.viewport.resize();
          viewer.viewport.goHome(true);
          viewer.forceRedraw();
        } catch (_) {}
        resolve(viewer);
      };
      const onFail = (e) => {
        viewer.removeHandler("open", onOpen);
        viewer.removeHandler("open-failed", onFail);
        console.error("[OSD] open-failed", stable, e);
        reject(new Error("OSD open failed: " + stable));
      };
      viewer.addHandler("open", onOpen);
      viewer.addHandler("open-failed", onFail);
      viewer.open({
        type: "image",
        url: stable,
        buildPyramid: false,
      });
    });
  }

  function wireSync() {
    if (!viewerA || !viewerB || syncWired) return;
    const link = (src, dst) => {
      src.addHandler("animation", () => {
        if (!syncEnabled || syncing) return;
        syncing = true;
        try {
          dst.viewport.fitBounds(src.viewport.getBounds(), true);
        } catch (_) {}
        syncing = false;
      });
    };
    link(viewerA, viewerB);
    link(viewerB, viewerA);
    syncWired = true;
  }

  async function openSingle(url, naturalW, naturalH) {
    mode = "single";
    imgSize.s = { w: naturalW || 1, h: naturalH || 1 };
    const el = document.getElementById("osdSingle");
    if (!el) throw new Error("missing #osdSingle");
    ensureHostSize(el);
    const stable = absUrl(url).split("?")[0];
    // 同 URL 且 viewer 仍在 → 仅 resize，不闪黑
    if (
      viewerSingle &&
      !viewerSingle.isDestroyed?.() &&
      openUrls.s === stable &&
      viewerSingle.world?.getItemCount?.() > 0
    ) {
      try {
        viewerSingle.viewport.resize();
        viewerSingle.forceRedraw();
      } catch (_) {}
      updateZoomLabel();
      return viewerSingle;
    }
    viewerA = destroyViewer(viewerA);
    viewerB = destroyViewer(viewerB);
    openUrls.a = openUrls.b = "";
    if (!viewerSingle || viewerSingle.isDestroyed?.()) {
      el.innerHTML = "";
      viewerSingle = OpenSeadragon(baseOpts(el));
      viewerSingle.addHandler("animation", updateZoomLabel);
    }
    await openImage(viewerSingle, url, "s");
    requestAnimationFrame(() => {
      try {
        viewerSingle.viewport.resize();
        viewerSingle.viewport.goHome(true);
        viewerSingle.forceRedraw();
      } catch (_) {}
      updateZoomLabel();
    });
    return viewerSingle;
  }

  function ensureHostSize(el) {
    if (!el) return;
    // 清空残留内联高度，避免上一任务把容器撑到上万像素
    el.style.minHeight = "";
    el.style.height = "";
    const parent = el.parentElement;
    let h = el.clientHeight || el.offsetHeight;
    if (h < 80 && parent) {
      const ph = parent.clientHeight || parent.offsetHeight || 0;
      if (ph > 80) {
        el.style.height = ph + "px";
      } else {
        // 兜底：用视口高度的一部分，避免 0 高黑屏
        const fallback = Math.max(360, Math.floor(window.innerHeight * 0.55));
        el.style.height = fallback + "px";
      }
    }
  }

  async function openCompare(urlA, urlB, sizeA, sizeB) {
    mode = "compare";
    imgSize.a = sizeA || { w: 1, h: 1 };
    imgSize.b = sizeB || { w: 1, h: 1 };
    const elA = document.getElementById("osdA");
    const elB = document.getElementById("osdB");
    if (!elA || !elB) throw new Error("missing osdA/osdB");
    ensureHostSize(elA);
    ensureHostSize(elB);
    viewerSingle = destroyViewer(viewerSingle);
    openUrls.s = "";
    const sa = absUrl(urlA).split("?")[0];
    const sb = absUrl(urlB).split("?")[0];
    const reuse =
      viewerA &&
      viewerB &&
      !viewerA.isDestroyed?.() &&
      !viewerB.isDestroyed?.() &&
      openUrls.a === sa &&
      openUrls.b === sb;
    if (reuse) {
      try {
        viewerA.viewport.resize();
        viewerB.viewport.resize();
        viewerA.forceRedraw();
        viewerB.forceRedraw();
      } catch (_) {}
      updateZoomLabel();
      return { viewerA, viewerB };
    }
    if (!viewerA || viewerA.isDestroyed?.()) {
      elA.innerHTML = "";
      viewerA = OpenSeadragon(baseOpts(elA));
      viewerA.addHandler("animation", updateZoomLabel);
    }
    if (!viewerB || viewerB.isDestroyed?.()) {
      elB.innerHTML = "";
      viewerB = OpenSeadragon(baseOpts(elB));
    }
    await Promise.all([
      openImage(viewerA, urlA, "a"),
      openImage(viewerB, urlB, "b"),
    ]);
    requestAnimationFrame(() => {
      try {
        viewerA.viewport.resize();
        viewerB.viewport.resize();
        viewerA.viewport.goHome(true);
        viewerB.viewport.goHome(true);
        viewerA.forceRedraw();
        viewerB.forceRedraw();
      } catch (_) {}
      updateZoomLabel();
    });
    wireSync();
    return { viewerA, viewerB };
  }

  function clearOverlays(viewer) {
    if (!viewer) return;
    // remove all overlays we added
    const ov = viewer.currentOverlays ? [...viewer.currentOverlays] : [];
    ov.forEach((o) => {
      try {
        viewer.removeOverlay(o.element);
      } catch (_) {}
    });
  }

  function clearAllOverlays() {
    clearOverlays(viewerSingle);
    clearOverlays(viewerA);
    clearOverlays(viewerB);
  }

  function makeBoxEl(cls, title) {
    const el = document.createElement("div");
    el.className = "osd-bbox " + (cls || "");
    if (title) {
      const lab = document.createElement("span");
      lab.className = "osd-bbox-label";
      lab.textContent = title;
      el.appendChild(lab);
    }
    return el;
  }

  function pxRectToViewport(viewer, left, top, width, height) {
    const item = viewer.world.getItemAt(0);
    if (!item) return null;
    const rect = new OpenSeadragon.Rect(left, top, width, height);
    return item.imageToViewportRectangle(rect);
  }

  /**
   * boxes: [{left,top,width,height}] 像素坐标（相对该页 PNG）
   */
  function setOverlays(side, boxes, opts = {}) {
    const viewer =
      side === "a" ? viewerA : side === "b" ? viewerB : viewerSingle;
    if (!viewer) return;
    clearOverlays(viewer);
    const selected = !!opts.selected;
    const label = opts.label || "";
    const status = opts.status || "warn";
    const list = boxes || [];
    list.forEach((b, i) => {
      const w = b.width || 0;
      const h = b.height || 0;
      if (w < 1 && h < 1) return;
      const vp = pxRectToViewport(
        viewer,
        b.left || 0,
        b.top || 0,
        Math.max(2, w),
        Math.max(2, h)
      );
      if (!vp) return;
      // 每框可自带 status/role：check=核对点 warn · hit=已命中 ok · miss=缺失 red
      // 不在框上叠文字标签（「已命中/核对/字段名」会挡住原文小字）
      const st =
        b.status ||
        (b.role === "check" || b.role === "miss_anchor"
          ? "warn"
          : b.role === "hit"
            ? "ok"
            : status);
      const el = makeBoxEl(
        `osd-bbox--${st} ${selected ? "is-selected" : ""} ${
          b.role ? "osd-role-" + b.role : ""
        }`,
        "" // 故意不传 title，避免遮挡包装原文
      );
      el.id = `${PREFIX_ID}${side}-${i}-${Date.now()}`;
      viewer.addOverlay({
        element: el,
        location: vp,
      });
    });
  }

  function expandRect(vpRect, padRatio = 0.45) {
    const r = vpRect.clone();
    const px = r.width * padRatio;
    const py = r.height * padRatio;
    r.x -= px;
    r.y -= py;
    r.width += px * 2;
    r.height += py * 2;
    return r;
  }

  function unionPxBoxes(boxes) {
    if (!boxes || !boxes.length) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const b of boxes) {
      const x = b.left || 0;
      const y = b.top || 0;
      const w = Math.max(2, b.width || 0);
      const h = Math.max(2, b.height || 0);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
  }

  function focusBoxes(side, boxes, opts = {}) {
    const viewer =
      side === "a" ? viewerA : side === "b" ? viewerB : viewerSingle;
    if (!viewer || !boxes || !boxes.length) return;
    const u = unionPxBoxes(boxes);
    if (!u) return;
    const vp = pxRectToViewport(viewer, u.left, u.top, u.width, u.height);
    if (!vp) return;
    const padded = expandRect(vp, opts.padRatio != null ? opts.padRatio : 0.55);
    const immediately = !!opts.immediately;
    try {
      viewer.viewport.fitBounds(padded, immediately);
    } catch (_) {}
    updateZoomLabel();
  }

  /** 同时聚焦 A/B；有框的一侧 fit，另一侧若同步则跟着走 */
  function focusHit(boxesA, boxesB, opts = {}) {
    const prev = syncEnabled;
    // 聚焦时短暂关闭同步，避免互相打架
    syncEnabled = false;
    if (mode === "compare") {
      if (boxesA && boxesA.length) focusBoxes("a", boxesA, opts);
      if (boxesB && boxesB.length) focusBoxes("b", boxesB, opts);
      // 仅一侧有框：另一侧 goHome 或跟随
      if (boxesA?.length && !boxesB?.length && viewerB && prev) {
        try {
          viewerB.viewport.fitBounds(viewerA.viewport.getBounds(), false);
        } catch (_) {}
      }
      if (boxesB?.length && !boxesA?.length && viewerA && prev) {
        try {
          viewerA.viewport.fitBounds(viewerB.viewport.getBounds(), false);
        } catch (_) {}
      }
    } else if (mode === "single") {
      focusBoxes("s", boxesA || boxesB, opts);
    }
    setTimeout(() => {
      syncEnabled = prev;
    }, 400);
  }

  function fitHome() {
    const vs = [viewerSingle, viewerA, viewerB].filter(Boolean);
    vs.forEach((v) => {
      try {
        v.viewport.goHome(false);
      } catch (_) {}
    });
    updateZoomLabel();
  }

  function zoomBy(factor) {
    const v = viewerSingle || viewerA;
    if (!v) return;
    try {
      v.viewport.zoomBy(factor);
      v.viewport.applyConstraints();
    } catch (_) {}
    updateZoomLabel();
  }

  function updateZoomLabel() {
    const el = document.getElementById("zoomLabel");
    if (!el) return;
    const v = viewerSingle || viewerA;
    if (!v || !v.viewport) {
      el.textContent = "—";
      return;
    }
    try {
      const z = v.viewport.getZoom(true);
      const home = v.viewport.getHomeZoom();
      const pct = home > 0 ? Math.round((z / home) * 100) : Math.round(z * 100);
      el.textContent = `${pct}%`;
    } catch (_) {
      el.textContent = "—";
    }
  }

  function setSync(on) {
    syncEnabled = !!on;
  }

  function getSync() {
    return syncEnabled;
  }

  function getMode() {
    return mode;
  }

  function getViewerSingle() {
    return viewerSingle;
  }

  function cropFromViewer(viewer, boxes, pad = 40) {
    return new Promise((resolve) => {
      if (!viewer || !boxes?.length) {
        resolve(null);
        return;
      }
      const item = viewer.world.getItemAt(0);
      if (!item) {
        resolve(null);
        return;
      }
      const src = item.source;
      const url = src?.url || src?.getTileUrl?.(0, 0, 0);
      if (!url) {
        resolve(null);
        return;
      }
      const u = unionPxBoxes(boxes);
      const img = new Image();
      img.onload = () => {
        const minX = Math.max(0, u.left - pad);
        const minY = Math.max(0, u.top - pad);
        const maxX = Math.min(img.naturalWidth, u.left + u.width + pad);
        const maxY = Math.min(img.naturalHeight, u.top + u.height + pad);
        const w = Math.max(1, maxX - minX);
        const h = Math.max(1, maxY - minY);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, minX, minY, w, h, 0, 0, w, h);
        for (const b of boxes) {
          ctx.strokeStyle = "rgba(238,0,0,0.95)";
          ctx.lineWidth = 3;
          ctx.strokeRect(
            (b.left || 0) - minX,
            (b.top || 0) - minY,
            b.width || 0,
            b.height || 0
          );
        }
        resolve(c.toDataURL("image/png"));
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function cropFromSingle(boxes, pad = 40) {
    return cropFromViewer(viewerSingle, boxes, pad);
  }

  /** side: 's' | 'a' | 'b' */
  function cropFromSide(side, boxes, pad = 40) {
    const v =
      side === "b" ? viewerB : side === "a" ? viewerA : viewerSingle;
    return cropFromViewer(v || viewerSingle || viewerA || viewerB, boxes, pad);
  }

  function resize() {
    [viewerSingle, viewerA, viewerB].forEach((v) => {
      try {
        v?.viewport?.resize();
        v?.forceRedraw?.();
      } catch (_) {}
    });
  }

  return {
    destroyAll,
    openSingle,
    openCompare,
    clearAllOverlays,
    setOverlays,
    focusBoxes,
    focusHit,
    fitHome,
    zoomBy,
    setSync,
    getSync,
    getMode,
    getViewerSingle,
    cropFromSingle,
    cropFromSide,
    resize,
    updateZoomLabel,
    preload,
  };
})();

// const/let 不会挂到 window；app.js 用 window.ViewerOSD 判断，必须显式导出
window.ViewerOSD = ViewerOSD;
