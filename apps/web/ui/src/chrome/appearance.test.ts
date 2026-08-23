import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPEARANCE_DEFAULT,
  APPEARANCE_KEY,
  applyAppearance,
  clampFontPx,
  clampGlassContrast,
  glassAlpha,
  isGlassOn,
  loadAppearance,
  parseAppearance,
  resolveTheme,
  saveAppearance,
  typeScale,
} from "./appearance.js";

function fakeRoot() {
  const css: Record<string, string> = {};
  const dataset: Record<string, string> = {};
  return {
    dataset,
    style: {
      setProperty(name: string, value: string) {
        css[name] = value;
      },
    },
    css,
  };
}

describe("parseAppearance", () => {
  it("fills defaults for junk", () => {
    assert.deepEqual(parseAppearance(null), APPEARANCE_DEFAULT);
    assert.deepEqual(parseAppearance({ theme: "neon" }), APPEARANCE_DEFAULT);
  });

  it("keeps known fields", () => {
    const next = parseAppearance({
      theme: "dark",
      fontPx: 18,
      glassStyle: "liquid",
      glassContrast: 70,
      diffMarkers: "underline",
    });
    assert.deepEqual(next, {
      theme: "dark",
      fontPx: 18,
      glassStyle: "liquid",
      glassContrast: 70,
      diffMarkers: "underline",
    });
  });

  it("migrates old segmented fontScale and contrast", () => {
    const next = parseAppearance({
      theme: "light",
      fontScale: "lg",
      glassSidebar: true,
      contrast: "high",
      diffMarkers: "color",
    });
    assert.equal(next.fontPx, 18);
    assert.equal(next.glassContrast, 80);
    assert.equal(next.glassStyle, "frost");
  });

  it("migrates old glassSidebar boolean", () => {
    assert.equal(parseAppearance({ glassSidebar: false }).glassStyle, "solid");
    assert.equal(parseAppearance({ glassSidebar: true }).glassStyle, "frost");
  });

  it("glassStyle wins over legacy glassSidebar", () => {
    assert.equal(parseAppearance({ glassStyle: "liquid", glassSidebar: false }).glassStyle, "liquid");
    assert.equal(parseAppearance({ glassStyle: "solid", glassSidebar: true }).glassStyle, "solid");
    assert.equal(parseAppearance({ glassStyle: "frost" }).glassStyle, "frost");
    assert.equal(parseAppearance({ glassStyle: "solid" }).glassStyle, "solid");
  });

  it("rejects unknown glassStyle and falls back", () => {
    assert.equal(parseAppearance({ glassStyle: "neon" }).glassStyle, "frost");
    assert.equal(parseAppearance({ glassStyle: "neon", glassSidebar: false }).glassStyle, "solid");
  });

  it("clamps typed px", () => {
    assert.equal(parseAppearance({ fontPx: 9 }).fontPx, 13);
    assert.equal(parseAppearance({ fontPx: 40 }).fontPx, 28);
    assert.equal(parseAppearance({ fontPx: "17" }).fontPx, 17);
  });
});

describe("resolveTheme", () => {
  it("follows system only when asked", () => {
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("dark", false), "dark");
    assert.equal(resolveTheme("system", true), "dark");
    assert.equal(resolveTheme("system", false), "light");
  });
});

describe("glassAlpha", () => {
  it("maps 55 to the locked 0.55 fill", () => {
    assert.equal(glassAlpha(0), 0.22);
    assert.equal(glassAlpha(55), 0.55);
    assert.equal(glassAlpha(100), 0.9);
  });
});

describe("typeScale", () => {
  it("grows title and sidebar with body px", () => {
    assert.equal(typeScale(16).ui, 16);
    assert.equal(typeScale(16).title, 28);
    assert.ok(typeScale(20).title > typeScale(16).title);
  });
});

