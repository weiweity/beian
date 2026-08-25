/** 打样单下载提示。不挡点击。 */

export const HUD_MS = 2200;

export function downloadHudLine(label: string): string {
  return `正在下载${label}`;
}

export function missingPptHud(): string {
  return "PPT 没写成，白底仍可下";
}
