export type FullscreenDoc = {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
};

type FullscreenEl = HTMLElement & {
  requestFullscreen?: () => Promise<void>;
  webkitRequestFullscreen?: () => void;
};

function currentDoc(): FullscreenDoc | null {
  return typeof document === "undefined" ? null : document;
}

export function isElementFullscreen(el: HTMLElement | null, doc?: FullscreenDoc | null): boolean {
  if (!el) return false;
  const d = doc ?? currentDoc();
  if (!d) return false;
  return d.fullscreenElement === el || d.webkitFullscreenElement === el;
}

export async function enterElementFullscreen(el: HTMLElement): Promise<void> {
  const node = el as FullscreenEl;
  if (typeof node.requestFullscreen === "function") {
    await node.requestFullscreen();
    return;
  }
  if (typeof node.webkitRequestFullscreen === "function") {
    node.webkitRequestFullscreen();
    return;
  }
  throw new Error("fullscreen unsupported");
}

export async function exitElementFullscreen(doc?: FullscreenDoc | null): Promise<void> {
  const d = doc ?? currentDoc();
  if (!d) return;
  if (d.fullscreenElement && typeof d.exitFullscreen === "function") {
    await d.exitFullscreen();
    return;
  }
  d.webkitExitFullscreen?.();
}

type PingWin = {
  dispatchEvent: (event: Event) => boolean;
  requestAnimationFrame?: (cb: FrameRequestCallback) => number;
};

/** Wait for fullscreen layout, then reframe once. UA styles can leave the viewer at the old 3:4 size. */
export function pingViewerAfterFullscreen(
  root: { querySelector: (sel: string) => unknown },
  win?: PingWin | null,
): void {
  const target = win ?? (typeof window === "undefined" ? null : window);
  const mv = root.querySelector("model-viewer") as { updateFraming?: () => void } | null;
  function run() {
    if (typeof mv?.updateFraming === "function") {
      mv.updateFraming();
      return;
    }
    target?.dispatchEvent(new Event("resize"));
  }
  const raf = target?.requestAnimationFrame;
  if (typeof raf === "function") {
    raf.call(target, () => {
      raf.call(target, run);
    });
    return;
  }
  run();
}
