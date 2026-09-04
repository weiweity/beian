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
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText("已用机上的稿重新排队。")).toBeVisible();
  expect(
    syntheticApi.calls.some((call) => call.method === "POST" && call.path === `/api/mockups/${running.id}/retry`),
  ).toBeTruthy();
});

test("打样失败可重试同一份机上稿", async ({ page, syntheticApi }) => {
  const failed: SyntheticMockup = {
    id: "eeeeeeeeeeee",
    title: "失败可重试",
    status: "failed",
    job_status: "failed",
    error: "打样中断",
    created_at: "2026-08-27T01:25:00.000Z",
    owner: "魏炜",
    files: [],
  };
  syntheticApi.mockups.push(failed);
  await page.goto(`/mockup/${failed.id}`);
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText("打样中", { exact: true }).first()).toBeVisible();
  expect(
    syntheticApi.calls.some((call) => call.method === "POST" && call.path === `/api/mockups/${failed.id}/retry`),
  ).toBeTruthy();
});

test("结构待确认和不支持均显示可执行状态，不伪装成打样进度", async ({ page, syntheticApi }) => {
  const reviewRequired: SyntheticMockup = {
    id: "555555555555",
    title: "结构需要确认",
    status: "review_required",
    job_status: "waiting_input",
    structure_status: "review_required",
    structure_code: "structure_face_mapping_incomplete",
    structure_message: "请选择产品正面",
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
  ).toHaveText("待选正面");
  await expect(
    page.locator(".review-card").filter({ hasText: unsupported.title }).locator(".review-card-summary-state"),
  ).toHaveText("结构暂不支持");
});

test("完成态打样单可分开调产品和背景灯光，原图灯箱也能调", async ({ page, syntheticApi }) => {
  const mockup = completedMockup("7a7b7c7d7e7f", "高清白底图");
  mockup.files = [
    { key: "white_a", name: "正面与侧面.png" },
    { key: "white_b", name: "反面与侧面.png" },
  ];
  syntheticApi.mockups.push(mockup);
  const image = "<svg xmlns='http://www.w3.org/2000/svg' width='3000' height='3600'><rect width='3000' height='3600' fill='white'/></svg>";
  for (const key of ["white_a", "white_b"]) {
    const pattern = new RegExp(`/api/mockups/${mockup.id}/files/${key}(?:\\?.*)?$`);
    await page.route(pattern, async (route) => {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: image });
    });
  }

  await page.goto(`/mockup/${mockup.id}`);

  await expect(page.getByRole("button", { name: "调灯" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "产品灯光" })).toHaveCount(0);
  await page.locator(".mockup-backdrop-switch").getByText("白底", { exact: true }).click();
  await page.getByRole("button", { name: "调灯" }).click();
  const productLight = page.getByRole("slider", { name: "产品灯光" }).first();
  const backgroundLight = page.getByRole("slider", { name: "背景灯光" }).first();
  await expect(productLight).toBeVisible();
  await expect(backgroundLight).toBeVisible();
  await expect(page.locator(".mockup-sheet-photos [role='slider']")).toHaveCount(0);
  await expect(page.locator(".mockup-sheet-photo .mockup-sheet-frame img").first()).toHaveCSS(
    "filter",
    /contrast\(1\.04\).*brightness\(1\)/,
  );
  await productLight.fill("1.2");
  await expect(page.locator(".mockup-sheet-photo .mockup-sheet-frame img").first()).toHaveCSS(
    "filter",
    /brightness\(1\.2\)/,
  );
  await backgroundLight.fill("0.6");
  await expect(page.locator(".mockup-sheet-photo .mockup-sheet-frame").first()).toHaveCSS(
    "background-color",
    "rgb(143, 143, 143)",
  );

  const originalButtons = page.getByRole("button", { name: /打开.+原图/ });
  await expect(originalButtons).toHaveCount(2);
  await originalButtons.nth(0).click();
  const dialog = page.getByRole("dialog", { name: "正面 + 侧面原图" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("slider", { name: "产品灯光" })).toBeVisible();
  await expect(dialog.getByRole("slider", { name: "背景灯光" })).toBeVisible();
  await dialog.getByRole("slider", { name: "产品灯光" }).fill("0.8");
  await expect(page.locator(".mockup-sheet-photo .mockup-sheet-frame img").first()).toHaveCSS(
    "filter",
    /brightness\(0\.8\)/,
  );
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toHaveCount(0);
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
  await expect(shot.getByRole("button")).toHaveCount(0);
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
  const alert = page.locator(".mockup-print-alert");
  await expect(alert).toContainText("这单没有可用底稿，无法补生成。请重新打样。");
  const alertBox = await alert.boundingBox();
  const photosBox = await page.locator(".mockup-sheet-photos").boundingBox();
  expect(alertBox && photosBox && alertBox.y < photosBox.y).toBeTruthy();
  await expect(page.getByRole("button", { name: "补印刷面" })).toHaveCount(0);
  await expect(read.getByRole("img")).toHaveCount(0);
  await expect(read.getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("img", { name: "正面与侧面白底" })).toBeVisible();
});

