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
    points_mm: [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[1]],
      [bounds[2], bounds[3]],
      [bounds[0], bounds[3]],
    ],
    rectangular: true,
  };
}

type NetProposal = NonNullable<SyntheticMockup["structure_preview"]>["net_proposals"][number];

function netProposal(input: Omit<NetProposal, "schema" | "face_ids" | "closure_assemblies">): NetProposal {
  const top = input.cap_face_ids[0];
  const bottom = input.cap_face_ids[1];
  const attached = input.body_face_ids[0];
  const closure = (primary_face_id: string, side: -1 | 1): NetProposal["closure_assemblies"][number] => ({
    primary_face_id,
    side,
    extent: "full",
    closure_kind: "full",
    coverage_ratio: 1,
    members: [{
      face_id: primary_face_id,
      attached_body_face_id: attached,
      extent: "full",
      coverage_ratio: 1,
    }],
  });
  return {
    ...input,
    schema: "box-net-proposal/3",
    face_ids: [...input.body_face_ids, ...input.cap_face_ids],
    valid_anchors: input.valid_anchors || input.body_face_ids.map((front_face_id) => ({
      front_face_id,
      quarter_turns: [0],
      preferred_quarter_turns: 0,
    })),
    closure_assemblies: [closure(top, -1), closure(bottom, 1)],
  };
}

test("无显式语义时管理员可多选本稿候选层并重跑同一打样单", async ({ page, syntheticApi }) => {
  await page.setViewportSize({ width: 1366, height: 700 });
  const cutId = "proposal-layer-1111111111111111";
  const creaseId = "proposal-layer-2222222222222222";
  const mockup: SyntheticMockup = {
    id: "abcdef123455",
    title: "旧稿候选层",
    status: "review_required",
    job_status: "waiting_input",
    structure_status: "review_required",
    structure_code: "structure_semantics_missing",
    files: [],
    structure_input: {
      schema: "packaging-structure-input-candidates/2",
      image_url: ARTWORK,
      proposal_layers: [
        { id: cutId, name: "刀线", stroke_only_path_count: 24 },
        { id: creaseId, name: "折线", stroke_only_path_count: 12 },
      ],
      selected_ids: [],
      truncated: false,
      preview: {
        schema: "illustrator-layer-preview/1",
        page_size_points: [160, 90],
        layers: [
          {
            candidate_id: cutId,
            paths: [{
              closed: false,
              points: [
                [10, 20, 10, 20, 10, 20],
                [140, 20, 140, 20, 140, 20],
              ],
            }],
            truncated: false,
          },
          {
            candidate_id: creaseId,
            paths: [{
              closed: false,
              points: [
                [80, 10, 80, 10, 80, 10],
                [80, 80, 80, 80, 80, 80],
              ],
            }],
            truncated: false,
          },
        ],
      },
    },
  };
  syntheticApi.mockups.push(mockup);

  await page.goto(`/mockup/${mockup.id}`);

  await expect(page.getByText("请选择真实结构线所在图层")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "三步完成结构确认" })).toBeVisible();
  await page.getByRole("button", { name: "开始选择" }).click();
  await expect(page.getByRole("dialog", { name: "三步完成结构确认" })).toHaveCount(0);
  await expect(page.getByText(/系统不会按颜色、白色区域或图层名称判断结构/)).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(2);
  const cut = page.getByText("刀线", { exact: true });
  await cut.hover();
  await expect(page.locator(`[data-candidate-id="${cutId}"] .structure-input-layer-stroke`)).toHaveAttribute(
    "d",
    "M 10 20 L 140 20",
  );
  const submit = page.getByRole("button", { name: "重新识别完整盒型" });
  await expect(submit).toBeDisabled();
  await cut.click();
  await expect(page.locator(`[data-candidate-id="${cutId}"].is-selected`)).toHaveCount(1);
  await page.getByText("折线", { exact: true }).click();
  await expect(submit).toBeEnabled();
  await page.getByRole("button", { name: "放大结构预览" }).click();
  await expect(page.getByText("150%", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "放大结构预览" }).click();
  await expect(page.getByText("200%", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "适应结构预览" }).click();
  await expect(page.getByText("100%", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "缩小结构预览" })).toBeDisabled();
  await expect(submit).toBeInViewport({ ratio: 1 });
  await submit.click();

  await expect(page.getByText("打样中", { exact: true }).first()).toBeVisible();
  const selection = syntheticApi.calls.find(
    (call) => call.method === "POST" && call.path === `/api/mockups/${mockup.id}/structure/input`,
  );
  expect(selection?.body).toEqual({ candidate_ids: [cutId, creaseId] });
});

