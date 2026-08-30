# TODOS

由 /autoplan（2026-08-18）从 SELECTIVE EXPANSION 推迟项写入。不是 8/31 主路径。

## P2 — 打样涂层

- [ ] **涂层 / UV vs 纸**
  棚（`add_studio`）只能提亮和接触阴影。上光、局部 UV、涂层和纸的区分在 `add_box` 材质。硬约束目前不重写 `add_box`。下次若籽烨仍觉得白底没光泽，要书面允许动盒子的涂层通道再做。

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

- [ ] **生产主分支强制保护**
  `main` 的 push 会触发杭州生产 self-hosted runner，但当前个人私仓套餐拒绝 branch protection / ruleset API，无法强制「只能 PR、必过 quality、禁止 force push/删除」。不要用仓库内脚本伪装成不可绕过的保护；升级到支持私仓规则的 GitHub 套餐或迁入组织仓后，启用保护并再次用 API 取证。
  **Blocked externally:** GitHub plan（2026-08-30）。

## P1 — 作业模块审查留下的洞（本周不改）

- [x] **无主任务 / 打样默认拒绝**  
  非 admin 读空 owner 403。新单 owner 写飞书 `open_id`。旧单花名仍能被同名会话读到。  
  **Completed:** v0.13.0.0 (2026-08-25)

- [x] **打样完成通知不要走 `/?task=`**  
  `notifyJobFinished` 对照走 `/review/:id`，打样走 `/mockup/:id`。前端 History API 换台。  
  **Completed:** v0.12.17.0 (2026-08-25)

- [x] **新稿上传流式限体积并允许两份并发**
  `/api/uploads` 不再走 `parseBody()` / `File.arrayBuffer()` 整包驻留内存，改为两条通道直接流式落盘；第三份立即 429，文件聚合上限仍为 100 MB。对红保持独立单槽并尊重更低的 `WB_MAX_UPLOAD_MB`。
  **Completed:** v0.13.2.0 (2026-08-26)

- [x] **未登录 health 不要带队列人数**
  公网 `GET /api/health` 只保留 `ok`、`version` 与发版所需的 Illustrator 可见性标记；准确队列仅给杭州本机直连和已登录 `/api/status`。WaitCard、侧栏阶段脉冲已改走登录接口。
  **Completed:** v0.13.1.0 (2026-08-26)

## P1 — 对红（金标门，不进本周 P0）

- [ ] **同一单第二份 PDF / 对红**  
  代码已能传第二份 PDF，并卡住签字/对红门（待审才可签；干净签字单不能对红；对红后优先读非空 `hits_v2`）。  
  仍阻塞：刘籽烨一套真实改稿前后（旧 PDF、新 PDF、发给设计的话、二校新发现的漏字/少字/空格）+ 书面许可进机。没有金标，不加严空格引擎、不宣称业务验收完成。  
  还缺：`open_issues` 用 `field+expected_text+observed_text`；默认队列只复检上一轮 issue；对红比较保留空白。  
  不做：历史中心、第三份 PDF、改 `normalize()` 去空白、旧新 PDF 全量 diff。  
  入口：`docs/designs/review-rework-loop.md` Recommended Approach。

## P2 — 上传续传与崩溃恢复

- [x] **字节级分片断点续传**
  1 MiB 分片、SHA-256 校验、服务端持久化偏移量、同一 `client_upload_id` 幂等重放；网络错误自动重连 3 次，暂停或整页刷新后重新选择同一文件可从服务端偏移量继续。上传会话与待开工回执统一受 30 分钟 TTL 和容量限制。
  **Completed:** v0.17.0.0 (2026-08-27)

- [ ] **领取回执的进程崩溃窗口**
  普通 copy/save 失败会恢复回执；但 Node 若恰在 `consumeReceipt` 后、任务 JSON 落盘前退出，仍需重新上传。后续可把 claim 保留到任务持久化成功再 finalize，并在启动时恢复残留 claim。

## P1 — 包装语义结构 V2 上线闸门

