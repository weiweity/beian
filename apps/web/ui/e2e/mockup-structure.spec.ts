import { expect, test, type SyntheticMockup } from "./fixtures";

const ARTWORK =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='90'%3E%3Crect width='160' height='90' fill='%23fff4ee'/%3E%3Ctext x='42' y='48' font-size='12'%3EPRODUCT FRONT%3C/text%3E%3C/svg%3E";

function face(
  id: string,
  bounds: [number, number, number, number],
): NonNullable<SyntheticMockup["structure_preview"]>["faces"][number] {
  return {
    id,
    bounds_mm: bounds,
    centroid_mm: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
    size_mm: [bounds[2] - bounds[0], bounds[3] - bounds[1]],
    rectangular: true,
  };
}

test("完整盒型只让管理员确认正面和方向，并显示服务端版本", async ({ page, syntheticApi }) => {
  await page.setViewportSize({ width: 1366, height: 700 });
  const mockup: SyntheticMockup = {
    id: "abcdef123456",
    title: "合成六面盒",
    status: "review_required",
    job_status: "waiting_input",
    structure_status: "review_required",
    structure_code: "structure_face_mapping_incomplete",
    structure_message: "已识别完整盒型，请选择正面和朝向。",
    files: [],
    structure_preview: {
      page_size_mm: [160, 90],
      image_url: ARTWORK,
      faces: [
        face("body-a", [10, 25, 40, 75]),
        face("body-b", [40, 25, 60, 75]),
        face("body-c", [60, 25, 90, 75]),
        face("body-d", [90, 25, 110, 75]),
        face("cap-top", [10, 5, 40, 25]),
        face("cap-bottom", [10, 75, 40, 95]),
        face("nested-dimension-box", [14, 40, 24, 55]),
      ],
      net_proposals: [{
        id: "box-net-0001",
        face_ids: ["body-a", "body-b", "body-c", "body-d", "cap-top", "cap-bottom"],
        body_face_ids: ["body-a", "body-b", "body-c", "body-d"],
        cap_face_ids: ["cap-top", "cap-bottom"],
        strip_axis: "x",
        bounds_mm: [10, 5, 110, 95],
      }],
    },
  };
  syntheticApi.mockups.push(mockup);

  await page.goto(`/mockup/${mockup.id}`);

  await expect(page.locator(".sidebar-version")).toHaveText("v0.0.0.0");
  await expect(page.locator(".account-copy > .account-name + .sidebar-version")).toHaveCount(1);
  await expect(page.getByText("完整盒型已经找出，只需确认正面")).toBeVisible();
  await expect(page.locator(".structure-map g")).toHaveCount(6);
  await expect(page.locator(".structure-front-choices button")).toHaveCount(4);

  const startButton = page.locator(".structure-confirm-actions").getByRole("button", { name: "确认并开始打样" });
  await page.locator(".structure-front-choices").getByRole("button", { name: /候选 B/ }).click();
  await page.getByText("右转 90°", { exact: true }).click();
  await expect(startButton).toBeInViewport({ ratio: 1 });
  await startButton.click({ trial: true });
  await page.setViewportSize({ width: 1366, height: 640 });
  await expect(startButton).toBeInViewport({ ratio: 1 });
  await startButton.click({ trial: true });
  await startButton.click();

  await expect(page.getByText("打样中", { exact: true }).first()).toBeVisible();
  const confirmation = syntheticApi.calls.find(
    (call) => call.method === "POST" && call.path === `/api/mockups/${mockup.id}/structure`,
  );
  expect(confirmation?.body).toEqual({
    anchor: {
      proposal_id: "box-net-0001",
      front_face_id: "body-b",
      quarter_turns: 1,
    },
  });
});

