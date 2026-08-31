import { deflateSync } from "node:zlib";
import { expect, reviewTask, test } from "./fixtures";

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function solidPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(width * 4 + 1, 0xff);
  row[0] = 0;
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function installWorkingFullscreen(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    let active: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => active,
    });
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: function requestFullscreen() {
        active = this;
        queueMicrotask(() => document.dispatchEvent(new Event("fullscreenchange")));
        return Promise.resolve();
      },
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: function exitFullscreen() {
        active = null;
        queueMicrotask(() => document.dispatchEvent(new Event("fullscreenchange")));
        return Promise.resolve();
      },
    });
  });
}

test("核对 Dock 脱离工作区置顶，全屏时进入全屏根，处理疑点后发出签字请求", async ({
  page,
  syntheticApi,
}) => {
  const task = reviewTask();
  syntheticApi.tasks.push(task);
  await installWorkingFullscreen(page);
  await page.goto(`/review/${task.id}`);

  const dock = page.getByTestId("review-dock");
  await expect(dock).toBeVisible();
  expect(await dock.evaluate((node) => node.parentElement === document.body)).toBe(true);
  await expect(dock.getByLabel("疑点列表")).toBeVisible();
  await expect(dock.getByText("Excel 应印", { exact: true })).toBeVisible();
  await expect(dock.getByText("稿上读到", { exact: true })).toBeVisible();
  const [dockZ, signZ] = await Promise.all([
    dock.evaluate((node) => Number.parseInt(getComputedStyle(node).zIndex, 10)),
    page.locator(".review-sign-layer").first().evaluate((node) => Number.parseInt(getComputedStyle(node).zIndex, 10)),
  ]);
  expect(dockZ).toBeGreaterThan(signZ);
  await expect(page.locator(".canvas-zoom")).toHaveCSS("transform", "none");
  expect(
    await dock.locator(".review-evidence-grid").evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length),
  ).toBe(2);

  await page.getByRole("button", { name: "全屏核对" }).click();
  await expect(page.getByRole("button", { name: "退出全屏" })).toBeVisible();
  expect(await dock.evaluate((node) => node.parentElement?.getAttribute("data-testid"))).toBe("review-root");
  await page.getByLabel("核对结论").click();
  const decisionPopup = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
  await expect(decisionPopup).toBeVisible();
  expect(
    await decisionPopup.evaluate((node) => Boolean(node.closest(".review-page.is-fullscreen"))),
  ).toBe(true);
  await decisionPopup.getByText("有错", { exact: true }).click();
  await expect.poll(() => syntheticApi.calls.filter((item) => item.path.endsWith("/decision")).length).toBe(1);

  const noteInput = page.getByPlaceholder("补充说明，会进改稿清单");
  await noteInput.fill("需要补齐中文品名");
  await noteInput.press("Enter");
  await expect.poll(() => syntheticApi.calls.filter((item) => item.path.endsWith("/decision")).length).toBe(2);

  await page.getByRole("button", { name: "退出全屏" }).click();
  await expect(page.getByRole("button", { name: "全屏核对" })).toBeVisible();
  expect(await dock.evaluate((node) => node.parentElement === document.body)).toBe(true);

  await page.getByRole("textbox", { name: "结论", exact: true }).fill("中文品名需要设计改稿");
  await page.getByRole("button", { name: "签字并待设计改稿" }).click();

  await expect(page.getByText("已签字，不是系统过审")).toBeVisible();
  const decisionCalls = syntheticApi.calls.filter((item) => item.path.endsWith("/decision"));
  const decisionCall = decisionCalls.at(-1);
  const completeCall = syntheticApi.calls.find((item) => item.path.endsWith("/complete"));
  expect(decisionCall?.body).toMatchObject({
    hit_id: "hit_name",
    decision: "issue",
    note: "需要补齐中文品名",
  });
  expect(completeCall?.body).toEqual({ conclusion: "中文品名需要设计改稿" });
});

test("浏览器拒绝核对全屏时显示可执行中文提示", async ({ page, syntheticApi }) => {
  const task = reviewTask();
  syntheticApi.tasks.push(task);
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, "requestFullscreen", {
      configurable: true,
      value: () => Promise.reject(new Error("synthetic fullscreen denial")),
    });
  });
  await page.goto(`/review/${task.id}`);

  await page.getByRole("button", { name: "全屏核对" }).click();
  await expect(page.getByText("全屏打不开")).toBeVisible();
  await expect(page.getByRole("button", { name: "全屏核对" })).toHaveAttribute("aria-pressed", "false");
  expect(await page.getByTestId("review-dock").evaluate((node) => node.parentElement === document.body)).toBe(true);
});

test("一致字段没有疑点时只显示 Excel 应印与稿上读到两列", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd50");
  const hit = task.hits?.[0];
  if (!hit) throw new Error("合成核对单缺少字段");
  task.hits = [{
    ...hit,
    status: "一致",
    decision: "confirm",
    coverage: { hit: ["合成核对单"], miss: [], matched: 1, total: 1 },
  }];
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);

  const grid = page.getByTestId("review-dock").locator(".review-evidence-grid");
  await expect(grid.getByText("疑点 / 错误点", { exact: true })).toHaveCount(0);
  await expect(grid.getByText("Excel 应印", { exact: true })).toBeVisible();
  await expect(grid.getByText("稿上读到", { exact: true })).toBeVisible();
  expect(await grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length)).toBe(2);
});