test("缺印刷面且可补时点补印刷面后读字出现，看板仍已出图", async ({ page, syntheticApi }) => {
  const mockup = completedMockup("cc11dd22ee33", "可补印刷盒");
  mockup.files = [
    { key: "white_a", name: "正面与侧面.png" },
    { key: "white_b", name: "反面与侧面.png" },
    { key: "glb", name: "box.glb" },
  ];
  mockup.can_repair_print_faces = true;
  syntheticApi.mockups.push(mockup);
  const image = "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='1200'><rect width='800' height='1200' fill='white'/><text x='40' y='80' font-size='28'>8pt</text></svg>";
  for (const key of ["white_a", "white_b", "read_front", "read_back", "read_left", "read_right"]) {
    await page.route(new RegExp(`/api/mockups/${mockup.id}/files/${key}(?:\\?.*)?$`), async (route) => {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: image });
    });
  }
  await page.route(new RegExp(`/api/mockups/${mockup.id}/files/glb(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ status: 200, contentType: "model/gltf-binary", body: "glTF" });
  });
  await page.goto(`/mockup/${mockup.id}`);

  const alert = page.locator(".mockup-print-alert");
  await expect(alert).toContainText("缺少印刷面图。可从已保存底稿补生成，不会重新打样。");
  const photos = page.locator(".mockup-sheet-photos");
  const alertBox = await alert.boundingBox();
  const photosBox = await photos.boundingBox();
  expect(alertBox && photosBox && alertBox.y < photosBox.y).toBeTruthy();
  await expect(page.getByRole("button", { name: "补印刷面" })).toBeEnabled();
  await expect(page.getByText("打样中", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "补印刷面" }).click();
  await expect(page.locator(".mockup-print-alert")).toHaveCount(0);
  await expect(page.getByRole("img", { name: "正面印刷面" })).toBeVisible();
  expect(
    syntheticApi.calls.some((call) => call.method === "POST" && call.path === `/api/mockups/${mockup.id}/print-faces`),
  ).toBeTruthy();
  await expect(page.getByRole("heading", { name: mockup.title })).toBeVisible();
  await expect(page.locator(".wait-card")).toHaveCount(0);
});

test("已出图可重渲棚时点按钮保持已出图", async ({ page, syntheticApi }) => {
  const mockup = completedMockup("aa11bb22cc33", "可重渲棚盒");
  mockup.files = [
    { key: "white_a", name: "正面与侧面.png" },
    { key: "white_b", name: "反面与侧面.png" },
    { key: "glb", name: "box.glb" },
  ];
  mockup.can_relight_studio = true;
  syntheticApi.mockups.push(mockup);
  const image = "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='1200'><rect width='800' height='1200' fill='white'/></svg>";
  for (const key of ["white_a", "white_b"]) {
    await page.route(new RegExp(`/api/mockups/${mockup.id}/files/${key}(?:\\?.*)?$`), async (route) => {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: image });
    });
  }
  await page.route(new RegExp(`/api/mockups/${mockup.id}/files/glb(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ status: 200, contentType: "model/gltf-binary", body: "glTF" });
  });
  await page.goto(`/mockup/${mockup.id}`);
  await expect(page.getByRole("button", { name: "重渲棚" })).toBeEnabled();
  await page.getByRole("button", { name: "重渲棚" }).click();
  expect(
    syntheticApi.calls.some((call) => call.method === "POST" && call.path === `/api/mockups/${mockup.id}/relight`),
  ).toBeTruthy();
  await expect(page.locator(".wait-card")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: mockup.title })).toBeVisible();
});

