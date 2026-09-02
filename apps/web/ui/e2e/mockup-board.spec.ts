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

  const light = page.getByRole("slider", { name: "灯光" });
  await expect(light).toBeVisible();
  await expect(page.locator(".mockup-sheet-photo .mockup-sheet-frame img").first()).toHaveCSS(
    "filter",
    /contrast\(1\.12\).*brightness\(1\)/,
  );
  await light.fill("1.2");
  await expect(page.locator(".mockup-sheet-photo .mockup-sheet-frame img").first()).toHaveCSS(
    "filter",
    /brightness\(1\.2\)/,
  );

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

test("完成态打样单在三图下用印刷面读字并可放大", async ({ page, context, syntheticApi }) => {
  const mockup = completedMockup("9a9b9c9d9e9f", "高清印刷盒");
  mockup.files = [
    { key: "white_a", name: "正面与侧面.png" },
    { key: "white_b", name: "反面与侧面.png" },
    { key: "glb", name: "box.glb" },
    { key: "read_front", name: "panel_front.png" },
    { key: "read_back", name: "panel_back.png" },
  ];
  syntheticApi.mockups.push(mockup);
  const image = "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='1200'><rect width='800' height='1200' fill='white'/><text x='40' y='80' font-size='28'>8pt</text></svg>";
  for (const key of ["white_a", "white_b", "read_front", "read_back"]) {
    const pattern = new RegExp(`/api/mockups/${mockup.id}/files/${key}(?:\\?.*)?$`);
    await context.route(pattern, async (route) => {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: image });
    });
    await page.route(pattern, async (route) => {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: image });
    });
  }
  const glbPattern = new RegExp(`/api/mockups/${mockup.id}/files/glb(?:\\?.*)?$`);
  await page.route(glbPattern, async (route) => {
    await route.fulfill({ status: 200, contentType: "model/gltf-binary", body: "glTF" });
  });

  await page.goto(`/mockup/${mockup.id}`);

  const read = page.getByRole("region", { name: "印刷面读字" });
  await expect(page.getByText("不要用 GLB 读小字。")).toBeVisible();
  await expect(read.getByRole("heading", { name: "读字" })).toBeVisible();
  await expect(read.getByText("这单没有印刷面图。")).toHaveCount(0);
  await expect(read.getByRole("img", { name: "正面印刷面" })).toBeVisible();
  await expect(read.getByRole("img", { name: "反面印刷面" })).toBeVisible();
  await expect(page.getByRole("img", { name: "正面与侧面白底" })).toBeVisible();
  await expect(page.locator(".mockup-sheet-photos").getByRole("img", { name: /印刷面/ })).toHaveCount(0);
  await expect(read.getByRole("link", { name: "打开正面印刷面" })).toHaveAttribute(
    "href",
    `/api/mockups/${mockup.id}/files/read_front`,
  );
  await expect(read.getByRole("link", { name: "下载正面印刷面" })).toHaveAttribute(
    "href",
    `/api/mockups/${mockup.id}/files/read_front?download=1`,
  );
  await expect(read.getByRole("button", { name: "放大正面印刷面" })).toBeVisible();
  await read.getByRole("button", { name: "放大正面印刷面" }).click();
  await expect(read.locator(".mockup-read-zoom").first()).toHaveAttribute("style", /scale\(/);
  await read.getByRole("button", { name: "恢复正面印刷面 1 倍" }).click();
  await expect(read.locator(".mockup-read-zoom").first()).toHaveAttribute("style", /transform:\s*none/);
});

test("完成态打样单没有印刷面时提示重新打样，不用 GLB 读字", async ({ page, syntheticApi }) => {
  const mockup = completedMockup("aa11bb22cc33", "旧白底盒");
  mockup.files = [
    { key: "white_a", name: "正面与侧面.png" },
    { key: "glb", name: "box.glb" },
  ];
  syntheticApi.mockups.push(mockup);
  const image = "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='1200'><rect width='800' height='1200' fill='white'/></svg>";
  await page.route(new RegExp(`/api/mockups/${mockup.id}/files/white_a(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: image });
  });
  await page.route(new RegExp(`/api/mockups/${mockup.id}/files/glb(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ status: 200, contentType: "model/gltf-binary", body: "glTF" });
  });
  await page.goto(`/mockup/${mockup.id}`);

  const read = page.getByRole("region", { name: "印刷面读字" });
  await expect(read.getByText("这单没有印刷面图。重新打样后才会出现，不要用 GLB 读字。")).toBeVisible();
  await expect(read.getByRole("img")).toHaveCount(0);
  await expect(read.getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("img", { name: "正面与侧面白底" })).toBeVisible();
});

test("印刷面图损坏时隐藏原图和下载操作", async ({ page, syntheticApi }) => {
  const mockup = completedMockup("dd44ee55ff66", "坏印刷面盒");
  mockup.files = [{ key: "read_front", name: "panel_front.png" }];
  syntheticApi.mockups.push(mockup);
  await page.route(new RegExp(`/api/mockups/${mockup.id}/files/read_front(?:\\?.*)?$`), async (route) => {
    await route.fulfill({
      status: 415,
      contentType: "application/json",
      body: "{\"detail\":\"这张印刷面图坏了，不是 PNG。重新打样后才能读字。\"}",
    });
  });

  await page.goto(`/mockup/${mockup.id}`);

  const read = page.getByRole("region", { name: "印刷面读字" });
  await expect(read.getByText("这张印刷面图坏了，重新打样后才能读字。")).toBeVisible();
  await expect(read.getByRole("link")).toHaveCount(0);
  await expect(read.getByRole("button", { name: /印刷面/ })).toHaveCount(0);
});
