/** Viewer-only perspective framing. The original box bounds exclude display scenery. */
export const DEFAULT_GLB_VIEW = { theta: 35, phi: 72, zoom: 1.45 } as const;

export function glbCameraDistances(sphereRadius: number, fovDegrees: number, zoom: number) {
  if (!Number.isFinite(sphereRadius) || sphereRadius <= 0 || !Number.isFinite(fovDegrees)
    || fovDegrees <= 0 || fovDegrees >= 180 || !Number.isFinite(zoom) || zoom <= 0) {
    throw new Error("glb_camera_invalid");
  }
  const base = sphereRadius / Math.sin(fovDegrees * Math.PI / 360);
  const min = sphereRadius * 2.2;
  const max = Math.max(min, Math.min(base * 1.55, sphereRadius * 10));
  return { base, min, max, radius: Math.max(min, Math.min(max, base * zoom)) };
}