describe("clampFontPx", () => {
  it("stays in 13–28", () => {
    assert.equal(clampFontPx(Number.NaN), 16);
    assert.equal(clampFontPx(12.4), 13);
    assert.equal(clampFontPx(27.6), 28);
  });
});

describe("applyAppearance", () => {
  it("writes theme data and css variables", () => {
    const root = fakeRoot();
    applyAppearance(
      {
        theme: "system",
        fontPx: 20,
        glassStyle: "frost",
        glassContrast: 40,
        diffMarkers: "off",
      },
      true,
      root,
    );
    assert.equal(root.dataset.theme, "dark");
    assert.equal(root.dataset.glassStyle, "frost");
    assert.equal(root.dataset.glassSidebar, "on");
    assert.equal(root.dataset.diff, "off");
    assert.equal(root.css["--ui-font"], "20px");
    assert.equal(root.css["--page-title"], "35px");
    assert.equal(root.css["--glass-contrast"], "40");
    assert.equal(root.css["--glass-alpha"], String(glassAlpha(40)));
  });

  it("turns glass off in dataset", () => {
    const root = fakeRoot();
    applyAppearance({ ...APPEARANCE_DEFAULT, glassStyle: "solid" }, false, root);
    assert.equal(root.dataset.glassStyle, "solid");
    assert.equal(root.dataset.glassSidebar, "off");
  });

  it("marks liquid glass in dataset", () => {
    const root = fakeRoot();
    applyAppearance({ ...APPEARANCE_DEFAULT, glassStyle: "liquid" }, false, root);
    assert.equal(root.dataset.glassStyle, "liquid");
    assert.equal(root.dataset.glassSidebar, "on");
  });
});

describe("isGlassOn", () => {
  it("is off only for solid", () => {
    assert.equal(isGlassOn("solid"), false);
    assert.equal(isGlassOn("frost"), true);
    assert.equal(isGlassOn("liquid"), true);
  });
});

describe("clampGlassContrast", () => {
  it("defaults junk to 55 and clamps 0–100", () => {
    assert.equal(clampGlassContrast(Number.NaN), 55);
    assert.equal(clampGlassContrast(-4), 0);
    assert.equal(clampGlassContrast(140), 100);
  });
});

describe("typeScale floors", () => {
  it("keeps sidebar and account readable at 13px", () => {
    const s = typeScale(13);
    assert.equal(s.side, 15);
    assert.equal(s.account, 14);
    assert.ok(s.icon >= 20);
    assert.ok(s.avatar >= 32);
  });
});

describe("loadAppearance / saveAppearance", () => {
  it("round-trips and falls back on junk JSON", () => {
    const mem = new Map<string, string>();
    const ls = {
      getItem(key: string) {
        return mem.has(key) ? mem.get(key)! : null;
      },
      setItem(key: string, value: string) {
        mem.set(key, value);
      },
    };
    const g = globalThis as { localStorage?: typeof ls };
    const prev = g.localStorage;
    g.localStorage = ls;
    try {
      assert.deepEqual(loadAppearance(), APPEARANCE_DEFAULT);
      saveAppearance({ ...APPEARANCE_DEFAULT, fontPx: 18, theme: "dark", glassStyle: "liquid" });
      assert.equal(loadAppearance().fontPx, 18);
      assert.equal(loadAppearance().theme, "dark");
      assert.equal(loadAppearance().glassStyle, "liquid");
      mem.set(APPEARANCE_KEY, JSON.stringify({ glassSidebar: false }));
      assert.equal(loadAppearance().glassStyle, "solid");
      mem.set(APPEARANCE_KEY, "{not json");
      assert.deepEqual(loadAppearance(), APPEARANCE_DEFAULT);
      mem.set(APPEARANCE_KEY, '"just a string"');
      assert.deepEqual(loadAppearance(), APPEARANCE_DEFAULT);
    } finally {
      if (prev) g.localStorage = prev;
      else delete g.localStorage;
    }
  });
});
