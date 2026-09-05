import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

let dist: string;
test.beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), "beian-lightbox-e2e-"));
  execFileSync("npm", ["run", "build", "--", "--outDir", dist], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 60_000, stdio: "pipe",
  });
});
test.afterAll(() => { if (dist) rmSync(dist, { recursive: true }); });

test("旧单加载中打开原图，图片就绪后灯箱自动绘制", async ({ page, syntheticApi }) => {
  // Exercise the built React app with every request intercepted; no Hono or
  // production data, and no HTTP server is needed for this regression.
  const assets = new Map<string, Buffer>([["/mockup/aaaaaaaaaaaa", readFileSync(join(dist, "index.html"))]]);
  for (const name of readdirSync(join(dist, "assets"))) {
    assets.set(`/assets/${name}`, readFileSync(join(dist, "assets", name)));
  }
  syntheticApi.mockups.push({
    id: "aaaaaaaaaaaa", title: "SYNTHETIC legacy lightbox", status: "done",
    files: [{ key: "white_a", name: "front.png" }, { key: "white_b", name: "back.png" }],
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (/\/files\/white_[ab]$/.test(path)) {
      await gate;
      return route.fulfill({ contentType: "image/svg+xml", body:
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="50"><rect width="40" height="50" fill="red"/></svg>' });
    }
    if (path.startsWith("/api/")) return route.fallback();
    const body = assets.get(path);
    if (!body) return route.fulfill({ status: 404, body: "synthetic asset not supplied" });
    const contentType = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
    return route.fulfill({ body, contentType });
  });
  try {
    await page.goto("/mockup/aaaaaaaaaaaa", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "打开正面 + 侧面原图", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    release();
    const canvas = page.getByRole("dialog").locator("canvas");
    await expect(canvas).toHaveAttribute("width", "40");
    await expect(canvas).toHaveAttribute("height", "50");
    expect(await canvas.evaluate((node: HTMLCanvasElement) =>
      Array.from(node.getContext("2d")!.getImageData(20, 25, 1, 1).data))).toEqual([255, 0, 0, 255]);
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});