- [ ] **真实稿结构真值与杭州 L2**
  `0.14.0.0` 已提供语义结构，后续版本已把网页固定到 V2 并删除运行时旧引擎开关；无法证明结构时 fail-closed。私有 Phase 0 的 13 份真实稿仍为 `pending_manual`。逐份由管理员确认或明确判为不支持，并为每个受支持结构族保留至少一份黄金样本；杭州真实 Illustrator + Blender L2 通过前不得把 Mac L0 或可信主线的身份冒烟写成真稿生产验收。

## P2 — 开工板向导页画面（设计审查 2026-08-21）

- [x] **百度 / 飞书 / MiniMax 向导页 mockup**  
  落地页已是编号步骤 + 原字段，不是第二套密钥表。HTML 线框仍可后补。  
  **Completed:** v0.12.0.0 (2026-08-21)

- [x] **390 开工板画面**  
  ≤720 顶上 Segmented，行右 ≥44px，桌面仍 208px 左栏。已在实机 390 验过。  
  **Completed:** v0.12.0.0 (2026-08-21)

## P3 — 9 月以后

- [ ] **退役核对原型清理（独立 PR）**
  2026-08-29 合并前审计确认：`apps/web/ui/src/pages/reviewSplit.ts` 仅被自身测试引用；`apps/web/backend/app/baidu_paddle_vl.py`、`graphics_diff.py`、`ocr_ensemble.py`、`ocr_zone_boost.py` 未被当前产品入口、脚本或 worker 调用；`workers/packaging/illustrator/create_smoke_fixture.jsx` 没有仓库调用方，现作为基线候选保留，删除前仍要确认是否存在仓库外人工冒烟流程。其中区域 OCR 回归还明确断言后两条旧路径不进入 `compare_core`。持续质量门禁已落地，深审候选可用 `npm run quality:deep` 复核；不要混入治理或 Windows 发布 PR，独立删除时同步移除相关测试，按 ADR-006 四类证据核验并保留完整 L0。
- [x] **测试文件无用导入清理**
  2026-08-29 已移除 `jobs.test.ts` 的 `tryStart`、`tasks.test.ts` 的 `writeFileSync`、`workers.test.ts` 的 `join`，并在 server `tsconfig.json` 启用 `noUnusedLocals` / `noUnusedParameters`；生产源码和测试统一受编译门禁约束。
- [x] 3D Worker 接线（打样台调用 pipeline；缺 Blender 会失败而不是装可用）
- [x] **qlmanage 替换（平面出图）**  
  打样 PDF 栅格走 pymupdf（对照同一 `.venv`）；macOS qlmanage 仅兜底。杭州不依赖 Quick Look。  
  **Completed:** v0.12.11.0 (2026-08-24)
- [x] **Illustrator COM 接线**
  macOS AppleScript 与 Windows VBScript/COM 共用 `export_structure.jsx`；`0.20.0.0` 增加 InteractiveToken Session 1 Agent，LocalSystem worker/runner 只通过受限命名管道调用现有 VBS/JSX，不再拉起 Session 0 Illustrator。Agent 身份、checkout、超时与故障恢复均 fail-closed；合入后由可信 `main` release transaction 在业务仍被 fence 阻断时执行生产 L1 身份冒烟；真实稿仍由上面的 V2 L2 闸门验收。
  **Completed in code:** v0.20.0.0 (2026-08-28；杭州 L1/L2 待验收)
- [ ] Tunnel 掉线告警（`beian-server-8787` 与 cloudflared 已是 Windows 服务；Illustrator Agent 按设计只在管理员登录会话运行，不改成开机 Session 0 服务）
- [ ] SQLite / 异步通用队列
- [ ] 压测并继续优化现有 CSS `transform` 1–6× 审稿缩放；保持当前轻量方案，不引入 OpenSeadragon
- [ ] 飞书机器人收文件回报告（网页路径的备选）

## Completed

- [x] **打样 GET owner 校验**  
  `list` / `get` / `files` 非 admin 只读自己的。已在 `feat/review-job-module`：`assertCanAccessMockup` + `listJobsFor`。  
  **Completed:** v0.11.0.0 (2026-08-21)