test("旧单无分层预览仍可多选图层重跑", async ({ page, syntheticApi }) => {
  await page.setViewportSize({ width: 1366, height: 700 });
  const cutId = "proposal-layer-aaaaaaaaaaaaaaaa";
  const creaseId = "proposal-layer-bbbbbbbbbbbbbbbb";
  const mockup: SyntheticMockup = {
    id: "abcdef123454",
    title: "旧稿无快照",
    status: "review_required",
    job_status: "waiting_input",
    structure_status: "review_required",
    structure_code: "structure_semantics_missing",
    files: [],
    structure_input: {
      schema: "packaging-structure-input-candidates/2",
      image_url: ARTWORK,
      proposal_layers: [
        { id: cutId, name: "刀线", stroke_only_path_count: 24 },
        { id: creaseId, name: "折线", stroke_only_path_count: 12 },
      ],
      selected_ids: [],
      truncated: false,
    },
  };
  syntheticApi.mockups.push(mockup);

  await page.goto(`/mockup/${mockup.id}`);
  await page.getByRole("button", { name: "开始选择" }).click();
  await expect(page.getByText(/这份稿只有高清原稿预览/)).toBeVisible();
  await expect(page.getByRole("img", { name: "当前 Illustrator 稿件预览" })).toBeVisible();
  await page.getByText("刀线", { exact: true }).click();
  await page.getByRole("button", { name: "重新识别完整盒型" }).click();
  const selection = syntheticApi.calls.find(
    (call) => call.method === "POST" && call.path === `/api/mockups/${mockup.id}/structure/input`,
  );
  expect(selection?.body).toEqual({ candidate_ids: [cutId] });
});

test("截取后的分层预览仍显示安全截取说明", async ({ page, syntheticApi }) => {
  await page.setViewportSize({ width: 1366, height: 700 });
  const cutId = "proposal-layer-cccccccccccccccc";
  syntheticApi.mockups.push({
    id: "abcdef123453",
    title: "截取预览",
    status: "review_required",
    job_status: "waiting_input",
    structure_status: "review_required",
    structure_code: "structure_semantics_missing",
    files: [],
    structure_input: {
      schema: "packaging-structure-input-candidates/2",
      image_url: ARTWORK,
      proposal_layers: [{ id: cutId, name: "刀线", stroke_only_path_count: 24 }],
      selected_ids: [],
      truncated: false,
      preview: {
        schema: "illustrator-layer-preview/1",
        page_size_points: [160, 90],
        layers: [{
          candidate_id: cutId,
          paths: [{ closed: false, points: [[10, 20, 10, 20, 10, 20], [140, 20, 140, 20, 140, 20]] }],
          truncated: true,
        }],
      },
    },
  });

  await page.goto("/mockup/abcdef123453");
  await expect(page.getByText("预览已安全截取")).toBeVisible();
});