test("点反面芯片滚到读字并高亮", async ({ page, syntheticApi }) => {
  const mockup = completedMockup("ee77ff001122", "读字芯片盒");
  mockup.files = [
    { key: "white_a", name: "正面与侧面.png" },
    { key: "read_front", name: "panel_front.png" },
    { key: "read_back", name: "panel_back.png" },
  ];
  syntheticApi.mockups.push(mockup);
  const image = "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='600'><rect width='400' height='600' fill='white'/></svg>";
  for (const key of ["white_a", "read_front", "read_back"]) {
    await page.route(new RegExp(`/api/mockups/${mockup.id}/files/${key}(?:\\?.*)?$`), async (route) => {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: image });
    });
  }
  await page.goto(`/mockup/${mockup.id}`);
  await page.getByRole("navigation", { name: "跳到印刷面" }).getByRole("button", { name: "反面" }).click();
  await expect(page.locator("#read-face-back")).toHaveClass(/is-highlight/);
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

test("有 ground 的已出图单走 canvas 成片，不显示 PPT，调灯默认收起", async ({ page, syntheticApi }) => {
  const mockup = completedMockup("ee11ff22aa33", "影棚花盒");
  mockup.files = [
    { key: "white_a", name: "front_right_white.png" },
    { key: "white_a_ground", name: "front_right_ground.png" },
    { key: "white_a_set", name: "front_right_set.png" },
    { key: "white_b", name: "back_left_white.png" },
    { key: "white_b_ground", name: "back_left_ground.png" },
    { key: "white_b_set", name: "back_left_set.png" },
    { key: "ppt", name: "deck.pptx" },
  ];
  syntheticApi.mockups.push(mockup);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  let fetchedSet = 0;
  for (const key of ["white_a", "white_a_ground", "white_a_set", "white_b", "white_b_ground", "white_b_set"]) {
    await page.route(new RegExp(`/api/mockups/${mockup.id}/files/${key}(?:\\?.*)?$`), async (route) => {
      if (key.endsWith("_set")) fetchedSet += 1;
      await route.fulfill({ status: 200, contentType: "image/png", body: png });
    });
  }

  await page.goto(`/mockup/${mockup.id}`);

  await expect(page.locator(".mockup-sheet-photos.is-grounded canvas").first()).toBeVisible();
  await expect(page.locator(".mockup-sheet-photos.is-grounded .mockup-sheet-frame img")).toHaveCount(0);
  await expect(page.locator(".mockup-sheet-hero")).toHaveCount(0);
  await expect(page.locator(".mockup-sheet-photos.is-grounded > *")).toHaveCount(3);
  await expect(page.locator(".mockup-sheet-photos [role='slider']")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "调灯" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "产品灯光" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "下载 PPT" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下载 PPT" })).toHaveCount(0);
  await expect(page.locator(".mockup-sheet-photos.is-grounded .mockup-sheet-frame").first()).toHaveCSS("aspect-ratio", /5\s*\/\s*6/);
  const switcher = page.locator(".mockup-backdrop-switch");
  await expect(switcher.getByText("白底", { exact: true })).toBeVisible();
  await expect(switcher.getByText("银底", { exact: true })).toBeVisible();
  await expect(switcher.getByText("白桌白墙", { exact: true })).toBeVisible();
  const postsBefore = syntheticApi.calls.filter((call) => call.method === "POST").length;
  await switcher.getByText("银底", { exact: true }).click();
  await expect(page.locator(".mockup-sheet-photos.is-grounded canvas").first()).toBeVisible();
  await expect(page.locator(".mockup-sheet-frame").first()).toHaveClass(/is-backdrop-silver/);
  expect(syntheticApi.calls.filter((call) => call.method === "POST").length).toBe(postsBefore);
  await switcher.getByText("白底", { exact: true }).click();
  await expect(page.locator(".mockup-sheet-frame").first()).toHaveClass(/is-backdrop-white/);
  await switcher.getByText("白桌白墙", { exact: true }).click();
  await expect(page.locator(".mockup-sheet-frame").first()).toHaveClass(/is-backdrop-white-set/);
  expect(syntheticApi.calls.filter((call) => call.method === "POST").length).toBe(postsBefore);
  expect(fetchedSet).toBeGreaterThan(0);
  await page.getByRole("button", { name: "调灯" }).click();
  await expect(page.getByRole("slider", { name: "产品灯光" })).toBeVisible();
  await page.getByRole("button", { name: /打开正面/ }).click();
  await expect(page.getByRole("dialog", { name: "正面 + 侧面原图" })).toBeVisible();
  await expect(page.locator(".mockup-still-lightbox-stage.is-studio-ground")).toBeVisible();
});

test("成片 set 损坏时仍走 canvas，不报白底图坏了", async ({ page, syntheticApi }) => {
  const mockup = completedMockup("ee11ff22aa35", "影棚坏棚景");
  mockup.files = [
    { key: "white_a", name: "front_right_white.png" },
    { key: "white_a_ground", name: "front_right_ground.png" },
    { key: "white_a_set", name: "front_right_set.png" },
  ];
  syntheticApi.mockups.push(mockup);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.route(new RegExp(`/api/mockups/${mockup.id}/files/white_a(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  await page.route(new RegExp(`/api/mockups/${mockup.id}/files/white_a_ground(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  await page.route(new RegExp(`/api/mockups/${mockup.id}/files/white_a_set(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
  });
  await page.goto(`/mockup/${mockup.id}`);
  await expect(page.locator(".mockup-sheet-photos.is-grounded canvas").first()).toBeVisible();
  await expect(page.getByText("这张白底图坏了，回到打样台重新打。")).toHaveCount(0);
});

test("成片 ground 损坏时隐藏原图和下载", async ({ page, syntheticApi }) => {
  const mockup = completedMockup("ee11ff22aa34", "影棚坏地面");
  mockup.files = [
    { key: "white_a", name: "front_right_white.png" },
    { key: "white_a_ground", name: "front_right_ground.png" },
  ];
  syntheticApi.mockups.push(mockup);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.route(new RegExp(`/api/mockups/${mockup.id}/files/white_a(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: png });
  });
  await page.route(new RegExp(`/api/mockups/${mockup.id}/files/white_a_ground(?:\\?.*)?$`), async (route) => {
    await route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
  });
  await page.goto(`/mockup/${mockup.id}`);
  const shot = page.locator(".mockup-sheet-photos.is-grounded .mockup-sheet-photo").first();
  await expect(shot.getByText("这张白底图坏了，回到打样台重新打。")).toBeVisible();
  await expect(shot.getByRole("button", { name: /原图|下载/ })).toHaveCount(0);
});

test("无 ground 的已出图单保持 CSS 滤镜、描边和 PPT", async ({ page, syntheticApi }) => {
  const mockup = completedMockup("bb22cc33dd44", "旧白底图");
  mockup.files = [
    { key: "white_a", name: "正面与侧面.png" },
    { key: "white_b", name: "反面与侧面.png" },
    { key: "ppt", name: "deck.pptx" },
  ];
  syntheticApi.mockups.push(mockup);
  const image = "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='400'><rect width='300' height='400' fill='white'/></svg>";
  for (const key of ["white_a", "white_b"]) {
    await page.route(new RegExp(`/api/mockups/${mockup.id}/files/${key}(?:\\?.*)?$`), async (route) => {
      await route.fulfill({ status: 200, contentType: "image/svg+xml", body: image });
    });
  }
  await page.goto(`/mockup/${mockup.id}`);
  await expect(page.locator(".mockup-sheet-photo .mockup-sheet-frame img").first()).toHaveCSS(
    "filter",
    /contrast\(1\.04\).*brightness\(1\)/,
  );
  await expect(page.getByRole("link", { name: "下载 PPT" })).toBeVisible();
  await expect(page.getByRole("button", { name: "调灯" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "产品灯光" })).toHaveCount(0);
  await expect(page.locator(".mockup-sheet-hero")).toHaveCount(0);
});
