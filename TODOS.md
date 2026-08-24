# TODOS

由 /autoplan（2026-08-18）从 SELECTIVE EXPANSION 推迟项写入。不是 8/31 主路径。

## P2 — 评测与止损

- [ ] **金标人核**  
  试验记录仍是空表。`gold-v0` 自动导出未人工核定。  
  至少 1 组已知正错样本：漏标 / 误报 / 待人工确认。  
  若她认为不比分屏少漏：停止「生产级远程工作台」叙事。

- [ ] **采用止损**  
  若无辅导真稿后她仍左右分屏，或第二周不再主动开单：撤销后续 3D 投入，改飞书发报告。

## P2 — 资产与合规

- [ ] **真稿出境书面许可**  
  百度 OCR / MiniMax 处理备案稿前要书面允许。不允许就本机 OCR 或停。

- [ ] **公司仓 / 第二管理员**  
  `weiweity/beian` 是个人账号私仓。确认组织仓或第二管理员 + 离职移交。

## P1 — 作业模块审查留下的洞（本周不改）

- [ ] **无主任务 / 打样默认拒绝**  
  `assertCanAccessTask` / `assertCanAccessMockup` 在 owner 为空时 fail-open。新上传已写 owner。杭州旧 FastAPI JSON 可能没主人。`/review` D3=C。下次：开机用 `created_by`/`actor` 回填，仍空的非 admin 403，并补列表/深链测试。

- [x] **打样完成通知不要走 `/?task=`**  
  `notifyJobFinished` 对照走 `/review/:id`，打样走 `/mockup/:id`。前端 History API 换台。  
  **Completed:** v0.12.17.0 (2026-08-25)

- [ ] **上传先限体积再读进内存**  
  `upload` / `rework` / `mockups` 现在 `arrayBuffer()` 之后才比 `maxUploadBytes()`。单进程 OOM 会拖死对照槽。下次：Hono `bodyLimit` 与 `maxUploadBytes` 对齐。

- [ ] **未登录 health 不要带队列人数**  
  `GET /api/health` 现把 `jobs` 槽位和 `feishu_notify` 公开。隧道探测够用 `ok`/`version`。WaitCard 的飞书开关改走已登录接口。

## P1 — 对红（金标门，不进本周 P0）

- [ ] **同一单第二份 PDF / 对红**  
  代码已能传第二份 PDF，并卡住签字/对红门（待审才可签；干净签字单不能对红；对红后优先读非空 `hits_v2`）。  
  仍阻塞：刘籽烨一套真实改稿前后（旧 PDF、新 PDF、发给设计的话、二校新发现的漏字/少字/空格）+ 书面许可进机。没有金标，不加严空格引擎、不宣称业务验收完成。  
  还缺：`open_issues` 用 `field+expected_text+observed_text`；默认队列只复检上一轮 issue；对红比较保留空白。  
  不做：历史中心、第三份 PDF、改 `normalize()` 去空白、旧新 PDF 全量 diff。  
  入口：`docs/designs/review-rework-loop.md` Recommended Approach。

## P2 — 开工板向导页画面（设计审查 2026-08-21）

- [x] **百度 / 飞书 / MiniMax 向导页 mockup**  
  落地页已是编号步骤 + 原字段，不是第二套密钥表。HTML 线框仍可后补。  
  **Completed:** v0.12.0.0 (2026-08-21)

- [x] **390 开工板画面**  
  ≤720 顶上 Segmented，行右 ≥44px，桌面仍 208px 左栏。已在实机 390 验过。  
  **Completed:** v0.12.0.0 (2026-08-21)

## P3 — 9 月以后

- [x] 3D Worker 接线（打样台调用 pipeline；缺 Blender 会失败而不是装可用）
- [x] **qlmanage 替换（平面出图）**  
  打样 PDF 栅格走 pymupdf（对照同一 `.venv`）；macOS qlmanage 仅兜底。杭州不依赖 Quick Look。  
  **Completed:** v0.12.11.0 (2026-08-24)
- [ ] Illustrator COM 替换（非 PDF 兼容 `.ai` 仍走本机 Illustrator；杭州 COM 未接线）
- [ ] Windows 开机自启 + Tunnel 掉线告警
- [ ] SQLite / 异步通用队列
- [ ] React 审稿台接 OpenSeadragon（若 8/31 冻结了换栈）
- [ ] 飞书机器人收文件回报告（网页路径的备选）

## Completed

- [x] **打样 GET owner 校验**  
  `list` / `get` / `files` 非 admin 只读自己的。已在 `feat/review-job-module`：`assertCanAccessMockup` + `listJobsFor`。  
  **Completed:** v0.11.0.0 (2026-08-21)
