import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import type { MockupJob } from "../src/api";

let dist: string;
const assets = new Map<string, Buffer>();
test.beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), "beian-rf09-e2e-"));
  execFileSync("npm", ["run", "build", "--", "--outDir", dist], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 60_000, stdio: "pipe",
  });
  for (const name of readdirSync(join(dist, "assets"))) assets.set(`/assets/${name}`, readFileSync(join(dist, "assets", name)));
});
test.afterAll(() => { if (dist) rmSync(dist, { recursive: true }); });

const ID = "af0900000001";
const GEN = "g1-rf09-preview-" + "a".repeat(48);
const FULL_UPGRADE_NOTICE = "高清图暂时未加载，重新打开此单可重试";
const MEASURE_DIR = process.env.RF09_MEASURE_DIR || "";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function crc32(data: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, body, crc]);
}

function pngFill(
  width: number,
  height: number,
  background: [number, number, number, number],
  rect?: { x: number; y: number; w: number; h: number; color: [number, number, number, number] },
): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const inside = rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const color = inside ? rect.color : background;
      const i = row + 1 + x * 4;
      raw[i] = color[0]; raw[i + 1] = color[1]; raw[i + 2] = color[2]; raw[i + 3] = color[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 1 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const FLOW = {
  productCard: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect x="20" y="24" width="40" height="48" fill="#c80000"/></svg>',
  productFull: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect x="20" y="24" width="40" height="48" fill="#0014e6"/></svg>',
  groundCard: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect width="80" height="96" fill="#00a000"/></svg>',
  groundFull: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect width="80" height="96" fill="#c8c800"/></svg>',
  setCard: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect width="80" height="96" fill="#c800c8"/></svg>',
  setFull: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="96"><rect width="80" height="96" fill="#00c8c8"/></svg>',
};

function jobModel(): MockupJob {
  const files = [
    "white_a", "white_b", "white_a_ground", "white_b_ground", "white_a_set", "white_b_set",
    "white_a_card", "white_b_card", "white_a_ground_card", "white_b_ground_card", "white_a_set_card", "white_b_set_card", "glb",
  ].map((key) => ({ key, name: key === "glb" ? "box.glb" : `${key}.png` }));
  return {
    id: ID, title: "SYNTHETIC RF-09", owner: "ou_synthetic", status: "done", files,
    current_render_generation_id: GEN,
    render_generation_capabilities: {
      history: { allowed: true },
      activate: { allowed: false, reason: "generation_missing" },
      legacy_relight: { allowed: true },
      upgrade: { allowed: false, reason: "upgrade_unwired" },
    },
  };
}

type GateMap = Record<string, ReturnType<typeof deferred> | "fail" | "open">;

function layerBody(key: string, pngs?: Map<string, Buffer>): { type: string; body: string | Buffer } | null {
  if (key === "glb") return { type: "model/gltf-binary", body: Buffer.from("glTF") };
  const card = key.endsWith("_card");
  const base = card ? key.slice(0, -5) : key;
  const kind = base.includes("set") ? "set" : base.includes("ground") ? "ground" : "product";
  if (pngs) {
    const body = pngs.get(`${kind}:${card ? "card" : "full"}`);
    if (body) return { type: "image/png", body };
  }
  const svg = kind === "product" ? (card ? FLOW.productCard : FLOW.productFull)
    : kind === "ground" ? (card ? FLOW.groundCard : FLOW.groundFull)
    : (card ? FLOW.setCard : FLOW.setFull);
  return { type: "image/svg+xml", body: svg };
}

async function serve(page: Page, opts: {
  gates?: GateMap;
  pngs?: Map<string, Buffer>;
  job?: MockupJob;
  urls?: string[];
}) {
  const job = opts.job || jobModel();
  const urls = opts.urls || [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (!path.startsWith("/api/")) {
      const body = assets.get(path) || (path.startsWith("/mockup") ? readFileSync(join(dist, "index.html")) : null);
      return body
        ? route.fulfill({ body, contentType: path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html" })
        : route.fulfill({ status: 404, body: "synthetic asset not supplied" });
    }
    if (path === "/api/auth/me") return json({ logged_in: true, display_name: "SYNTHETIC", open_id: "ou_synthetic", role: "reviewer", perms: ["read", "create", "confirm_structure"] });
    if (path === "/api/status" || path === "/api/health") return json({ ok: true, version: "0.0.0.0", jobs: {} });
    if (path === "/api/uploads" || path === "/api/tasks") return json([]);
    if (path === "/api/mockups") return json([job]);
    if (path === `/api/mockups/${job.id}`) return json(job);
    if (path === `/api/mockups/${job.id}/render-generations` && method === "GET") return json({ items: [], next_cursor: null });
    if (path === `/api/mockups/${job.id}/render-generations` && method === "POST") {
      urls.push(`POST:${path}`);
      return json({ message: "not used" }, 409);
    }
    if (path.startsWith(`/api/mockups/${job.id}/files/`)) {
      urls.push(url.href);
      const key = path.split("/").pop()!;
      const gate = opts.gates?.[key];
      if (gate === "fail") return route.fulfill({ status: 404, body: "missing" });
      if (gate && gate !== "open") await gate.promise;
      const payload = layerBody(key, opts.pngs);
      if (!payload) return route.fulfill({ status: 404, body: "no layer" });
      return route.fulfill({ contentType: payload.type, body: payload.body });
    }
    return json({ message: "synthetic route missing" }, 404);
  });
  return { job, urls };
}

function canvas(page: Page, label = "正面与侧面成片") {
  return page.locator(`canvas[aria-label="${label}"]`);
}

async function sample(page: Page, xr: number, yr: number, label = "正面与侧面成片") {
  return canvas(page, label).evaluate((node: HTMLCanvasElement, point: number[]) => {
    const x = Math.max(0, Math.min(node.width - 1, Math.floor(node.width * point[0])));
    const y = Math.max(0, Math.min(node.height - 1, Math.floor(node.height * point[1])));
    return Array.from(node.getContext("2d")!.getImageData(x, y, 1, 1).data);
  }, [xr, yr]);
}

function isRed(px: number[]) { return px[0] > 140 && px[0] > px[2] && px[3] > 200; }
function isBlue(px: number[]) { return px[2] > 140 && px[2] > px[0] && px[3] > 200; }
function isMagenta(px: number[]) { return px[0] > 120 && px[2] > 120 && px[1] < 80; }
function isCyan(px: number[]) { return px[1] > 120 && px[2] > 120 && px[0] < 80; }
function isGroundFallback(px: number[]) { return px[0] > 140 && px[1] > 140 && px[2] < 80; }

async function inspectDownload(page: Page, bytes: Buffer, x: number, y: number) {
  return page.evaluate(async ({ data, x, y }) => {
    const image = await createImageBitmap(new Blob([new Uint8Array(data)]));
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const px = Array.from(ctx.getImageData(x, y, 1, 1).data);
    const size = [image.width, image.height];
    image.close();
    return { px, size };
  }, { data: Array.from(bytes), x, y });
}

async function trackUnhandled(page: Page) {
  const errors: string[] = [];
  await page.addInitScript(() => {
    (window as Window & { __rf09Unhandled?: string[] }).__rf09Unhandled = [];
    window.addEventListener("unhandledrejection", (event) => {
      const bag = (window as Window & { __rf09Unhandled?: string[] }).__rf09Unhandled || [];
      bag.push(String(event.reason));
    });
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return {
    async snapshot() {
      const extra = await page.evaluate(() => (window as Window & { __rf09Unhandled?: string[] }).__rf09Unhandled || []);
      return [...errors, ...extra];
    },
  };
}

test("同代 card 真正绘制后再升级 full，像素与来源属性一起变", async ({ page }) => {
  const gates: GateMap = {
    white_a: deferred(), white_a_ground: deferred(), white_a_set: deferred(),
    white_b: deferred(), white_b_ground: deferred(), white_b_set: deferred(),
  };
  const { urls } = await serve(page, { gates });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  const shot = canvas(page);
  await expect(shot).toHaveAttribute("data-preview-source", "card");
  await expect(shot).toHaveAttribute("data-preview-product", "card");
  await expect.poll(async () => isRed(await sample(page, 0.5, 0.5))).toBe(true);
  await expect.poll(async () => isMagenta(await sample(page, 0.08, 0.08))).toBe(true);
  (gates.white_a as ReturnType<typeof deferred>).release();
  await expect(shot).toHaveAttribute("data-preview-product", "full");
  await expect.poll(async () => isBlue(await sample(page, 0.5, 0.5))).toBe(true);
  await expect.poll(async () => isMagenta(await sample(page, 0.08, 0.08))).toBe(true);
  await expect(shot).toHaveAttribute("data-preview-source", "mixed");
  (gates.white_a_set as ReturnType<typeof deferred>).release();
  await expect(shot).toHaveAttribute("data-preview-set", "full");
  await expect.poll(async () => isCyan(await sample(page, 0.08, 0.08))).toBe(true);
  (gates.white_a_ground as ReturnType<typeof deferred>).release();
  (gates.white_b as ReturnType<typeof deferred>).release();
  (gates.white_b_ground as ReturnType<typeof deferred>).release();
  (gates.white_b_set as ReturnType<typeof deferred>).release();
  await expect(shot).toHaveAttribute("data-preview-source", "full");
  expect(urls.some((url) => url.includes("white_a_card"))).toBe(true);
  expect(urls.filter((url) => url.startsWith("POST:")).length).toBe(0);
});

test("ground 先到与 set pending/失败不挡住产品升级", async ({ page }) => {
  const setCard = deferred();
  const setFull = deferred();
  const gates: GateMap = {
    white_a: deferred(), white_a_ground: "open",
    white_a_set: setFull, white_a_set_card: setCard,
    white_b: "open", white_b_ground: "open",
    white_b_set: "fail", white_b_set_card: "fail",
  };
  await serve(page, { gates });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  const shot = canvas(page);
  await expect(shot).toHaveAttribute("data-preview-product", "card");
  await expect(shot).toHaveAttribute("data-preview-set-fetch", "pending");
  await expect(shot).toHaveAttribute("data-preview-set-fallback", "1");
  (gates.white_a as ReturnType<typeof deferred>).release();
  await expect.poll(async () => isBlue(await sample(page, 0.5, 0.5))).toBe(true);
  await expect(shot).toHaveAttribute("data-preview-product", "full");
  await expect(shot).toHaveAttribute("data-preview-set-fetch", "pending");
  setCard.release();
  setFull.release();
  await expect(shot).toHaveAttribute("data-preview-set", "full");
  await expect(shot).not.toHaveAttribute("data-preview-set-fallback", "1");
});

test("full 失败留 card 并提示重开，重新打开会再请求 full", async ({ page }) => {
  const urls: string[] = [];
  await serve(page, {
    urls,
    gates: { white_a: "fail", white_a_ground: "fail", white_a_set: "fail", white_b: "fail", white_b_ground: "fail", white_b_set: "fail" },
  });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  const shot = canvas(page);
  await expect(shot).toHaveAttribute("data-preview-product", "card");
  await expect(shot).toHaveAttribute("data-preview-product-upgrade", "failed");
  await expect.poll(async () => isRed(await sample(page, 0.5, 0.5))).toBe(true);
  await expect(page.locator(".mockup-hud")).toHaveText(FULL_UPGRADE_NOTICE);
  const productFull = (href: string) => {
    try {
      const path = new URL(href, "http://synthetic.invalid").pathname;
      return path.endsWith("/white_a");
    } catch { return false; }
  };
  const before = urls.filter(productFull).length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(canvas(page)).toHaveAttribute("data-preview-product-upgrade", "failed");
  const after = urls.filter(productFull).length;
  expect(after).toBeGreaterThan(before);
  expect(urls.filter((url) => url.startsWith("POST:")).length).toBe(0);
});

test("card 失败回退 full；白底导出不等待 set", async ({ page }) => {
  await serve(page, {
    gates: {
      white_a_card: "fail", white_a_ground_card: "fail", white_a_set_card: "fail",
      white_b_card: "fail", white_b_ground_card: "fail", white_b_set_card: "fail",
      white_a_set: deferred(), white_b_set: deferred(),
    },
  });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白底", { exact: true }).click();
  const shot = canvas(page);
  await expect(shot).toHaveAttribute("data-preview-product", "full");
  await expect.poll(async () => isBlue(await sample(page, 0.5, 0.5))).toBe(true);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  const saved = await download;
  const bytes = readFileSync((await saved.path())!);
  const png = await inspectDownload(page, bytes, 40, 48);
  expect(png.size).toEqual([80, 96]);
  expect(isBlue(png.px)).toBe(true);
});

test("ground 先失败时导出立即失败且无未处理拒绝", async ({ page }) => {
  const product = deferred();
  const unhandled = await trackUnhandled(page);
  await serve(page, { gates: { white_a: product, white_b: product, white_a_ground: "fail", white_b_ground: "fail" } });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  const shot = canvas(page);
  await expect(shot).toHaveAttribute("data-preview-product", "card");
  await expect(shot).toHaveAttribute("data-preview-set", "full");
  const before = await unhandled.snapshot();
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  await expect(page.locator(".mockup-hud")).toHaveText("导出失败");
  expect((await unhandled.snapshot()).slice(before.length)).toEqual([]);
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  await expect(page.locator(".mockup-hud")).toHaveText("导出失败");
  expect((await unhandled.snapshot()).slice(before.length)).toEqual([]);
  product.release();
});

test("product 先失败时导出不等待悬挂的 ground", async ({ page }) => {
  const ground = deferred();
  const unhandled = await trackUnhandled(page);
  await serve(page, { gates: { white_a: "fail", white_b: "fail", white_a_ground: ground, white_b_ground: ground } });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  const shot = canvas(page);
  await expect(shot).toHaveAttribute("data-preview-product", "card");
  await expect(shot).toHaveAttribute("data-preview-set", "full");
  const before = await unhandled.snapshot();
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  await expect(page.locator(".mockup-hud")).toHaveText("导出失败");
  expect((await unhandled.snapshot()).slice(before.length)).toEqual([]);
  ground.release();
});

test("白桌白墙下载不因可选 set pending 挂起", async ({ page }) => {
  const setCard = deferred();
  const setFull = deferred();
  await serve(page, {
    gates: {
      white_a_set: setFull, white_a_set_card: setCard,
      white_b_set: setFull, white_b_set_card: setCard,
    },
  });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  await expect(canvas(page)).toHaveAttribute("data-preview-set-fallback", "1");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  const saved = await download;
  const bytes = readFileSync((await saved.path())!);
  const corner = await inspectDownload(page, bytes, 4, 4);
  const center = await inspectDownload(page, bytes, 40, 48);
  expect(corner.size).toEqual([80, 96]);
  expect(isBlue(center.px)).toBe(true);
  expect(isGroundFallback(corner.px)).toBe(true);
  expect(isMagenta(corner.px)).toBe(false);
  setCard.release();
  setFull.release();
});

test("预览已用 set card 时下载不静默换成 ground，full 就绪后可下同背景", async ({ page }) => {
  const setFull = deferred();
  await serve(page, { gates: { white_a_set: setFull, white_b_set: setFull } });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  const shot = canvas(page);
  await expect(shot).toHaveAttribute("data-preview-set", "card");
  await expect.poll(async () => isMagenta(await sample(page, 0.08, 0.08))).toBe(true);
  const stolen = page.waitForEvent("download", { timeout: 1500 }).then(() => "got").catch(() => "none");
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  expect(await stolen).toBe("none");
  await expect(page.locator(".mockup-hud")).toHaveText(FULL_UPGRADE_NOTICE);
  const ghost = page.waitForEvent("download", { timeout: 1500 }).then(() => "got").catch(() => "none");
  setFull.release();
  await expect(shot).toHaveAttribute("data-preview-set", "full");
  await expect.poll(async () => isCyan(await sample(page, 0.08, 0.08))).toBe(true);
  expect(await ghost).toBe("none");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  const saved = await download;
  const bytes = readFileSync((await saved.path())!);
  const corner = await inspectDownload(page, bytes, 4, 4);
  const center = await inspectDownload(page, bytes, 40, 48);
  expect(corner.size).toEqual([80, 96]);
  expect(isBlue(center.px)).toBe(true);
  expect(isCyan(corner.px)).toBe(true);
  expect(isMagenta(corner.px)).toBe(false);
  expect(isGroundFallback(corner.px)).toBe(false);
});

test("set full 持续 pending 时解锁，切白底可下，迟到 set 不产生幽灵下载", async ({ page }) => {
  const setFull = deferred();
  await serve(page, { gates: { white_a_set: setFull, white_b_set: setFull } });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  await expect(canvas(page)).toHaveAttribute("data-preview-set", "card");
  await expect.poll(async () => isMagenta(await sample(page, 0.08, 0.08))).toBe(true);
  const stolen = page.waitForEvent("download", { timeout: 1500 }).then(() => "got").catch(() => "none");
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  expect(await stolen).toBe("none");
  await expect(page.locator(".mockup-hud")).toHaveText(FULL_UPGRADE_NOTICE);
  await page.locator(".mockup-backdrop-switch").getByText("白底", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  const saved = await download;
  const white = await inspectDownload(page, readFileSync((await saved.path())!), 40, 48);
  expect(white.size).toEqual([80, 96]);
  expect(isBlue(white.px)).toBe(true);
  const ghost = page.waitForEvent("download", { timeout: 1500 }).then(() => "got").catch(() => "none");
  setFull.release();
  await expect(canvas(page)).toHaveAttribute("data-preview-set", "full");
  expect(await ghost).toBe("none");
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  await expect.poll(async () => isCyan(await sample(page, 0.08, 0.08))).toBe(true);
  const again = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  const recovered = await again;
  const setPng = await inspectDownload(page, readFileSync((await recovered.path())!), 4, 4);
  expect(setPng.size).toEqual([80, 96]);
  expect(isCyan(setPng.px)).toBe(true);
  expect(isGroundFallback(setPng.px)).toBe(false);
});

test("set full 失败且预览仍是 card 时不导出错误背景", async ({ page }) => {
  await serve(page, { gates: { white_a_set: "fail", white_b_set: "fail" } });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  await expect(canvas(page)).toHaveAttribute("data-preview-set", "card");
  const stolen = page.waitForEvent("download", { timeout: 1500 }).then(() => "got").catch(() => "none");
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  expect(await stolen).toBe("none");
  await expect(page.locator(".mockup-hud")).toHaveText(FULL_UPGRADE_NOTICE);
});

test("自动 HUD 消失后主动下载失败仍再提示", async ({ page }) => {
  await serve(page, { gates: { white_a_set: "fail", white_b_set: "fail" } });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  await expect(canvas(page)).toHaveAttribute("data-preview-set", "card");
  await expect(page.locator(".mockup-hud")).toHaveText(FULL_UPGRADE_NOTICE);
  await expect(page.locator(".mockup-hud")).toHaveCount(0, { timeout: 4000 });
  const stolen = page.waitForEvent("download", { timeout: 1500 }).then(() => "got").catch(() => "none");
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  expect(await stolen).toBe("none");
  await expect(page.locator(".mockup-hud")).toHaveText(FULL_UPGRADE_NOTICE);
});

test("灯箱已显示 set full 时下载不跟小预览 fallback 走 ground", async ({ page }) => {
  const setCard = deferred();
  await serve(page, { gates: { white_a_set_card: setCard, white_b_set_card: setCard } });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
  await expect(canvas(page)).toHaveAttribute("data-preview-set-fallback", "1");
  await page.getByRole("button", { name: "打开正面 + 侧面原图", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const box = dialog.locator("canvas");
  await expect.poll(async () => {
    const px = await box.evaluate((node: HTMLCanvasElement) => Array.from(node.getContext("2d")!.getImageData(4, 4, 1, 1).data));
    return isCyan(px);
  }).toBe(true);
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载", exact: true }).click();
  const saved = await download;
  const bytes = readFileSync((await saved.path())!);
  const corner = await inspectDownload(page, bytes, 4, 4);
  const center = await inspectDownload(page, bytes, 40, 48);
  expect(corner.size).toEqual([80, 96]);
  expect(isBlue(center.px)).toBe(true);
  expect(isCyan(corner.px)).toBe(true);
  expect(isGroundFallback(corner.px)).toBe(false);
  setCard.release();
});

test("灯箱正在显示 ground fallback 时，隐藏预览迟到的 set card 不改变下载背景", async ({ page }) => {
  const product = deferred();
  const setCard = deferred();
  const setFull = deferred();
  const unhandled = await trackUnhandled(page);
  await serve(page, { gates: {
    white_a: product, white_b: product,
    white_a_set_card: setCard, white_b_set_card: setCard,
    white_a_set: setFull, white_b_set: setFull,
  } });
  try {
    await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
    await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
    await expect(canvas(page)).toHaveAttribute("data-preview-set-fallback", "1");
    await expect(canvas(page)).toHaveAttribute("data-preview-ground", "full");
    await page.getByRole("button", { name: "打开正面 + 侧面原图", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const box = dialog.locator("canvas");
    const shownCorner = () => box.evaluate((node: HTMLCanvasElement) => Array.from(node.getContext("2d")!.getImageData(4, 4, 1, 1).data));
    await expect.poll(async () => isGroundFallback(await shownCorner())).toBe(true);
    setCard.release();
    await expect(page.locator("canvas.mockup-studio-canvas").first()).toHaveAttribute("data-preview-set", "card");
    expect(isGroundFallback(await shownCorner())).toBe(true);
    const download = page.waitForEvent("download", { timeout: 5000 });
    await dialog.getByRole("button", { name: "下载", exact: true }).click();
    product.release();
    const saved = await download;
    const bytes = readFileSync((await saved.path())!);
    expect(isGroundFallback((await inspectDownload(page, bytes, 4, 4)).px)).toBe(true);
    expect(isBlue((await inspectDownload(page, bytes, 40, 48)).px)).toBe(true);
    expect(await unhandled.snapshot()).toEqual([]);
  } finally {
    product.release(); setCard.release(); setFull.release();
  }
});

test("下载中重复点击、切背景或调灯仍只导出点击时的成片，卸载无未处理拒绝", async ({ page }) => {
  const product = deferred();
  const unhandled = await trackUnhandled(page);
  const downloaded: string[] = [];
  page.on("download", (item) => downloaded.push(item.suggestedFilename()));
  await serve(page, { gates: { white_a: product, white_b: product } });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白底", { exact: true }).click();
  await page.getByRole("button", { name: "调灯", exact: true }).click();
  await expect(canvas(page)).toHaveAttribute("data-preview-product", "card");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  await page.locator(".mockup-backdrop-switch").getByText("银底", { exact: true }).click();
  await page.getByRole("slider", { name: "产品灯光", exact: true }).press("Home");
  await page.getByRole("slider", { name: "背景灯光", exact: true }).press("Home");
  await expect(page.getByRole("slider", { name: "产品灯光", exact: true })).toHaveValue("0.6");
  await expect(page.getByRole("slider", { name: "背景灯光", exact: true })).toHaveValue("0.6");
  await page.getByRole("button", { name: "打样台", exact: true }).click();
  product.release();
  const saved = await download;
  const bytes = readFileSync((await saved.path())!);
  const center = await inspectDownload(page, bytes, 40, 48);
  const corner = await inspectDownload(page, bytes, 4, 4);
  expect(center.size).toEqual([80, 96]);
  expect(center.px).toEqual([0, 15, 234, 255]);
  expect(corner.px).toEqual([238, 238, 238, 255]);
  await page.waitForTimeout(300);
  expect(downloaded).toHaveLength(1);
  expect(await unhandled.snapshot()).toEqual([]);
});

test("已启动下载在预览卸载后仍完成", async ({ page }) => {
  test.setTimeout(40_000);
  const full = deferred();
  const urls: string[] = [];
  await serve(page, { gates: { white_a: full, white_b: full }, urls });
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.locator(".mockup-backdrop-switch").getByText("白底", { exact: true }).click();
  await expect(canvas(page)).toHaveAttribute("data-preview-product", "card");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载正面 + 侧面", exact: true }).click();
  await expect.poll(() => urls.some((href) => {
    try { return new URL(href, "http://synthetic.invalid").pathname.endsWith("/white_a"); }
    catch { return false; }
  })).toBe(true);
  await page.getByRole("button", { name: "打样台", exact: true }).click();
  full.release();
  const saved = await download;
  const bytes = readFileSync((await saved.path())!);
  const center = await inspectDownload(page, bytes, 40, 48);
  expect(center.size).toEqual([80, 96]);
  expect(isBlue(center.px)).toBe(true);
});

test("原图灯箱用 full 像素，不截预览 canvas", async ({ page }) => {
  await serve(page, {});
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "打开正面 + 侧面原图", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = dialog.locator("canvas");
  await expect.poll(async () => box.evaluate((node: HTMLCanvasElement) => node.width)).toBe(80);
  await expect.poll(async () => {
    const px = await box.evaluate((node: HTMLCanvasElement) => Array.from(node.getContext("2d")!.getImageData(40, 48, 1, 1).data));
    return isBlue(px);
  }).toBe(true);
});

test("resize 后仍保持已绘制来源标记", async ({ page }) => {
  await serve(page, {});
  await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
  const shot = canvas(page);
  await expect(shot).toHaveAttribute("data-preview-source", /card|mixed|full/);
  const before = await shot.evaluate((node: HTMLCanvasElement) => node.width);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect.poll(async () => shot.evaluate((node: HTMLCanvasElement) => node.width)).not.toBe(before);
  await expect(shot).toHaveAttribute("data-preview-source", /card|mixed|full/);
});

test("代表尺寸 PNG：记录 card 可见、full decode 与绘制", async ({ browser, browserName }, testInfo) => {
  test.setTimeout(180_000);
  const card = pngFill(1200, 1440, [0, 0, 0, 0], { x: 300, y: 360, w: 600, h: 720, color: [200, 0, 0, 255] });
  const full = pngFill(3000, 3600, [0, 0, 0, 0], { x: 750, y: 900, w: 1500, h: 1800, color: [0, 20, 230, 255] });
  const groundCard = pngFill(1200, 1440, [0, 160, 0, 255]);
  const groundFull = pngFill(3000, 3600, [200, 200, 0, 255]);
  const setCard = pngFill(1200, 1440, [200, 0, 200, 255]);
  const setFull = pngFill(3000, 3600, [0, 200, 200, 255]);
  const pngs = new Map<string, Buffer>([
    ["product:card", card], ["product:full", full],
    ["ground:card", groundCard], ["ground:full", groundFull],
    ["set:card", setCard], ["set:full", setFull],
  ]);
  const samples: Array<Record<string, unknown>> = [];
  let userAgent = "";
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => { (window as Window & { __RF09_PERF__?: boolean }).__RF09_PERF__ = true; });
    const page = await context.newPage();
    userAgent = await page.evaluate(() => navigator.userAgent);
    for (let i = 0; i < 3; i++) {
      await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
      const gates: GateMap = {
        white_a: deferred(), white_b: deferred(),
        white_a_ground: deferred(), white_b_ground: deferred(),
        white_a_set: deferred(), white_b_set: deferred(),
      };
      await serve(page, { gates, pngs });
      const t0 = Date.now();
      await page.goto(`/mockup/${ID}`, { waitUntil: "domcontentloaded" });
      await page.locator(".mockup-backdrop-switch").getByText("白桌白墙", { exact: true }).click();
      const shot = canvas(page);
      await expect(shot).toHaveAttribute("data-preview-product", "card");
      const tCard = Date.now() - t0;
      await expect.poll(async () => isRed(await sample(page, 0.5, 0.5))).toBe(true);
      const tCardPx = Date.now() - t0;
      const netFull = Date.now();
      (gates.white_a as ReturnType<typeof deferred>).release();
      (gates.white_b as ReturnType<typeof deferred>).release();
      (gates.white_a_ground as ReturnType<typeof deferred>).release();
      (gates.white_b_ground as ReturnType<typeof deferred>).release();
      (gates.white_a_set as ReturnType<typeof deferred>).release();
      (gates.white_b_set as ReturnType<typeof deferred>).release();
      await expect(shot).toHaveAttribute("data-preview-product", "full");
      const tProductFullAttr = Date.now() - netFull;
      await expect.poll(async () => isBlue(await sample(page, 0.5, 0.5))).toBe(true);
      const tProductFullPx = Date.now() - netFull;
      await expect(shot).toHaveAttribute("data-preview-set", "full");
      await expect(shot).toHaveAttribute("data-preview-source", "full");
      await expect(canvas(page, "反面与侧面成片")).toHaveAttribute("data-preview-source", "full");
      await expect.poll(async () => isCyan(await sample(page, 0.08, 0.08))).toBe(true);
      await expect.poll(async () => isCyan(await sample(page, 0.08, 0.08, "反面与侧面成片"))).toBe(true);
      const tCompositeFullPx = Date.now() - netFull;
      const marks = await page.evaluate(() => performance.getEntriesByType("mark").map((entry) => ({ name: entry.name, startTime: Math.round(entry.startTime) })));
      const size = await shot.evaluate((node: HTMLCanvasElement) => ({ width: node.width, height: node.height, css: { w: node.clientWidth, h: node.clientHeight } }));
      const observedDpr = await page.evaluate(() => window.devicePixelRatio);
      samples.push({
        dpr: observedDpr, i,
        tCardMs: tCard, tCardPixelMs: tCardPx,
        tProductFullAttrMs: tProductFullAttr, tProductFullPxMs: tProductFullPx,
        tCompositeFullPxMs: tCompositeFullPx,
        canvas: size, marks, cache: i === 0 ? "cold-page" : "repeat-navigation",
        source: { full: [3000, 3600], card: [1200, 1440] },
        hasSetFullMark: marks.some((entry) => entry.name === "rf09-decode-set-full"),
      });
    }
    await context.close();
  }
  const payload = {
    recorded_at: new Date().toISOString(),
    browser: browserName,
    userAgent,
    viewport: { width: 1440, height: 900 },
    fixture: "synthetic-png-3000x3600-alpha-product",
    note: "API 拦截本地 PNG，不计杭州网络。tProductFull* 只描述 product 层；tCompositeFullPxMs 等到两张成片 data-preview-source=full 且背景 set 像素。heap 未测。没有同环境修改前浏览器计时，不能据此声称无首屏回退或性能无异常。",
    adr_17_4: "网络完成后仍需 decode；decode 就绪后下一可用绘制机会替换。marks 仅在 window.__RF09_PERF__ 时写入，每名最多 24 条。不声称 rAF 等于屏幕合成时刻。",
    samples,
  };
  const out = testInfo.outputPath("rf09-preview-measure.json");
  writeFileSync(out, JSON.stringify(payload, null, 2));
  testInfo.attach("rf09-preview-measure", { path: out });
  if (MEASURE_DIR) {
    try {
      mkdirSync(MEASURE_DIR, { recursive: true });
      writeFileSync(join(MEASURE_DIR, "rf09-preview-measure-20260907.json"), JSON.stringify(payload, null, 2));
    } catch {
      /* audit copy is optional */
    }
  }
  expect(samples.length).toBe(6);
  expect(samples.every((row) => row.hasSetFullMark)).toBe(true);
});
