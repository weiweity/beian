import {
  completedTask,
  expect,
  reviewTask,
  runningTask,
  test,
  type SyntheticTask,
} from "./fixtures";

test("审稿台四栏用一行品名和进度或状态，日期单独落在底部", async ({ page, syntheticApi }) => {
  const running = runningTask("111111111111", "对照百分比产品");
  const runningWithoutStage = runningTask("555555555555", "无阶段对照产品");
  delete runningWithoutStage.job_stage_label;
  const failed: SyntheticTask = {
    ...runningTask("222222222222", "对照失败产品"),
    status: "compare_failed",
    board: "failed",
    job_status: "failed",
  };
  const review = reviewTask("333333333333");
  review.product_name = "待审核产品";
  review.title = "待审核产品";
  const done = completedTask("444444444444", "已签字产品");
  syntheticApi.tasks.push(running, runningWithoutStage, failed, review, done);

  await page.goto("/reviewup");

  const cases = [
    ["对照中", "对照百分比产品", "55% · 认字"],
    ["对照失败", "对照失败产品", "对照失败"],
    ["待审核", "待审核产品", "待审核"],
    ["已签字", "已签字产品", "已签字"],
  ] as const;
  for (const [columnTitle, product, state] of cases) {
    const column = page.locator(".review-col").filter({
      has: page.locator(".review-col-head").getByText(columnTitle, { exact: true }),
    });
    const card = column.locator(".review-card").filter({ hasText: product });
    await expect(card.locator(".review-card-summary")).toContainText(product);
    await expect(card.locator(".review-card-summary-state")).toHaveText(state);
    await expect(card.locator(".review-card-time")).toContainText("2026-08-26");
    await expect(card.locator(".review-card-top")).toHaveCount(0);
  }

  const genericRunning = page.locator(".review-card").filter({ hasText: "无阶段对照产品" });
  await expect(genericRunning.locator(".review-card-summary-state")).toHaveText("正在对照 · 大约还要 40 秒");
  await expect(genericRunning.locator(".review-card-time")).toContainText("2026-08-26");

  await page.locator(".review-card").filter({ hasText: "对照百分比产品" }).click();
  await expect(page).toHaveURL(`/review/${running.id}`);
});