test("矢量核对页加载失败时自动切回高清 PNG", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd48");
  task.pages = [
    {
      url: "/synthetic/review.svg",
      raster_url: "/synthetic/review.png",
      name: "page_01.svg",
      page: 1,
      width: 600,
      height: 800,
    },
  ];
  syntheticApi.tasks.push(task);
  await page.route("**/synthetic/review.svg", (route) => route.abort("failed"));
  await page.route("**/synthetic/review.png", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: solidPng(600, 800),
    }),
  );

  await page.goto(`/review/${task.id}`);

  const image = page.locator(".canvas-zoom img");
  await expect(image).toBeVisible();
  await expect.poll(() => image.getAttribute("src")).toBe("/synthetic/review.png");
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThanOrEqual(600);
  await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalHeight)).toBeGreaterThanOrEqual(800);
});

test("核对 Dock 可真实拖拽缩放并在刷新后恢复", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd49");
  syntheticApi.tasks.push(task);
  await page.goto(`/review/${task.id}`);

  const dock = page.getByTestId("review-dock");
  const before = await dock.boundingBox();
  const south = await dock.locator(".notes-resize-s").boundingBox();
  expect(before).not.toBeNull();
  expect(south).not.toBeNull();
  await page.mouse.move((south?.x || 0) + (south?.width || 0) / 2, (south?.y || 0) + (south?.height || 0) / 2);
  await page.mouse.down();
  await page.mouse.move((south?.x || 0) + (south?.width || 0) / 2, (south?.y || 0) + 52, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await dock.boundingBox())?.height || 0).toBeGreaterThan((before?.height || 0) + 30);

  const toolbar = await dock.locator(".notes-toolbar").boundingBox();
  expect(toolbar).not.toBeNull();
  const dragX = (toolbar?.x || 0) + 120;
  const dragY = (toolbar?.y || 0) + 20;
  await page.mouse.move(dragX, dragY);
  await page.mouse.down();
  await page.mouse.move(dragX + 120, dragY + 36, { steps: 5 });
  await page.mouse.up();
  const moved = await dock.boundingBox();
  expect((moved?.x || 0) - (before?.x || 0)).toBeGreaterThan(80);
  // The enlarged dock may only have a few vertical pixels left before the
  // viewport clamp, but it must still follow the pointer within that room.
  expect((moved?.y || 0) - (before?.y || 0)).toBeGreaterThan(5);

  await page.reload();
  const restored = await page.getByTestId("review-dock").boundingBox();
  expect(Math.abs((restored?.x || 0) - (moved?.x || 0))).toBeLessThanOrEqual(2);
  expect(Math.abs((restored?.y || 0) - (moved?.y || 0))).toBeLessThanOrEqual(2);
  expect(Math.abs((restored?.height || 0) - (moved?.height || 0))).toBeLessThanOrEqual(2);
});

test("首次默认停靠不会冒充用户位置并能随视口保持左对齐", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd51");
  syntheticApi.tasks.push(task);
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`/review/${task.id}`);

  const dock = page.getByTestId("review-dock");
  const first = await dock.boundingBox();
  expect(first?.x).toBeLessThanOrEqual(24);
  expect(await page.evaluate(() => localStorage.getItem("wb_review_dock_place_v3"))).toBeNull();

  await page.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(async () => (await dock.boundingBox())?.x || 0).toBeLessThanOrEqual(24);
  await page.reload();
  const restored = await page.getByTestId("review-dock").boundingBox();
  expect(restored?.x).toBeLessThanOrEqual(24);
  expect(await page.evaluate(() => localStorage.getItem("wb_review_dock_place_v3"))).toBeNull();
});

test("收起后的 Dock 按可见尺寸拖到底部，不再保留展开态空气墙", async ({ page, syntheticApi }) => {
  const task = reviewTask("e5969b58cd52");
  syntheticApi.tasks.push(task);
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`/review/${task.id}`);

  const dock = page.getByTestId("review-dock");
  await dock.getByRole("button", { name: /收起/ }).click();
  await expect(dock).toHaveClass(/is-shut/);
  const toolbar = await dock.locator(".notes-toolbar").boundingBox();
  expect(toolbar).not.toBeNull();
  const dragX = (toolbar?.x || 0) + 18;
  const dragY = (toolbar?.y || 0) + 22;
  await page.mouse.move(dragX, dragY);
  await page.mouse.down();
  await page.mouse.move(dragX, 895, { steps: 8 });
  await page.mouse.up();

  const bottom = await dock.boundingBox();
  expect((bottom?.y || 0) + (bottom?.height || 0)).toBeGreaterThanOrEqual(891);
  expect((bottom?.y || 0) + (bottom?.height || 0)).toBeLessThanOrEqual(893);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("wb_review_dock_place_v3") || "{}"));
  expect(saved.top).toBeGreaterThan(800);

  await dock.getByRole("button", { name: /展开/ }).click();
  const reopened = await dock.boundingBox();
  expect((reopened?.y || 0) + (reopened?.height || 0)).toBeLessThanOrEqual(893);
});
