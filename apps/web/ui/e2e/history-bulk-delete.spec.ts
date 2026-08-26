import {
  completedMockup,
  completedTask,
  expect,
  runningTask,
  test,
} from "./fixtures";

test("历史记录可用 Tab 聚焦，并用 Enter 打开审稿单", async ({ page, syntheticApi }) => {
  const task = completedTask("eeeeeeeeeeee", "键盘打开审稿");
  syntheticApi.tasks.push(task);

  await page.goto("/history");
  const open = page.getByRole("button", { name: "打开审稿台记录：键盘打开审稿" });
  await expect(open).toBeVisible();

  await page.getByPlaceholder("结束日期").focus();
  await page.keyboard.press("Tab");
  await expect(open).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(`/review/${task.id}`);
});

test("历史批删跳过进行中记录，并保留删除失败的部分结果", async ({ page, syntheticApi }) => {
  const doneTask = completedTask("aaaaaaaaaaaa", "已签字审稿");
  const liveTask = runningTask("bbbbbbbbbbbb", "正在对照审稿");
  const doneMockup = completedMockup("cccccccccccc", "已出图打样");
  syntheticApi.tasks.push(doneTask, liveTask);
  syntheticApi.mockups.push(doneMockup);
  syntheticApi.failDeletes.add(`mockup:${doneMockup.id}`);

  await page.goto("/history");
  await page.getByRole("button", { name: /^编\s*辑$/ }).click();

  const doneTaskBox = page.getByRole("checkbox", { name: "选择 已签字审稿" });
  const liveTaskBox = page.getByRole("checkbox", { name: "选择 正在对照审稿" });
  const doneMockupBox = page.getByRole("checkbox", { name: "选择 已出图打样" });
  await expect(liveTaskBox).toBeDisabled();
  await doneTaskBox.check();
  await doneMockupBox.check();
  await expect(page.getByText("已选 2 条")).toBeVisible();

  const desktopViewport = page.viewportSize();
  const desktopToolbar = await page.locator(".history-bulkbar").boundingBox();
  expect(desktopViewport).not.toBeNull();
  expect(desktopToolbar).not.toBeNull();
  expect(Math.abs((desktopToolbar!.x + desktopToolbar!.width / 2) - desktopViewport!.width / 2)).toBeLessThan(3);

  await page.getByRole("button", { name: /^删\s*除$/ }).click();
  const desktopDialog = await page.getByRole("dialog").boundingBox();
  expect(desktopDialog).not.toBeNull();
  expect(Math.abs((desktopDialog!.x + desktopDialog!.width / 2) - desktopViewport!.width / 2)).toBeLessThan(3);
  expect(Math.abs((desktopDialog!.y + desktopDialog!.height / 2) - desktopViewport!.height / 2)).toBeLessThan(12);
  await page.getByRole("button", { name: "删除记录" }).click();

  await expect(page.getByText("已删除 1 条，1 条未删除")).toBeVisible();
  await expect(page.getByText("已签字审稿")).toHaveCount(0);
  await expect(page.getByText("已出图打样")).toBeVisible();
  await expect(page.getByText("正在对照审稿")).toBeVisible();
  expect(syntheticApi.tasks.map((item) => item.id)).toEqual([liveTask.id]);
  expect(syntheticApi.mockups.map((item) => item.id)).toEqual([doneMockup.id]);
});

test("窄屏可全选已结束记录，批量栏和删除提示保持视口居中", async ({ page, syntheticApi }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const doneTask = completedTask("dddddddddddd", "可全选审稿");
  const liveTask = runningTask("eeeeeeeeeeee", "不可选进行中审稿");
  const doneMockup = completedMockup("ffffffffffff", "可全选打样");
  syntheticApi.tasks.push(doneTask, liveTask);
  syntheticApi.mockups.push(doneMockup);

  await page.goto("/history");
  await page.getByRole("button", { name: /^编\s*辑$/ }).click();
  const selectAll = page.getByRole("checkbox", { name: "全选可删除记录" });
  await selectAll.check();
  await expect(page.getByRole("checkbox", { name: "选择 可全选审稿" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "选择 可全选打样" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "选择 不可选进行中审稿" })).toBeDisabled();
  await expect(page.getByText("已选 2 条")).toBeVisible();

  const toolbar = await page.locator(".history-bulkbar").boundingBox();
  expect(toolbar).not.toBeNull();
  expect(Math.abs((toolbar!.x + toolbar!.width / 2) - 375 / 2)).toBeLessThan(3);

  const bottomSelectAll = page.locator(".history-bulkbar").getByRole("checkbox", { name: "全选" });
  await bottomSelectAll.uncheck();
  await expect(page.getByText("已选 0 条")).toBeVisible();
  await bottomSelectAll.check();
  const typeFilter = page.getByRole("radiogroup", { name: "类型" });
  await typeFilter.getByText("审稿台", { exact: true }).click();
  await expect(page.getByText("已选 1 条")).toBeVisible();
  await typeFilter.getByText("全部", { exact: true }).click();
  await bottomSelectAll.check();
  doneTask.status = "comparing";
  doneTask.board = "comparing";
  doneTask.job_status = "running";
  await expect(page.getByText("已选 1 条")).toBeVisible({ timeout: 4_000 });
  await expect(page.getByRole("checkbox", { name: "选择 可全选审稿" })).toBeDisabled();
  await page.getByRole("button", { name: /^删\s*除$/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const modal = await dialog.boundingBox();
  expect(modal).not.toBeNull();
  expect(Math.abs((modal!.x + modal!.width / 2) - 375 / 2)).toBeLessThan(3);
  expect(Math.abs((modal!.y + modal!.height / 2) - 812 / 2)).toBeLessThan(12);
});

test("只有进行中记录时，页头和底部全选都不可用", async ({ page, syntheticApi }) => {
  syntheticApi.tasks.push(runningTask("abababababab", "只有进行中记录"));
  await page.goto("/history");
  await page.getByRole("button", { name: /^编\s*辑$/ }).click();

  await expect(page.getByRole("checkbox", { name: "全选可删除记录" })).toBeDisabled();
  await expect(page.locator(".history-bulkbar").getByRole("checkbox", { name: "全选" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^删\s*除$/ })).toBeDisabled();
});