test("结构确认失败留在原位给出可重试原因，不产生未处理 Promise", async ({ page, syntheticApi }) => {
  const mockup: SyntheticMockup = {
    id: "abcdef123460",
    title: "可恢复结构确认",
    status: "review_required",
    job_status: "waiting_input",
    structure_status: "review_required",
    files: [],
    structure_preview: {
      page_size_mm: [160, 90],
      image_url: ARTWORK,
      faces: [
        face("body-a", [10, 25, 40, 75]),
        face("body-b", [40, 25, 60, 75]),
        face("body-c", [60, 25, 90, 75]),
        face("body-d", [90, 25, 110, 75]),
        face("cap-top", [10, 5, 40, 25]),
        face("cap-bottom", [10, 75, 40, 95]),
      ],
      net_proposals: [{
        id: "box-net-0001",
        face_ids: ["body-a", "body-b", "body-c", "body-d", "cap-top", "cap-bottom"],
        body_face_ids: ["body-a", "body-b", "body-c", "body-d"],
        cap_face_ids: ["cap-top", "cap-bottom"],
        strip_axis: "x",
      }],
    },
  };
  syntheticApi.mockups.push(mockup);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let attempts = 0;
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route(`**/api/mockups/${mockup.id}/structure`, async (route) => {
    attempts += 1;
    if (attempts === 1) await firstPending;
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ detail: "盒盖尺寸与盒身宽深不一致，不能形成闭合盒。" }),
    });
  });
  await page.goto(`/mockup/${mockup.id}`);
  await page.locator(".structure-front-choices").getByRole("button", { name: /候选 A/ }).click();
  await page.getByRole("button", { name: "确认并开始打样" }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => attempts).toBe(1);
  releaseFirst();

  await expect(page.getByText("盒盖尺寸与盒身宽深不一致，不能形成闭合盒。")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认并开始打样" })).toBeEnabled();
  await page.getByRole("button", { name: "确认并开始打样" }).click();
  await expect.poll(() => attempts).toBe(2);
  expect(pageErrors).toEqual([]);
});

test("切换完整盒型时清空上一方案的正面和方向", async ({ page, syntheticApi }) => {
  const mockup: SyntheticMockup = {
    id: "abcdef123461",
    title: "多盒型候选",
    status: "review_required",
    job_status: "waiting_input",
    structure_status: "review_required",
    files: [],
    structure_preview: {
      page_size_mm: [160, 90],
      image_url: ARTWORK,
      faces: [
        face("body-a", [10, 25, 40, 75]),
        face("body-b", [40, 25, 60, 75]),
        face("body-c", [60, 25, 90, 75]),
        face("body-d", [90, 25, 110, 75]),
        face("cap-top", [10, 5, 40, 25]),
        face("cap-bottom", [10, 75, 40, 95]),
      ],
      net_proposals: [
        {
          id: "box-net-0001",
          face_ids: ["body-a", "body-b", "body-c", "body-d", "cap-top", "cap-bottom"],
          body_face_ids: ["body-a", "body-b", "body-c", "body-d"],
          cap_face_ids: ["cap-top", "cap-bottom"],
          strip_axis: "x",
          dimensions_mm: { width: 30, depth: 20, height: 50 },
          valid_anchors: [
            { front_face_id: "body-a", quarter_turns: [0, 1] },
            { front_face_id: "body-b", quarter_turns: [0, 1] },
            { front_face_id: "body-c", quarter_turns: [0, 1] },
            { front_face_id: "body-d", quarter_turns: [0, 1] },
          ],
        },
        {
          id: "box-net-0002",
          face_ids: ["body-d", "body-c", "body-b", "body-a", "cap-top", "cap-bottom"],
          body_face_ids: ["body-d", "body-c", "body-b", "body-a"],
          cap_face_ids: ["cap-top", "cap-bottom"],
          strip_axis: "x",
          dimensions_mm: { width: 31, depth: 20, height: 50 },
          valid_anchors: [
            { front_face_id: "body-d", quarter_turns: [0, 2] },
            { front_face_id: "body-c", quarter_turns: [0, 2] },
            { front_face_id: "body-b", quarter_turns: [0, 2] },
            { front_face_id: "body-a", quarter_turns: [0, 2] },
          ],
        },
      ],
    },
  };
  syntheticApi.mockups.push(mockup);
  await page.goto(`/mockup/${mockup.id}`);

  const startButton = page.getByRole("button", { name: "确认并开始打样" });
  await page.locator(".structure-front-choices").getByRole("button", { name: /候选 B/ }).click();
  await page.getByText("右转 90°", { exact: true }).click();
  await expect(startButton).toBeEnabled();

  await page.locator(".structure-anchor-field .ant-select").click();
  await page.getByText("盒型方案 2 · 底面 31×20 · 高 50 mm", { exact: true }).click();

  await expect(startButton).toBeDisabled();
  await expect(page.locator(".structure-front-choices .ant-btn-primary")).toHaveCount(0);
  await expect(page.locator(".structure-anchor-field .ant-segmented-item-selected")).toContainText("不旋转");
});

