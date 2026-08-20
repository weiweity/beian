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

## P1 — 对红（金标门，不进本周 P0）

- [ ] **同一单第二份 PDF / 对红**  
  代码已能传第二份 PDF，并卡住签字/对红门（待审才可签；干净签字单不能对红；对红后优先读非空 `hits_v2`）。  
  仍阻塞：刘籽烨一套真实改稿前后（旧 PDF、新 PDF、发给设计的话、二校新发现的漏字/少字/空格）+ 书面许可进机。没有金标，不加严空格引擎、不宣称业务验收完成。  
  还缺：`open_issues` 用 `field+expected_text+observed_text`；默认队列只复检上一轮 issue；对红比较保留空白。  
  不做：历史中心、第三份 PDF、改 `normalize()` 去空白、旧新 PDF 全量 diff。  
  入口：`docs/designs/review-rework-loop.md` Recommended Approach。

## P3 — 9 月以后

- [x] 3D Worker 接线（打样台调用 pipeline；缺 Blender 会失败而不是装可用）
- [ ] Illustrator COM / qlmanage 替换
- [ ] Windows 开机自启 + Tunnel 掉线告警
- [ ] SQLite / 异步通用队列
- [ ] React 审稿台接 OpenSeadragon（若 8/31 冻结了换栈）
- [ ] 飞书机器人收文件回报告（网页路径的备选）
- [x] **打样 GET owner 校验**  
  `list` / `get` / `files` 非 admin 只读自己的。已在 `feat/review-job-module`：`assertCanAccessMockup` + `listJobsFor`。