test("管理员只需看展开图、选择正面并生成，朝向由系统决定", async ({ page, syntheticApi }) => {
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
      net_proposals: [netProposal({
        id: "box-net-0001",
        body_face_ids: ["body-a", "body-b", "body-c", "body-d"],
        cap_face_ids: ["cap-top", "cap-bottom"],
        strip_axis: "x",
        bounds_mm: [10, 5, 110, 95],
        valid_anchors: [
          { front_face_id: "body-a", quarter_turns: [0, 2], preferred_quarter_turns: 0 },
          { front_face_id: "body-b", quarter_turns: [0, 2], preferred_quarter_turns: 2 },
          { front_face_id: "body-c", quarter_turns: [0, 2], preferred_quarter_turns: 0 },
          { front_face_id: "body-d", quarter_turns: [0, 2], preferred_quarter_turns: 0 },
        ],
      })],
    },
  };
  syntheticApi.mockups.push(mockup);

  await page.goto(`/mockup/${mockup.id}`);

  await expect(page.locator(".sidebar-version")).toHaveText("v0.0.0.0");
  await expect(page.locator(".account-copy > .account-name + .sidebar-version")).toHaveCount(1);
  await expect(page.getByText("先看展开图，再选产品正面")).toBeVisible();
  await expect(page.getByText("文字朝向", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/底面 .*高 .*mm/)).toHaveCount(0);
  await expect(page.locator(".structure-map g")).toHaveCount(6);
  await expect(page.locator(".structure-front-choices button")).toHaveCount(4);

  const startButton = page.locator(".structure-confirm-actions").getByRole("button", { name: "生成打样图" });
  await page.locator(".structure-front-choices").getByRole("button", { name: "B 面" }).click();
  await expect(page.locator(".structure-front-choices").getByRole("button", { name: "B 面" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.structure-map g[aria-label="选择 B 面作为产品正面"]')).toHaveAttribute("aria-pressed", "true");
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
      quarter_turns: 2,
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
      net_proposals: [netProposal({
        id: "box-net-0001",
        body_face_ids: ["body-a", "body-b", "body-c", "body-d"],
        cap_face_ids: ["cap-top", "cap-bottom"],
        strip_axis: "x",
      })],
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
  await page.locator(".structure-front-choices").getByRole("button", { name: "A 面" }).click();
  await page.getByRole("button", { name: "生成打样图" }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => attempts).toBe(1);
  releaseFirst();

  await expect(page.getByText("盒盖尺寸与盒身宽深不一致，不能形成闭合盒。")).toBeVisible();
  await expect(page.getByRole("button", { name: "生成打样图" })).toBeEnabled();
  await page.getByRole("button", { name: "生成打样图" }).click();
  await expect.poll(() => attempts).toBe(2);
  expect(pageErrors).toEqual([]);
});

test("多张展开图只显示视觉翻页，切换后清空上一张的正面", async ({ page, syntheticApi }) => {
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
        netProposal({
          id: "box-net-0001",
          body_face_ids: ["body-a", "body-b", "body-c", "body-d"],
          cap_face_ids: ["cap-top", "cap-bottom"],
          strip_axis: "x",
          dimensions_mm: { width: 30, depth: 20, height: 50 },
          valid_anchors: [
            { front_face_id: "body-a", quarter_turns: [0], preferred_quarter_turns: 0 },
            { front_face_id: "body-b", quarter_turns: [0], preferred_quarter_turns: 0 },
            { front_face_id: "body-c", quarter_turns: [0], preferred_quarter_turns: 0 },
            { front_face_id: "body-d", quarter_turns: [0], preferred_quarter_turns: 0 },
          ],
        }),
        netProposal({
          id: "box-net-0002",
          body_face_ids: ["body-d", "body-c", "body-b", "body-a"],
          cap_face_ids: ["cap-top", "cap-bottom"],
          strip_axis: "x",
          dimensions_mm: { width: 31, depth: 20, height: 50 },
          valid_anchors: [
            { front_face_id: "body-d", quarter_turns: [0, 2], preferred_quarter_turns: 2 },
            { front_face_id: "body-c", quarter_turns: [0, 2], preferred_quarter_turns: 2 },
            { front_face_id: "body-b", quarter_turns: [0, 2], preferred_quarter_turns: 2 },
            { front_face_id: "body-a", quarter_turns: [0, 2], preferred_quarter_turns: 2 },
          ],
        }),
      ],
    },
  };
  syntheticApi.mockups.push(mockup);
  await page.goto(`/mockup/${mockup.id}`);

  const startButton = page.getByRole("button", { name: "生成打样图" });
  await page.locator(".structure-front-choices").getByRole("button", { name: "B 面" }).click();
  await expect(startButton).toBeEnabled();

  await page.getByRole("button", { name: "下一张" }).click();

  await expect(page.getByText("第 2 张，共 2 张")).toBeVisible();
  await expect(page.getByText(/底面 .*高 .*mm/)).toHaveCount(0);
  await expect(startButton).toBeDisabled();
  await expect(page.locator(".structure-front-choices .ant-btn-primary")).toHaveCount(0);
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
      net_proposals: [netProposal({
        id: "box-net-0001",
        body_face_ids: ["body-a", "body-b", "body-c", "body-d"],
        cap_face_ids: ["cap-top", "cap-bottom"],
        strip_axis: "x",
      })],
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
  await expect(page.getByRole("button", { name: "生成打样图" })).toHaveCount(0);
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
      net_proposals: [netProposal({
        id: "box-net-0001",
        body_face_ids: bodyIds,
        cap_face_ids: capIds,
        strip_axis: "x",
      })],
    },
  };
  syntheticApi.mockups.push(mockup);

  await page.goto(`/mockup/${mockup.id}`);

  await expect(page.getByText(/原稿预览.*不可用，不能可靠判断正面/)).toBeVisible();
  await expect(page.locator(".structure-front-choices button")).toHaveCount(4);
  await expect(page.locator(".structure-front-choices button").first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "生成打样图" })).toBeDisabled();
});

