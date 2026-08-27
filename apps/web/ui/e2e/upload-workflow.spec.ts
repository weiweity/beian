import { expect, installHeldUploadTransport, test } from "./fixtures";

const excelFile = { name: "review-e2e.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("synthetic excel") };
const pdfFile = { name: "review-e2e.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF synthetic") };
const aiFile = { name: "mockup-e2e.ai", mimeType: "application/postscript", buffer: Buffer.from("synthetic illustrator") };

test("上传区可用 Tab 聚焦，并用 Enter 和空格选择两份文件", async ({ page }) => {
  await page.goto("/reviewup/new");

  const excelWell = page.locator("label.upload-well").filter({ hasText: "Excel 确认单" });
  const pdfWell = page.locator("label.upload-well").filter({ hasText: "包装 PDF" });

  await page.getByRole("button", { name: "膜袋", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(excelWell).toBeFocused();

  const excelChooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await excelChooser).setFiles({ ...excelFile, name: "keyboard-e2e.xlsx" });
  await expect(excelWell).toContainText("keyboard-e2e.xlsx");

  await excelWell.focus();
  await page.keyboard.press("Tab");
  await expect(pdfWell).toBeFocused();

  const pdfChooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Space");
  await (await pdfChooser).setFiles({ ...pdfFile, name: "keyboard-e2e.pdf" });

  await expect(page.getByText("上传成功，可以开始对照")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始对照" })).toBeEnabled();
});

test("审稿上传拿到回执后，换台再回来仍显示待对照", async ({ page }) => {
  await page.goto("/reviewup/new");
  await page.getByLabel("Excel 确认单文件").setInputFiles(excelFile);
  await page.getByLabel("包装 PDF文件").setInputFiles(pdfFile);
  await expect(page.getByText("上传成功，可以开始对照")).toBeVisible();

  await page.getByRole("button", { name: "打样台" }).click();
  await expect(page.getByRole("heading", { name: "打样台" })).toBeVisible();
  await page.getByRole("button", { name: "审稿台" }).click();

  const pending = page.getByRole("button", { name: /review\s+e2e.*待对照/ });
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("待对照");
});

test("打样上传拿到回执后，换台再回来仍显示待打样", async ({ page }) => {
  await page.goto("/mockup/new");
  await page.getByLabel("平面稿文件").setInputFiles(aiFile);
  await expect(page.getByText("上传成功，可以开始打样")).toBeVisible();

  await page.getByRole("button", { name: "审稿台" }).click();
  await expect(page.getByRole("heading", { name: "审核单" })).toBeVisible();
  await page.getByRole("button", { name: "打样台" }).click();

  const pending = page.getByRole("button", { name: /mockup\s+e2e.*待打样/ });
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("待打样");
});

test("上传到 100% 后等待服务器回执，确认后才能开始对照", async ({ page, syntheticApi }) => {
  const releaseUpload = await installHeldUploadTransport(page, syntheticApi);
  await page.goto("/reviewup/new");
  await page.getByLabel("Excel 确认单文件").setInputFiles({ ...excelFile, name: "confirming-e2e.xlsx" });
  await page.getByLabel("包装 PDF文件").setInputFiles({ ...pdfFile, name: "confirming-e2e.pdf" });

  const progress = page.getByRole("progressbar", { name: "文件已传完，服务器正在确认" });
  await expect(progress).toBeVisible();
  await expect(progress).toHaveJSProperty("value", 100);
  await expect(page.getByRole("button", { name: "上传中" })).toBeDisabled();

  await releaseUpload();
  await expect(page.getByText("上传成功，可以开始对照")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始对照" })).toBeEnabled();
  await page.getByRole("button", { name: "开始对照" }).click();

  await expect(page).toHaveURL(/\/review\/c[0-9a-f]{11}$/);
  await expect(page.getByRole("heading", { name: "对照中" })).toBeVisible();
  const call = syntheticApi.calls.find((item) => item.method === "POST" && item.path === "/api/tasks/start");
  expect(call?.body).toMatchObject({ product_name: "confirming e2e" });
});

test("服务端已落盘但完成响应丢失时，按同一上传身份恢复开工", async ({
  page,
  syntheticApi,
}) => {
  syntheticApi.loseNextUploadResponse = true;
  await page.goto("/reviewup/new");
  await page.getByLabel("Excel 确认单文件").setInputFiles({ ...excelFile, name: "recover-e2e.xlsx" });
  await page.getByLabel("包装 PDF文件").setInputFiles({ ...pdfFile, name: "recover-e2e.pdf" });

  await expect(page.getByText("上传成功，可以开始对照")).toBeVisible();
  const receipt = syntheticApi.receipts.find((item) => item.kind === "compare");
  expect(receipt?.client_upload_id).toBeTruthy();
  const completeCalls = syntheticApi.calls.filter(
    (item) => item.method === "POST" && item.path === `/api/uploads/sessions/${receipt?.id}/complete`,
  ).length;
  const recoveredByList = syntheticApi.calls.some(
    (item) => item.method === "GET" && item.path === "/api/uploads",
  );
  expect(completeCalls >= 2 || recoveredByList).toBe(true);

  await page.getByRole("button", { name: "开始对照" }).click();
  await expect(page).toHaveURL(/\/review\/c[0-9a-f]{11}$/);
  const start = syntheticApi.calls.find((item) => item.method === "POST" && item.path === "/api/tasks/start");
  expect(start?.body).toMatchObject({ receipt: receipt?.id, product_name: "recover e2e" });
  expect(syntheticApi.receipts).toEqual([]);
});

test("回执生成后整页刷新，仍可开工且恢复页保留品名与包装面", async ({ page, syntheticApi }) => {
  await page.goto("/reviewup/new");
  await page.getByRole("button", { name: "膜袋", exact: true }).click();
  await page.getByLabel("Excel 确认单文件").setInputFiles({ ...excelFile, name: "reload-e2e.xlsx" });
  await page.getByLabel("包装 PDF文件").setInputFiles({ ...pdfFile, name: "reload-e2e.pdf" });
  await expect(page.getByText("上传成功，可以开始对照")).toBeVisible();

  const receipt = syntheticApi.receipts.find((item) => item.kind === "compare");
  expect(receipt?.id).toMatch(/^[0-9a-f]{12}$/);

  await page.getByRole("button", { name: "审稿台" }).click();
  await expect(page.getByRole("button", { name: /reload\s+e2e.*待对照/i })).toBeVisible();

  syntheticApi.calls.length = 0;
  await page.reload();
  const pending = page.getByRole("button", { name: /reload\s+e2e.*待对照/i });
  await expect(pending).toBeVisible();
  expect(syntheticApi.calls.some((item) => item.method === "GET" && item.path === "/api/uploads")).toBe(true);

  await pending.click();
  await expect(page.getByRole("dialog", { name: "开始对照这单？" })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "先不开始" }).click();
  await page.goto(`/reviewup/new?receipt=${receipt?.id}`);
  await expect(page).toHaveURL(new RegExp(`/reviewup/new\\?receipt=${receipt?.id}$`));
  await expect(page.getByText("上传成功，可以开始对照")).toBeVisible();
  await expect(page.getByLabel("品名")).toHaveValue("reload e2e");
  await expect(page.getByRole("button", { name: "膜袋", exact: true })).toHaveClass(/is-on/);
  await expect(page.locator(".upload-filechip-name").filter({ hasText: "reload-e2e.xlsx" })).toBeVisible();
  await expect(page.locator(".upload-filechip-name").filter({ hasText: "reload-e2e.pdf" })).toBeVisible();

  await page.getByRole("button", { name: "删除暂存" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "放弃上传" }).click();

  await expect(page).toHaveURL(/\/reviewup$/);
  await expect(page.getByText("已放弃这次上传，文件资源已释放。")).toBeVisible();
  expect(syntheticApi.receipts).toEqual([]);
  expect(
    syntheticApi.calls.some(
      (item) => item.method === "DELETE" && item.path === `/api/uploads/${receipt?.id}`,
    ),
  ).toBe(true);
});

test("审稿看板点暂停上传只进入续传页，不会误发开工请求", async ({ page, syntheticApi }) => {
  const excelBytes = excelFile.buffer.length;
  const pdfBytes = pdfFile.buffer.length;
  syntheticApi.uploads.push({
    id: "d00000000002",
    client_upload_id: "client-paused-board",
    product_name: "看板续传花盒",
    pack_surface: "carton",
    kind: "compare",
    created_at: "2026-08-26T08:00:00.000Z",
    bytes: excelBytes + pdfBytes,
    files: [
      { field: "excel", name: excelFile.name, bytes: excelBytes, received: Math.floor(excelBytes / 2) },
      { field: "pdf", name: pdfFile.name, bytes: pdfBytes, received: 0 },
    ],
  });

  await page.goto("/reviewup");
  const paused = page.getByRole("button", { name: /看板续传花盒.*待继续上传/ });
  await expect(paused).toBeVisible();
  await paused.click();

  await expect(page).toHaveURL(/\/reviewup\/new\?receipt=d00000000002$/);
  await expect(page.getByText(/请重新选择同一文件继续/)).toBeVisible();
  expect(
    syntheticApi.calls.some(
      (item) => item.method === "POST" && item.path === "/api/tasks/start",
    ),
  ).toBe(false);
});

test("整页刷新后可找回部分上传，重选同一对文件从服务器偏移续传", async ({
  page,
  syntheticApi,
}) => {
  const excelBytes = excelFile.buffer.length;
  const pdfBytes = pdfFile.buffer.length;
  syntheticApi.uploads.push({
    id: "d00000000001",
    client_upload_id: "client-paused-reload",
    product_name: "断点续传花盒",
    pack_surface: "carton",
    kind: "compare",
    created_at: "2026-08-26T08:00:00.000Z",
    bytes: excelBytes + pdfBytes,
    files: [
      { field: "excel", name: excelFile.name, bytes: excelBytes, received: Math.floor(excelBytes / 2) },
      { field: "pdf", name: pdfFile.name, bytes: pdfBytes, received: 0 },
    ],
  });

  await page.goto("/history");
  await expect(page.getByText("上传已暂停", { exact: true })).toBeVisible();
  const paused = page.getByRole("button", { name: "打开审稿台记录：断点续传花盒" });
  await expect(paused).toBeVisible();
  await paused.click();
  await expect(page).toHaveURL(/\/reviewup\/new\?receipt=d00000000001$/);
  await expect(page.getByText(/请重新选择同一文件继续/)).toBeVisible();

  await page.getByLabel("Excel 确认单文件").setInputFiles(excelFile);
  await page.getByLabel("包装 PDF文件").setInputFiles(pdfFile);
  await expect(page.getByText("上传成功，可以开始对照")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始对照" })).toBeEnabled();
  expect(syntheticApi.receipts.some((item) => item.id === "d00000000001")).toBe(true);
  expect(syntheticApi.uploads).toEqual([]);
});
