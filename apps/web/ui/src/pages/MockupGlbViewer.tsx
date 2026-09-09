import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelViewerElement } from "@google/model-viewer";
import { composeGlbDisplaySet, DISPLAY_TABLE_MATERIAL, DISPLAY_WALL_MATERIAL } from "./glbDisplayAsset";
import { DEFAULT_GLB_VIEW, glbCameraDistances } from "./mockupGlbCamera";
import { GLB_ENVIRONMENT, glbViewerExposure, glbRoomEmission } from "./mockupGlbLighting";
import { type BackdropPreset, studioBackdrop } from "./mockupStudio";

type Bounds = { center: number[]; sphereRadius: number };
type View = { theta: number; phi: number; zoom: number };
const initialView = (): View => ({ ...DEFAULT_GLB_VIEW });
const degrees = (radians: number) => radians * 180 / Math.PI;

/** The display scene is disposable; the caller keeps downloads bound to the original generation. */
export function MockupGlbViewer({ source, backdrop, backgroundLight, productLight, onSourceError }: {
  source: string; backdrop: BackdropPreset; backgroundLight: number; productLight: number;
  onSourceError: () => void;
}) {
  const set = backdrop === "white_set";
  const identity = `${source}:${set ? "room" : "plain"}`;
  const [asset, setAsset] = useState<{ identity: string; url: string; bounds?: Bounds } | null>(null);
  const [error, setError] = useState(false);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const viewerRef = useRef<ModelViewerElement | null>(null);
  const view = useRef<View>(initialView());
  const lastSource = useRef(source);
  const raw = useRef<{ source: string; bytes: Uint8Array } | null>(null);
  const revision = useRef(0);
  const onErrorRef = useRef(onSourceError);
  onErrorRef.current = onSourceError;
  const current = asset?.identity === identity ? asset : null;
  const ready = Boolean(current && readyUrl === current.url);
  const framedBase = useRef<number | null>(null);
  const setViewer = useCallback((node: HTMLElement | null) => {
    const previous = viewerRef.current;
    if (!node && previous?.loaded && framedBase.current) {
      const orbit = previous.getCameraOrbit();
      view.current = { theta: degrees(orbit.theta), phi: degrees(orbit.phi), zoom: orbit.radius / framedBase.current };
    }
    viewerRef.current = node as ModelViewerElement | null;
    if (!node) framedBase.current = null;
  }, []);
  const ownedUrl = useRef<string | null>(null);
  const releaseDisplay = useCallback(() => {
    if (ownedUrl.current) URL.revokeObjectURL(ownedUrl.current);
    ownedUrl.current = null;
  }, []);
  const failDisplay = useCallback(() => {
    revision.current++;
    releaseDisplay();
    raw.current = null;
    setAsset(null);
    setReadyUrl(null);
    setError(true);
  }, [releaseDisplay]);


  useEffect(() => {
    if (lastSource.current !== source) {
      lastSource.current = source;
      raw.current = null;
      view.current = initialView();
    }
    let active = true;
    let blob: string | undefined;
    const abort = new AbortController();
    setReadyUrl(null);
    setError(false);
    if (!set) {
      setAsset({ identity, url: source });
    } else {
      void (async () => {
        let bytes = raw.current?.source === source ? raw.current.bytes : undefined;
        if (!bytes) {
          const response = await fetch(source, { signal: abort.signal });
          if (!response.ok) throw new Error("glb_source_failed");
          bytes = new Uint8Array(await response.arrayBuffer());
          if (!active) return;
          raw.current = { source, bytes };
        }
        const display = composeGlbDisplaySet(bytes);
        if (!active) return;
        blob = URL.createObjectURL(new Blob([new Uint8Array(display.bytes)], { type: "model/gltf-binary" }));
        ownedUrl.current = blob;
        setAsset({ identity, url: blob, bounds: display.bounds });
      })().catch(() => {
        if (!active) return;
        failDisplay();
        onErrorRef.current();
      });
    }
    return () => {
      active = false;
      abort.abort();
      revision.current++;
      if (blob && ownedUrl.current === blob) releaseDisplay();
    };
  }, [source, set, identity, failDisplay, releaseDisplay]);

  const lightRef = useRef({ backgroundLight, productLight });
  lightRef.current = { backgroundLight, productLight };
  const lightRoom = useCallback(() => {
    if (!set) return;
    for (const material of viewerRef.current?.model?.materials ?? []) {
      const rgb = material.name === DISPLAY_TABLE_MATERIAL ? [228,228,232]
        : material.name === DISPLAY_WALL_MATERIAL ? [238,238,236] : null;
      if (!rgb) continue;
      const { factor, strength } = glbRoomEmission(rgb, lightRef.current.backgroundLight, lightRef.current.productLight);
      material.setEmissiveFactor(factor);
      material.setEmissiveStrength(strength);
    }
  }, [set]);
  useEffect(lightRoom, [lightRoom, backgroundLight, productLight, current]);

  const frame = useCallback(async (reset = false) => {
    const viewer = viewerRef.current;
    if (!viewer?.loaded || !current) return;
    const token = ++revision.current;
    if (reset) view.current = initialView();
    try {
      await viewer.updateFraming();
      if (revision.current !== token || viewerRef.current !== viewer) return;
      const dimensions = viewer.getDimensions();
      const center = viewer.getBoundingBoxCenter();
      const bounds = current.bounds || {
        center: [center.x, center.y, center.z],
        sphereRadius: Math.hypot(dimensions.x, dimensions.y, dimensions.z) / 2,
      };
      const fov = viewer.getFieldOfView();
      const distances = glbCameraDistances(bounds.sphereRadius, fov, view.current.zoom);
      viewer.setAttribute("camera-target", bounds.center.map(v => `${v}m`).join(" "));
      viewer.setAttribute("min-camera-orbit", `auto auto ${distances.min}m`);
      viewer.setAttribute("max-camera-orbit", `auto ${set ? "89deg" : "auto"} ${distances.max}m`);
      viewer.setAttribute("camera-orbit", `${view.current.theta}deg ${view.current.phi}deg ${distances.radius}m`);
      // LitElement applies attributes asynchronously; wait before snapping to the goal.
      await viewer.updateComplete;
      if (revision.current !== token || viewerRef.current !== viewer) return;
      lightRoom();
      viewer.jumpCameraToGoal();
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (revision.current !== token || viewerRef.current !== viewer) return;
      framedBase.current = distances.base;
      setReadyUrl(current.url);
    } catch {
      if (revision.current === token) failDisplay();
    }
  }, [current, lightRoom, failDisplay, set]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !current) return;
    let active = true;
    const loaded = () => { if (active) void frame(); };
    const failed = () => {
      if (!active) return;
      failDisplay();
      onErrorRef.current();
    };
    const moved = (event: Event) => {
      if ((event as CustomEvent).detail?.source !== "user-interaction") return;
      const orbit = viewer.getCameraOrbit();
      const d = viewer.getDimensions();
      const sphere = current.bounds?.sphereRadius ?? Math.hypot(d.x, d.y, d.z) / 2;
      const base = sphere / Math.sin(viewer.getFieldOfView() * Math.PI / 360);
      view.current = { theta: degrees(orbit.theta), phi: degrees(orbit.phi), zoom: orbit.radius / base };
    };
    viewer.addEventListener("load", loaded);
    viewer.addEventListener("error", failed);
    viewer.addEventListener("camera-change", moved);
    const resize = new ResizeObserver(loaded);
    resize.observe(viewer);
    if (viewer.loaded) loaded();
    return () => {
      active = false;
      revision.current++;
      resize.disconnect();
      viewer.removeEventListener("load", loaded);
      viewer.removeEventListener("error", failed);
      viewer.removeEventListener("camera-change", moved);
    };
  }, [current, frame, failDisplay]);

  return <>
    {current && !error && <model-viewer
      key={current.url}
      ref={setViewer}
      src={current.url}
      camera-controls
      camera-orbit="35deg 72deg 145%"
      max-camera-orbit="auto auto 155%"
      environment-image={GLB_ENVIRONMENT}
      exposure={glbViewerExposure(productLight)}
      shadow-intensity="1"
      shadow-softness="0.5"
      tone-mapping="commerce"
      interaction-prompt="none"
      style={{ background: studioBackdrop(backgroundLight, backdrop), opacity: ready ? 1 : 0 }}
    />}
    {error && <p role="alert" className="mockup-glb-message">3D 预览加载失败，请重新打开此单。下载仍为原始模型。</p>}
    {!error && !ready && <p role="status" className="mockup-glb-message">正在加载 3D 预览…</p>}
    <button type="button" className="mockup-dl mockup-glb-reset" aria-label="复位模型视角"
      disabled={!ready || error} onClick={() => { void frame(true); }}>复位</button>
  </>;
}
