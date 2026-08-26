import { expect, reviewTask, test } from "./fixtures";

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

  await page.getByRole("button", { name: "全屏核对" }).click();
  await expect(page.getByRole("button", { name: "退出全屏" })).toBeVisible();
  expect(await dock.evaluate((node) => node.parentElement?.getAttribute("data-testid"))).toBe("review-root");

  await page.getByRole("button", { name: "退出全屏" }).click();
  await expect(page.getByRole("button", { name: "全屏核对" })).toBeVisible();
  expect(await dock.evaluate((node) => node.parentElement === document.body)).toBe(true);

  await page.getByRole("button", { name: /^有\s*错$/ }).click();
  await expect.poll(() => syntheticApi.calls.filter((item) => item.path.endsWith("/decision")).length).toBe(1);
  await page.getByLabel("结论").fill("中文品名需要设计改稿");
  await page.getByRole("button", { name: "签字并待设计改稿" }).click();

  await expect(page.getByText("已签字，不是系统过审")).toBeVisible();
  const decisionCall = syntheticApi.calls.find((item) => item.path.endsWith("/decision"));
  const completeCall = syntheticApi.calls.find((item) => item.path.endsWith("/complete"));
  expect(decisionCall?.body).toMatchObject({ hit_id: "hit_name", decision: "issue" });
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
