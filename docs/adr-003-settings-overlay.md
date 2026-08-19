# ADR-003 本机设置覆盖层

日期：2026-08-19

## 决定

换人、换机器时，在网页「设置」里改外部 API 和本机路径。不要改代码，不要把密钥提交进 git。

覆盖顺序：`.env.*`（底）→ `data/settings.json` + `data/settings.secrets.json`（面）。  
空密钥表示「不改」。界面永远不回显密钥，只显示是否已填。

探测（飞书 / 百度 / Python / Blender / lark-cli）只在 TS 服务端跑。前端只提交探测 id。

## 不做

- 不把设置做成第三张台。
- 不在 `apps/web/ui` 里存密钥或调外部 API。
- 不把 `PORT` / `HOST` 放进设置页（改绑定必须重启进程）。
- 不把对照规则或 Blender 脚本搬进设置页。
