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

  await page.getByRole("button", { name: /^删\s*除$/ }).click();
  await page.getByRole("button", { name: "删除记录" }).click();

  await expect(page.getByText("已删除 1 条，1 条未删除")).toBeVisible();
  await expect(page.getByText("已签字审稿")).toHaveCount(0);
  await expect(page.getByText("已出图打样")).toBeVisible();
  await expect(page.getByText("正在对照审稿")).toBeVisible();
  expect(syntheticApi.tasks.map((item) => item.id)).toEqual([liveTask.id]);
  expect(syntheticApi.mockups.map((item) => item.id)).toEqual([doneMockup.id]);
});
