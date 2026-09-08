# TODOS

这是当前未完成事项的唯一清单。已完成代码和版本历史只写 `CHANGELOG.md`；设计理由写 ADR；一次性现场数据留在带日期的诊断报告。这里不再混放已完成的 `[x]`、旧方案全文或生产验收证据。

## 状态口径

- **Code**：代码已经落地，不代表测试、杭州或业务验收完成。
- **L0**：Mac / GitHub-hosted 的单测、类型、质量和合成回归。
- **L1**：可信 `main` 发版事务在杭州验证进程、版本、端口和平台身份链；不替代真实稿。
- **L2**：杭州真实 Illustrator / Blender + 人工核定金标；真稿、真值与输出不进 Git。
- **UAT**：刘籽烨按真实工作方式确认可用。没有 L2/UAT，不写“生产能力已完成”。

优先级：P1 是当前质量/验收阻塞；P2 是下一阶段可靠性或产品完善；P3 是独立、低耦合的后续工作。

## P1 — 包装 3D 渲染真实感与清晰度

主计划：`docs/adr-007-packaging-render-fidelity.md`。RF-00 测量尺、RF-01 独立合同和 RF-02 流水线接线（含 RF-02.3 磁盘执行边界、私有执行快照/nonce、V1 诊断路径、legacy 必存键、同步回滚删除新建目标和成对 registry snapshot）已完成 Code/L0；非 V2 只是命令行诊断路径，不是网页产品通道。三者都未改变产品画质，也没有批准正式 baseline。RF-03 本地产物合同、资源生命周期与临时 registry 已实现，详见 [RF-03 收口记录](docs/designs/packaging-quality-rf03-runtime-closeout.md)。RF-04 出图版本 API/UI 与历史切换已实现，详见 [RF-04 交付记录](docs/designs/packaging-quality-rf04-closeout.md)。RF-05 显式纸盒壳几何与 family/GLB 合同已实现，详见 [RF-05 交付记录](docs/designs/packaging-quality-rf05-closeout.md)。RF-06 纸材/油墨/整体工艺已合入 `main` `d2657f0` / `0.21.40.0`，详见 [RF-06 交付记录](docs/designs/packaging-quality-rf06-closeout.md)；候选未写入生产 registry，未改默认灯光/Standard。RF-07 尺寸归一显式三灯棚与三变换合成对照已合入 `main` `88321a90` / `0.21.41.0`，详见 [RF-07 交付记录](docs/designs/packaging-quality-rf07-closeout.md)；人工选择未批准。RF-08 投影 Jacobian 切面预算已在诊断 profile 落地，详见 [RF-08 交付记录](docs/designs/packaging-quality-rf08-closeout.md)；未改生产 registry 或默认采样。RF-09 浏览器分层升级与下载冻结已完成本地实现、合成验证和独立复核，剩余性能及实机验收见下方「端到端字体清晰度修复」。Windows 原生发版烟测、断电耐久性、生产注册、RF-10+ 及真实画质验收继续保留为独立后续。下面只保留尚未闭环的工作。

- [ ] **批准渲染质量基线与门槛**
  RF-00 已能用 Git 内脱敏合成样片重复记录几何、白盒边界、纸材、字体频率、Alpha 光边、渲染耗时和 full/card/read-face 像素身份；正式 approved baseline 仍不存在。必须由人工审阅现状报告后显式批准，后续参数变化才可用同一身份闭包比较；私有真稿仍只在杭州记录哈希、评分和结论。

- [ ] **矩形花盒真实感内核**
  在现有 `render_job.py` 内按 family 分派几何；先把 `rectangular_carton` 做完整。外尺寸、六面 UV 和 GLB 验证不回退；纸板厚度、边缘、折角、接触影和轮廓高光使用物理毫米与声明的材质 profile，不能靠白盒专属滤镜补丁。

