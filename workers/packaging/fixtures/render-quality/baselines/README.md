# RF-00 现状回归基线（Mac 合成）

`rf00-current.json` 于 2026-09-08 经项目用户在本轮对话回复“开始推进”批准冻结；批准范围为当前 legacy 生产默认身份的 **Mac 合成回归锚**。

- 身份：compat-legacy-v0 / legacy-closed-box-v0 / Standard / minimum-floor-v1；3000×3600；Blender 5.2.0 LTS；完整依赖和源码哈希见 JSON。
- 夹具：六个矩形盒，另一个圆柱明确不支持、未渲染。
- PNG 回归比较 decoded pixel_sha256；PNG 文件 SHA 仅保留为归档完整性证据。GLB 文件 SHA 和现有结构化度量仍精确比较；没有新增审美容差带。
- 本基线不适用于 Windows 验收、真实稿、真实感验收、L2、UAT 或资源预算。人工视觉验收仍 pending，production_ready 仍 false；未切换产品默认。
- 基线生成前修正了评测器同时比较 PNG 文件哈希导致元数据误报的问题，随后按新评测器身份重新渲染整套夹具。未把旧报告改哈希后冒充新采集。
- 原始证据在仓库外 `beian-evidence/2026-09-08-f01-q01-implementation/q01-current-capture/`，源报告 SHA-256：`517a919f2a0c2d0c38aff307ac78e4e1f75d780e97065bfa090cf408357edb1b`。
- 普通评测不带更新选项，保持基线只读；本轮已验证只读评测不改写，并通过像素变化拒绝及 PNG 元数据差异接受检查。该只读评测未再次启动 Blender，不等于第二次原生全套复测。
- 更改评测器/渲染身份、依赖或夹具后，旧基线会失配，必须重新评审、批准和显式采集，不能自动覆盖以消除告警。
