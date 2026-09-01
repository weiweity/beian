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
    await expect(card.locator(".review-card-summary-state")).toHaveCSS("white-space", "normal");
    await expect(card.locator(".review-card-summary-state")).toHaveCSS("overflow-wrap", "anywhere");
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

test("完成态打样单可在新窗口打开两张内联原图", async ({ page, context, syntheticApi }) => {
  const mockup = completedMockup("7a7b7c7d7e7f", "高清白底图");
  mockup.files = [
    { key: "white_a", name: "正面与侧面.png" },
    { key: "white_b", name: "反面与侧面.png" },
  ];
  syntheticApi.mockups.push(mockup);
  const image = "<svg xmlns='http://www.w3.org/2000/svg' width='3000' height='3600'><rect width='3000' height='3600' fill='white'/></svg>";
  for (const key of ["white_a", "white_b"]) {
    const pattern = new RegExp(`/api/mockups/${mockup.id}/files/${key}(?:\\?.*)?$`);
    await context.route(pattern, async (route) => {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: image });
    });
    await page.route(pattern, async (route) => {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: image });
    });
  }

  await page.goto(`/mockup/${mockup.id}`);

  const originalLinks = page.getByRole("link", { name: /打开.+原图/ });
  await expect(originalLinks).toHaveCount(2);
  await expect(originalLinks.nth(0)).toHaveAttribute("href", `/api/mockups/${mockup.id}/files/white_a`);
  await expect(originalLinks.nth(0)).toHaveAttribute("target", "_blank");
  await expect(originalLinks.nth(0)).toHaveAttribute("rel", "noreferrer");
  await expect(originalLinks.nth(1)).toHaveAttribute("href", `/api/mockups/${mockup.id}/files/white_b`);

  const [popup] = await Promise.all([page.waitForEvent("popup"), originalLinks.nth(0).click()]);
  await popup.waitForLoadState();
  expect(new URL(popup.url()).pathname).toBe(`/api/mockups/${mockup.id}/files/white_a`);
  expect(new URL(popup.url()).search).toBe("");
  await expect(popup.locator("svg")).toBeVisible();
});

test("白底图损坏时隐藏原图和下载操作", async ({ page, syntheticApi }) => {
  const mockup = completedMockup("8a8b8c8d8e8f", "损坏白底图");
  mockup.files = [{ key: "white_a", name: "损坏.png" }];
  syntheticApi.mockups.push(mockup);
  await page.route(new RegExp(`/api/mockups/${mockup.id}/files/white_a(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
  });

  await page.goto(`/mockup/${mockup.id}`);

  const shot = page.locator(".mockup-sheet-photo").filter({
    has: page.getByText("正面 + 侧面", { exact: true }),
  });
  await expect(shot.getByText("这张白底图坏了，回到打样台重新打。")).toBeVisible();
  await expect(shot.getByRole("link")).toHaveCount(0);
});