- [ ] **纸材、油墨与涂层分层**
  隔离工作区已有显式白卡/牛皮纸、process ink、none/哑膜/上光、微法线与 GLB 子集校验；生产默认仍是白卡且无新字段。深色纸、金属、珠光、透明窗和局部 UV 仍不支持。已完成本机合成四材质 × 正反两视角完整静帧与实际 GLB 校验；生产注册、Windows/L1、真实稿 L2 与正式 baseline 仍未完成。详见 [RF-06 记录](docs/designs/packaging-quality-rf06-closeout.md)。

- [ ] **棚光、白盒边界与色彩管理**
  已有尺寸归一显式三灯棚诊断候选和 Standard / Khronos PBR Neutral / AgX 受控对照；未批准 P0 阈值或私有真稿盲评前保持 Standard，不改生产默认或正式 baseline。详见 [RF-07 记录](docs/designs/packaging-quality-rf07-closeout.md)。白盒分离、边缘连续、接触影、Windows Blender、真实稿金标和生产注册仍待完成。

- [ ] **端到端字体清晰度修复**
  预览容器尺寸同步、卡图→全图原位升级、失败保留卡图、同单重渲缓存切代及高光保护进入共用合成器与旧单。历史合成证据见 `docs/designs/packaging-quality-rfe02-browser-findings.md` 和 `docs/designs/packaging-quality-highlight-transfer.md`；不将原大工作树的测试数字当成本批独立运行结果。这些预览改动不代表端到端字体清晰度或真实稿验收完成。
  F 已追加为显式可选的版本化 profile，包含阴影资源预算、零退出码阴影溢出拒绝及受信任历史 registry 回放；默认未切换。合同与历史证据见 `docs/designs/packaging-quality-f-contract.md`；不代表 RF-03+、字体清晰度或生产验收完成。
  PDF→切面的投影反推与 32MP 预算已在诊断 profile `packshot-projection-sampling-v1` 落地（见 RF-08 记录）；生产默认仍是 `minimum-floor-v1`。浏览器 card→full 原位升级（RF-09）的本地实现、针对性合成验证与独立复核已完成；下载与预览共用合成器。B5 已交付同 fixture 的有限前后对照，B7 已完成隔离页 browse 检查，真实 Claude 路由不可用的覆盖限制保留。仍缺：每次采样写入产品质量报告的生产接线、heap/帧预算和真实环境性能验证、杭州 L1、真稿 L2、UAT。3D 仍用于看形，`read_*` 印刷面仍是验字事实源。不把本项写成渲染质量验收完成。

- [ ] **质量门与回归矩阵**
  L0 验证合同、像素预算、缓存、旧单兼容和浏览器升级；有 Blender 的显式质量命令验证合成样片；L1 记录 Blender 版本/合同 hash；L2/UAT 用白盒、深色盒、细长盒、矮宽盒、膜袋正负样本做人工 A/B。任何机器分数都不能替代人核“真实感”。
  2026-09-08 本工作树阶段（`codex/rf10-quality-gates`）：RF-10 三层质量结果已接到 evaluator CLI / JSON 与 generation worker（runtime hard / fixture regression hard / `human_acceptance` 独立 pending）。Q05 本机合成 Playwright 测量已记录（heap 量化、非上屏时刻）。RF-11 本地 smoke wrapper 与发布合同测试已落地，杭州 90 秒冻结 / Windows 原生 / 可信 main 冒烟未做。未勾本项整体：正式 baseline 未批准，L1/L2/UAT、生产 registry 与人工验收未做。

## P1 — 已有代码仍欠生产/业务验收

- [ ] **膜袋 v1 杭州金标**
  `0.21.25.0` 已完成 L0 分流与 3 mm 薄盒预览。杭州正样本为“膜袋”且两块相近闭合刀线；负样本至少覆盖 5 片面膜花盒、`7袋装花盒`、2-up 花盒和一页多袋。未通过前不得宣称真实膜袋能力；真实袋体属于 ADR-007 能力矩阵之外的新 family。

- [ ] **PackagingStructure V2 真实稿矩阵**
  私有 Phase 0 的 13 份真实稿仍需逐份人工批准或明确不支持，并为每个受支持结构族留至少一份黄金样本。Mac 脱敏矩阵和 GLB 合同不替代杭州 Illustrator→Blender L2。

