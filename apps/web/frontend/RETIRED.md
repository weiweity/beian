# 已退役

这里是迁栈前的原生 JS 页。`GET /` 现在由 `apps/web/ui` 构建、`apps/web/server` 挂载。

不要再改 `static/app.js`。新功能写在 `apps/web/ui` 和 `apps/web/server`。

已退役、冻结、不得新增功能。验收入口是 `:8787`（Hono），不是本目录。
