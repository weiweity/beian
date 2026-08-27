import { completedMockup, expect, test, type SyntheticMockup } from "./fixtures";

test("打样台与审稿台共用一行品名状态和底部日期", async ({ page, syntheticApi }) => {
  const running: SyntheticMockup = {
    id: "111111111111",
    title: "文案 达肤妍海葡萄油萃微珠保湿喷雾",
    status: "running",
    job_status: "running",
    job_stage: "blender",
    job_stage_label: "打样",
    created_at: "2026-08-27T01:21:00.000Z",
    owner: "魏炜",
    files: [],
  };
  const failed: SyntheticMockup = {
    id: "222222222222",
    title: "紧颜抗皱胶原棒 花盒 26F23A",
    status: "failed",
    created_at: "2026-08-27T01:18:00.000Z",
    owner: "魏炜",
    files: [],
  };
  const done = completedMockup("333333333333", "光感透润胶原棒 花盒 26F23A");
  done.created_at = "2026-08-27T01:16:00.000Z";
  syntheticApi.mockups.push(running, failed, done);

  await page.goto("/mockup");

  const cases = [
    ["打样中", running.title, "70% · 打样"],
    ["打样失败", failed.title, "打样中断"],
    ["已出图", done.title, "已出图"],
  ] as const;
  for (const [columnTitle, product, state] of cases) {
    const column = page.locator(".review-col").filter({
      has: page.locator(".review-col-head").getByText(columnTitle, { exact: true }),
    });
    const card = column.locator(".review-card").filter({ hasText: product });
    await expect(card.locator(".review-card-name")).toHaveAttribute("title", product);
    await expect(card.locator(".review-card-summary-state")).toHaveText(state);
    await expect(card.locator(".review-card-time")).toContainText("2026-08-27");
    await expect(card.locator(".review-card-top")).toHaveCount(0);
  }
});

test("打样台轮询真实阶段百分比并可点进打样单", async ({ page, syntheticApi }) => {
  const running: SyntheticMockup = {
    id: "444444444444",
    title: "六面语义盒",
    status: "running",
    job_status: "running",
    job_stage: "render_pdf",
    job_stage_label: "出图",
    created_at: "2026-08-27T01:22:00.000Z",
    owner: "魏炜",
    files: [],
  };
  syntheticApi.mockups.push(running);
  await page.goto("/mockup");

  const card = page.locator(".review-card").filter({ hasText: running.title });
  await expect(card.locator(".review-card-summary-state")).toHaveText("35% · 出图");

  running.job_stage = "export";
  running.job_stage_label = "导出";
  await expect(card.locator(".review-card-summary-state")).toHaveText("90% · 导出", { timeout: 5_000 });

  await card.click();
  await expect(page).toHaveURL(`/mockup/${running.id}`);
  await expect(page.getByText("打样中", { exact: true }).first()).toBeVisible();
});

test("结构待确认和不支持均显示可执行状态，不伪装成打样进度", async ({ page, syntheticApi }) => {
  const reviewRequired: SyntheticMockup = {
    id: "555555555555",
    title: "结构需要确认",
    status: "review_required",
    job_status: "waiting_input",
    structure_status: "review_required",
    structure_code: "structure_role_ambiguous",
    structure_message: "有两个面角色需要管理员确认",
    created_at: "2026-08-27T01:23:00.000Z",
    files: [],
  };
  const unsupported: SyntheticMockup = {
    id: "666666666666",
    title: "暂不支持的袋型",
    status: "unsupported",
    job_status: "failed",
    structure_status: "unsupported",
    structure_code: "structure_schema_unsupported",
    structure_message: "当前仅支持闭合纸盒",
    created_at: "2026-08-27T01:24:00.000Z",
    files: [],
  };
  syntheticApi.mockups.push(reviewRequired, unsupported);
  await page.goto("/mockup");

  await expect(
    page.locator(".review-card").filter({ hasText: reviewRequired.title }).locator(".review-card-summary-state"),
  ).toHaveText("待确认结构");
  await expect(
    page.locator(".review-card").filter({ hasText: unsupported.title }).locator(".review-card-summary-state"),
  ).toHaveText("结构暂不支持");
});