- [ ] **Illustrator 无人值守重稿 L2**
  `0.21.21.0`–`0.21.22.0` 已完成结果文件完工、saving 禁杀、busy 排队和 1260 秒外层合同；仍需杭州 26H21A 人工重稿证明。未跑不得宣称无人值守控制面已通过真实稿。

- [ ] **对红真实改稿金标**
  代码已能传第二份 PDF，并执行签字/对红门。仍需刘籽烨提供一套获书面许可的旧 PDF、新 PDF、发给设计的话和二校真值；补齐 `open_issues` 的字段、应印、实读结构后再决定是否加严空格规则。

## P2 — 作业可靠性与打样单完善

- [ ] **补印刷面进入持久队列 / 发版 drain**
  当前 `/print-faces` 同步等待，busy 只在内存；跨用户碰撞和进程重启会丢。复用现有作业合同，不建 `/api/jobs`，并让发版围栏看得见在途切面。

- [ ] **真金属地 / 木桌预设**
  先取得用户拒图证据和许可清晰的材质资产。背景切换继续由已有 pass + 浏览器 compositor 完成，不为三键重新排 Blender；木桌不是默认。

- [ ] **新单 PPT 与打样看板信息**
  grounded 新单当前隐藏 PPT；若业务仍需要，另做浏览器/OOXML 输出合同。打样看板新增信息必须保持一行高密度，不扩成重复卡片。

- [ ] **切面与渲染资源压测**
  覆盖极端长宽比、最高允许像素预算、两个并发上传、Illustrator busy、Blender 单槽、重渲棚和发版排干；先量峰值内存、磁盘和总耗时，再决定是否调预算。

## P2 — 采用、资产与合规

- [ ] **审稿金标与采用止损**
  至少一组已知漏标、误报、待人工确认样本。若辅导后籽烨仍持续左右分屏，或第二周不主动开单，停止“生产级远程工作台”叙事，评估改为飞书发报告。

- [ ] **真稿出境书面许可**
  百度 OCR / MiniMax 处理备案稿前取得书面许可；不允许就本机 OCR 或停。真稿、人工真值和渲染输出不得进 Git 或对外模型上下文。

- [ ] **公司仓 / 第二管理员与主分支保护**
  `weiweity/beian` 仍是个人私仓。确认组织仓或第二管理员及离职移交；GitHub 套餐支持私仓 ruleset 后再强制 PR、quality、禁止 force push/删除。仓库内脚本不能伪装成不可绕过的保护。

## P3 — 独立后续

- [ ] **退役核对原型清理（独立 PR）**
  候选包括只被自身测试引用的 `reviewSplit.ts`、未被产品入口调用的若干旧 OCR/图像模块和可能由仓库外流程使用的 Illustrator smoke fixture。先按 ADR-006 取四类证据，再按文件名精确删除，不能混入 3D 或 Windows 发布改动。

- [ ] **Tunnel / 服务掉线告警**
  监控 `beian-server-8787` 与 cloudflared；Illustrator Agent 保持登录桌面进程，不改成 Session 0 开机服务。

- [ ] **SQLite / 通用异步队列评估**
  只有现有 JSON 作业合同出现可复现的数据一致性或吞吐瓶颈时才启动；不得为“以后可能扩展”先改存储。

- [ ] **审稿缩放性能**
  压测现有 CSS `transform` 1–6×；保持初始 `transform:none` 和平移期临时 `will-change`，不引入 OpenSeadragon。

- [ ] **飞书机器人收文件回报告**
  作为网页路径的备选，不替代当前产品入口；权限、费用与真实消息 UAT 单独立项。

## 已完成工作在哪里看

- 发布事实：`CHANGELOG.md`
- 当前产品与启动：`README.md`
- UI 锁定稿：`DESIGN.md`
- 结构与六面正确性：`docs/adr-005-packaging-structure-v2.md`
- Illustrator 控制面历史施工合同：`docs/designs/illustrator-unattended-control.md`
- 2026-09-02 现场数据：`docs/diagnoses/2026-09-02-mockup-illustrator.md`（历史快照）
