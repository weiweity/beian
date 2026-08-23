import { useEffect, useState } from "react";
import { Segmented } from "antd";
import { useAppearance } from "./AppearanceRoot";
import {
  FONT_PX_MAX,
  FONT_PX_MIN,
  clampFontPx,
  clampGlassContrast,
  isGlassOn,
  type DiffMarkers,
  type GlassStyle,
  type ThemeChoice,
} from "./appearance";

function AppleSlider({
  min,
  max,
  step,
  value,
  disabled,
  ariaLabel,
  onChange,
}: {
  min: number;
  max: number;
  step?: number;
  value: number;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (n: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      className="apple-slider"
      min={min}
      max={max}
      step={step ?? 1}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{ ["--pct" as string]: `${pct}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

export function AppearancePane() {
  const { prefs, setPrefs } = useAppearance();
  const [fontDraft, setFontDraft] = useState(String(prefs.fontPx));

  useEffect(() => {
    setFontDraft(String(prefs.fontPx));
  }, [prefs.fontPx]);

  function commitFont(raw: string) {
    const n = Number(raw);
    const next = clampFontPx(n);
    setFontDraft(String(next));
    if (next !== prefs.fontPx) setPrefs({ ...prefs, fontPx: next });
  }

  return (
    <div className="appear-list">
      <div className="appear-row">
        <div>
          <div className="appear-label">主题</div>
          <p className="appear-help">浅色对准锁定稿。深色是同一套淡紫品牌，不是灰黑中台。</p>
        </div>
        <Segmented
          value={prefs.theme}
          onChange={(v) => setPrefs({ ...prefs, theme: v as ThemeChoice })}
          options={[
            { label: "浅色", value: "light" },
            { label: "深色", value: "dark" },
            { label: "跟随系统", value: "system" },
          ]}
        />
      </div>

      <div className="appear-row appear-row-stack">
        <div>
          <div className="appear-label">UI 字号</div>
          <p className="appear-help">13–28 px。锁定稿正文 16。可拖，也可直接填数字。</p>
        </div>
        <div className="appear-control">
          <AppleSlider
            min={FONT_PX_MIN}
            max={FONT_PX_MAX}
            value={prefs.fontPx}
            ariaLabel="UI 字号"
            onChange={(n) => setPrefs({ ...prefs, fontPx: clampFontPx(n) })}
          />
          <label className="appear-px">
            <input
              inputMode="numeric"
              value={fontDraft}
              aria-label="字号像素"
              onChange={(e) => {
                const raw = e.target.value.replace(/[^\d]/g, "");
                setFontDraft(raw);
                if (!raw) return;
                const n = Number(raw);
                if (n >= FONT_PX_MIN && n <= FONT_PX_MAX) {
                  setPrefs({ ...prefs, fontPx: n });
                }
              }}
              onBlur={() => commitFont(fontDraft)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            <span>px</span>
          </label>
        </div>
      </div>

      <div className="appear-row appear-row-stack">
        <div>
          <div className="appear-label">侧栏材质</div>
          <p className="appear-help">
            毛玻璃是雾面对照锁定稿。液态玻璃按 iOS 27：折射壳上的紫雾，加高光边和暗边。实心不透、滚动更轻。
          </p>
        </div>
        <Segmented
          value={prefs.glassStyle}
          onChange={(v) => setPrefs({ ...prefs, glassStyle: v as GlassStyle })}
          options={[
            { label: "实心", value: "solid" },
            { label: "毛玻璃", value: "frost" },
            { label: "液态玻璃", value: "liquid" },
          ]}
        />
      </div>

      <div className={isGlassOn(prefs.glassStyle) ? "appear-row appear-row-stack" : "appear-row appear-row-stack is-dim"}>
        <div>
          <div className="appear-label">对比度</div>
          <p className="appear-help">只调毛玻璃和液态玻璃的雾面。低更透、高更实。实心时无效。</p>
        </div>
        <div className="appear-control">
          <span className="appear-ends">透</span>
          <AppleSlider
            min={0}
            max={100}
            value={prefs.glassContrast}
            disabled={!isGlassOn(prefs.glassStyle)}
            ariaLabel="侧栏玻璃对比度"
            onChange={(n) => setPrefs({ ...prefs, glassContrast: clampGlassContrast(n) })}
          />
          <span className="appear-ends">实</span>
        </div>
      </div>

      <div className="appear-row">
        <div>
          <div className="appear-label">差异标记</div>
          <p className="appear-help">核对页图上的钉。色块是锁定稿；下划线更克制；关闭只留右侧列表。</p>
        </div>
        <Segmented
          value={prefs.diffMarkers}
          onChange={(v) => setPrefs({ ...prefs, diffMarkers: v as DiffMarkers })}
          options={[
            { label: "色块", value: "color" },
            { label: "下划线", value: "underline" },
            { label: "关闭", value: "off" },
          ]}
        />
      </div>
    </div>
  );
}