test("非管理员可以查看展开图，但不能选择正面或生成", async ({ page, syntheticApi }) => {
  const mockup: SyntheticMockup = {
    id: "abcdef123462",
    title: "团队可见待确认单",
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
      net_proposals: [netProposal({
        id: "box-net-0001",
        body_face_ids: ["body-a", "body-b", "body-c", "body-d"],
        cap_face_ids: ["cap-top", "cap-bottom"],
        strip_axis: "x",
      })],
    },
  };
  syntheticApi.mockups.push(mockup);
  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      logged_in: true,
      display_name: "审稿员",
      open_id: "ou_reviewer",
      role: "reviewer",
      perms: ["read", "create", "delete"],
    }),
  }));

  await page.goto(`/mockup/${mockup.id}`);

  await expect(page.getByText("这单可以正常查看；只有管理员能选择产品正面并生成打样图。")).toBeVisible();
  await expect(page.locator(".structure-map")).toBeVisible();
  await expect(page.locator(".structure-front-choices button")).toHaveCount(4);
  await expect(page.locator(".structure-front-choices button").first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "生成打样图" })).toBeDisabled();
});

test("页面重新可见时刷新身份并立即撤销结构确认权限", async ({ page, syntheticApi }) => {
  const mockup: SyntheticMockup = {
    id: "abcdef123463",
    title: "权限即时收回",
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
      net_proposals: [netProposal({
        id: "box-net-0001",
        body_face_ids: ["body-a", "body-b", "body-c", "body-d"],
        cap_face_ids: ["cap-top", "cap-bottom"],
        strip_axis: "x",
      })],
    },
  };
  syntheticApi.mockups.push(mockup);
  let isAdmin = true;
  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      logged_in: true,
      display_name: isAdmin ? "管理员" : "审稿员",
      open_id: "ou_permission_refresh",
      role: isAdmin ? "admin" : "reviewer",
      perms: isAdmin ? ["read", "create", "delete", "confirm_structure"] : ["read", "create", "delete"],
    }),
  }));

  await page.goto(`/mockup/${mockup.id}`);
  const frontA = page.locator(".structure-front-choices").getByRole("button", { name: "A 面" });
  const generate = page.getByRole("button", { name: "生成打样图" });
  await frontA.click();
  await expect(generate).toBeEnabled();

  isAdmin = false;
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/auth/me"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await refreshed;

  await expect(page.getByText("这单可以正常查看；只有管理员能选择产品正面并生成打样图。")).toBeVisible();
  await expect(frontA).toBeDisabled();
  await expect(generate).toBeDisabled();
});
