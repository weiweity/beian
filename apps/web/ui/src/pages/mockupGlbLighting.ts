import { clampStudioLight } from "./mockupStudio.js";

// Original achromatic HDR: broad front/back softboxes and ambient fill.
// Calibrated on synthetic white/dark cartons around the full orbit; not a print proof.
export const GLB_ENVIRONMENT = new URL("../assets/carton-studio-v1.hdr", import.meta.url).href;

export function glbViewerExposure(light: number): string {
  return String(Math.round(0.7 * clampStudioLight(light) * 100) / 100);
}

/** Keep the room's pre-tone-map radiance independent of product exposure. */
export function glbRoomEmission(rgb: readonly number[], backgroundLight: number, productLight: number) {
  const light = clampStudioLight(backgroundLight);
  const exposure = Number(glbViewerExposure(productLight));
  const radiance = rgb.map(channel => {
    const s = Math.min(1, Math.max(0, channel / 255 * light));
    return (s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4) / exposure;
  });
  const strength = Math.max(1, ...radiance);
  return { factor: radiance.map(value => value / strength) as [number, number, number], strength };
}
