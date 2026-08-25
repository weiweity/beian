export type ThemeChoice = "light" | "dark" | "system";
export type DiffMarkers = "color" | "underline" | "off";
export type GlassStyle = "solid" | "frost" | "liquid";

export type Appearance = {
  theme: ThemeChoice;
  fontPx: number;
  glassStyle: GlassStyle;
  glassContrast: number;
  diffMarkers: DiffMarkers;
};

export const APPEARANCE_KEY = "wb_appearance";

export function appearanceStorageKey(openId = ""): string {
  const id = (openId || "").trim();
  return id ? `${APPEARANCE_KEY}:${id}` : APPEARANCE_KEY;
}
export const FONT_PX_MIN = 13;
export const FONT_PX_MAX = 28;
export const FONT_PX_DEFAULT = 16;
export const GLASS_CONTRAST_DEFAULT = 55;
const GLASS_STYLES = new Set<GlassStyle>(["solid", "frost", "liquid"]);

export const APPEARANCE_DEFAULT: Appearance = {
  theme: "light",
  fontPx: FONT_PX_DEFAULT,
  glassStyle: "frost",
  glassContrast: GLASS_CONTRAST_DEFAULT,
  diffMarkers: "color",
};

export function isGlassOn(style: GlassStyle): boolean {
  return style !== "solid";
}

const THEMES = new Set<ThemeChoice>(["light", "dark", "system"]);
const DIFFS = new Set<DiffMarkers>(["color", "underline", "off"]);
const LEGACY_FONT: Record<string, number> = { sm: 14, md: 16, lg: 18, xl: 20 };

export function clampFontPx(n: number): number {
  if (!Number.isFinite(n)) return FONT_PX_DEFAULT;
  return Math.min(FONT_PX_MAX, Math.max(FONT_PX_MIN, Math.round(n)));
}

export function clampGlassContrast(n: number): number {
  if (!Number.isFinite(n)) return GLASS_CONTRAST_DEFAULT;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** 0 更透（看见紫雾），55 对准锁定稿 0.55 白，100 更实。 */
export function glassAlpha(contrast: number): number {
  const c = clampGlassContrast(contrast);
  if (c <= 55) return Math.round((0.22 + (c / 55) * 0.33) * 100) / 100;
  return Math.round((0.55 + ((c - 55) / 45) * 0.35) * 100) / 100;
}

export function typeScale(px: number) {
  const p = clampFontPx(px);
  return {
    ui: p,
    title: Math.round(p * 1.75),
    side: Math.max(15, Math.round(p * 1.06)),
    account: Math.max(14, Math.round(p * 0.94)),
    icon: Math.round(22 + (p - 16) * 0.5),
    avatar: Math.round(36 + (p - 16)),
  };
}

function readFontPx(o: Record<string, unknown>): number {
  if (typeof o.fontPx === "number") return clampFontPx(o.fontPx);
  if (typeof o.fontPx === "string" && o.fontPx.trim()) return clampFontPx(Number(o.fontPx));
  if (typeof o.fontScale === "string" && LEGACY_FONT[o.fontScale] != null) {
    return LEGACY_FONT[o.fontScale];
  }
  return FONT_PX_DEFAULT;
}

function readGlassContrast(o: Record<string, unknown>): number {
  if (typeof o.glassContrast === "number") return clampGlassContrast(o.glassContrast);
  if (o.contrast === "high") return 80;
  if (o.contrast === "standard") return GLASS_CONTRAST_DEFAULT;
  return GLASS_CONTRAST_DEFAULT;
}

/** 旧开关：false → 实心，true / 缺省 → 毛玻璃。合法 glassStyle 优先；非法字符串不掉进旧布尔。 */
function readGlassStyle(o: Record<string, unknown>): GlassStyle {
  if (GLASS_STYLES.has(o.glassStyle as GlassStyle)) return o.glassStyle as GlassStyle;
  if (typeof o.glassStyle === "string") return APPEARANCE_DEFAULT.glassStyle;
  if (typeof o.glassSidebar === "boolean") return o.glassSidebar ? "frost" : "solid";
  return APPEARANCE_DEFAULT.glassStyle;
}

export function parseAppearance(raw: unknown): Appearance {
  if (!raw || typeof raw !== "object") return { ...APPEARANCE_DEFAULT };
  const o = raw as Record<string, unknown>;
  return {
    theme: THEMES.has(o.theme as ThemeChoice) ? (o.theme as ThemeChoice) : APPEARANCE_DEFAULT.theme,
    fontPx: readFontPx(o),
    glassStyle: readGlassStyle(o),
    glassContrast: readGlassContrast(o),
    diffMarkers: DIFFS.has(o.diffMarkers as DiffMarkers)
      ? (o.diffMarkers as DiffMarkers)
      : APPEARANCE_DEFAULT.diffMarkers,
  };
}

export function loadAppearance(openId = ""): Appearance {
  try {
    const raw = localStorage.getItem(appearanceStorageKey(openId));
    if (!raw && openId) {
      const legacy = localStorage.getItem(APPEARANCE_KEY);
      if (legacy) return parseAppearance(JSON.parse(legacy) as unknown);
    }
    if (!raw) return { ...APPEARANCE_DEFAULT };
    return parseAppearance(JSON.parse(raw) as unknown);
  } catch {
    return { ...APPEARANCE_DEFAULT };
  }
}

export function saveAppearance(next: Appearance, openId = ""): void {
  try {
    localStorage.setItem(appearanceStorageKey(openId), JSON.stringify(next));
  } catch {
    /* ignore quota / private mode */
  }
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): "light" | "dark" {
  if (choice === "system") return systemDark ? "dark" : "light";
  return choice;
}

type AppearanceRootEl = {
  dataset: DOMStringMap | Record<string, string>;
  style: { setProperty: (name: string, value: string) => void };
};

export function applyAppearance(
  prefs: Appearance,
  systemDark = false,
  root: AppearanceRootEl = document.documentElement,
): void {
  const theme = resolveTheme(prefs.theme, systemDark);
  const scale = typeScale(prefs.fontPx);
  const contrast = clampGlassContrast(prefs.glassContrast);
  const alpha = glassAlpha(contrast);
  root.dataset.theme = theme;
  root.dataset.glassStyle = prefs.glassStyle;
  root.dataset.glassSidebar = isGlassOn(prefs.glassStyle) ? "on" : "off";
  root.dataset.diff = prefs.diffMarkers;
  root.style.setProperty("--ui-font-px", String(scale.ui));
  root.style.setProperty("--ui-font", `${scale.ui}px`);
  root.style.setProperty("--page-title", `${scale.title}px`);
  root.style.setProperty("--side-label", `${scale.side}px`);
  root.style.setProperty("--account-name", `${scale.account}px`);
  root.style.setProperty("--side-icon", `${scale.icon}px`);
  root.style.setProperty("--account-avatar", `${scale.avatar}px`);
  root.style.setProperty("--glass-contrast", String(contrast));
  root.style.setProperty("--glass-alpha", String(alpha));
}