test("非法结构锚点被拒绝且待确认任务保持原状", async ({ page, syntheticApi }) => {
  const mockup: SyntheticMockup = {
    id: "abcdef123459",
    title: "拒绝非法结构锚点",
    status: "review_required",
    job_status: "waiting_input",
    structure_status: "review_required",
    files: [],
    structure_preview: {
      page_size_mm: [160, 90],
      image_url: ARTWORK,
      faces: [
        face("body-a", [10, 25, 40, 75]),
        face("body-b", [40, 25, 60, 75]),
        face("body-c", [60, 25, 90, 75]),
        face("body-d", [90, 25, 110, 75]),
        face("cap-top", [10, 5, 40, 25]),
        face("cap-bottom", [10, 75, 40, 95]),
      ],
      net_proposals: [{
        id: "box-net-0001",
        face_ids: ["body-a", "body-b", "body-c", "body-d", "cap-top", "cap-bottom"],
        body_face_ids: ["body-a", "body-b", "body-c", "body-d"],
        cap_face_ids: ["cap-top", "cap-bottom"],
        strip_axis: "x",
      }],
    },
  };
  syntheticApi.mockups.push(mockup);
  await page.goto(`/mockup/${mockup.id}`);

  const response = await page.evaluate(async (id) => {
    const result = await fetch(`/api/mockups/${id}/structure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        anchor: {
          proposal_id: "box-net-0001",
          front_face_id: "cap-top",
          quarter_turns: 4,
        },
      }),
    });
    return { status: result.status, body: await result.json() };
  }, mockup.id);

  expect(response.status).toBe(400);
  expect(response.body).toEqual({ detail: "合成结构锚点不完整" });
  expect(mockup.status).toBe("review_required");
  expect(mockup.job_status).toBe("waiting_input");
  expect(mockup.structure_status).toBe("review_required");
});

test("旧版零散候选不会退回逐面猜测", async ({ page, syntheticApi }) => {
  const mockup: SyntheticMockup = {
    id: "abcdef123457",
    title: "旧版零散候选",
    status: "review_required",
    job_status: "waiting_input",
    structure_status: "review_required",
    structure_code: "structure_face_mapping_incomplete",
    files: [],
    structure_preview: {
      page_size_mm: [160, 90],
      image_url: ARTWORK,
      faces: [
        face("legacy-a", [10, 25, 40, 75]),
        face("legacy-b", [40, 25, 60, 75]),
        face("legacy-c", [60, 25, 90, 75]),
        face("legacy-d", [90, 25, 110, 75]),
        face("legacy-e", [10, 5, 40, 25]),
        face("legacy-f", [10, 75, 40, 95]),
      ],
      net_proposals: [],
    },
  };
  syntheticApi.mockups.push(mockup);

  await page.goto(`/mockup/${mockup.id}`);

  await expect(page.getByText("这单需要重新识别结构")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认并开始打样" })).toHaveCount(0);
});

test("没有原稿预览时完整盒型也不能盲选正面", async ({ page, syntheticApi }) => {
  const bodyIds = ["body-a", "body-b", "body-c", "body-d"] as [string, string, string, string];
  const capIds = ["cap-top", "cap-bottom"] as [string, string];
  const mockup: SyntheticMockup = {
    id: "abcdef123458",
    title: "缺少原稿预览",
    status: "review_required",
    job_status: "waiting_input",
    structure_status: "review_required",
    files: [],
    structure_preview: {
      page_size_mm: [160, 90],
      faces: [
        face(bodyIds[0], [10, 25, 40, 75]),
        face(bodyIds[1], [40, 25, 60, 75]),
        face(bodyIds[2], [60, 25, 90, 75]),
        face(bodyIds[3], [90, 25, 110, 75]),
        face(capIds[0], [10, 5, 40, 25]),
        face(capIds[1], [10, 75, 40, 95]),
      ],
      net_proposals: [{
        id: "box-net-0001",
        face_ids: [...bodyIds, ...capIds],
        body_face_ids: bodyIds,
        cap_face_ids: capIds,
        strip_axis: "x",
      }],
    },
  };
  syntheticApi.mockups.push(mockup);

  await page.goto(`/mockup/${mockup.id}`);

  await expect(page.getByText(/原稿预览.*不可用，不能可靠判断正面/)).toBeVisible();
  await expect(page.locator(".structure-front-choices button")).toHaveCount(4);
  await expect(page.locator(".structure-front-choices button").first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "确认并开始打样" })).toBeDisabled();
});
