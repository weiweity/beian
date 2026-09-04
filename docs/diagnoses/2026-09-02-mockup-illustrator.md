# 杭州打样台与 Illustrator 诊断报告

> 历史快照：本文记录 2026-09-02 的只读现场，不是当前能力表。随后 `0.21.21.0`–`0.21.25.0` 已落地无人值守控制面、重稿盘点、白盒成片、膜袋 L0 等修复；本文的 43 单比例和 P0–P5 建议不得当作 2026-09-04 现状。仍未闭合的是杭州真实稿 L2 / 金标与籽烨 UAT，现行待办只看 `TODOS.md`。

- 日期：2026-09-02
- 机器：`DESKTOP-FAEJK8S`（杭州 Windows，UU 远程「人事-台式」）
- 公网：https://www.jianghua.site/mockup
- 生产数据：`C:\supply\data\mockups`
- 代码：`D:\beian`（打样 V2，`structure_engine=v2`）
- 性质：只读排查。未改生产代码、未清故障围栏、未重跑打样。

本文汇总三件事：本机 Illustrator 卡顿、打样失败 / 待确认结构、软件成功率低的原因与改法。

---

## 1. 范围与数据来源

| 来源 | 用途 |
|---|---|
| WSL2 直连 Windows：进程、显卡、偏好、窗口标题 | Illustrator 卡顿 |
| `C:\supply\data\mockups\*\job.json`（43 张） | 打样状态与错误码 |
| 各单 `structure_resolution.json`、`illustrator_result.json`、`jsx_debug.log` | 结构闸门与图层 |
| `C:\supply\data\logs\illustrator-agent.jsonl` | Agent 心跳与占槽 |
| `D:\beian`：`docs/adr-005-packaging-structure-v2.md`、`export_structure.jsx`、`pipeline.py`、`mockupStructure.ts`、模板 `print_layers` | 代码合同 |

打样盘快照（2026-09-02）：

| 状态 | 数量 | 看板 |
|---|---|---|
| `done` 已出图 | 17 | 已出图 |
| `review_required` 待确认结构 | 19 | 待确认结构 |
| `failed` 打样失败 | 7 | 打样失败 |
| 合计 | 43 | |

按「出图 / 全部上传」约 40%。第一次识别就自动进 Blender 的比例接近 0%。

---

## 2. 收集到的事实

### 2.1 本机与 Illustrator

| 项 | 实测 |
|---|---|
| 系统 | Windows 10 22H2 家庭版（10.0.19045），8/29 开机，排查时已连续运行约 4 天 |
| CPU / 内存 | i7-13700 16C/24T，32GB，空闲约 19GB |
| 磁盘 | C: 954GB 空 820GB；D: 几乎空 |
| 显卡（三套同时在） | 网易 GameViewer 虚拟屏 1920×1080@**144Hz**；Intel UHD 770；RTX 4060 8GB 真屏 1920×1080@60Hz（联想 LEN61D1） |
| NVIDIA | Game Ready **580.97**（2026-05-18 安装）；HAGS 开着（`HwSchMode=2`） |
| Illustrator | 2026 **30.5.1**（30.8 才修输入延迟 / 越开越慢） |
| GPU 绑定 | `Illustrator.exe` → `GpuPreference=2`（独显，正确） |
| 排查时进程 | Illustrator PID 5068，约 2.4GB、228 线程；窗口 `26GH07B.ai` @ 66.67%，CMYK 预览 |
| GameViewer | `C:\Program Files\Netease\GameViewer\`，CPU 时间高于 Illustrator |
| 其他占资源 | 飞书约 2GB / 12 进程；火绒 `HipsDaemon` 322MB；微信输入法 WeType 约 470MB；WSL `vmmem` 约 1.5GB |

Illustrator 偏好（`Adobe Illustrator 30 Settings\zh_CN\x64`）：

- `LiveEdit_State_Machine 1`（实时绘制开）
- `EnableGPU_Ver19_2 1`、`AnimZoom 1`、`AutoSwitchEngine 1`
- `enableHyperThreadedRendering 0`
- 字体菜单预览开（`showInFace 1`）
- 当前打开包装刀版约 9MB，画板约 2100×1204 pt；语义提取曾跑 118 秒

### 2.2 打样失败 7 张（尚未进 Blender）

| 原因 | 单数 | 对外文案 | 证据 |
|---|---|---|---|
| 印刷层名对不上 | 4 | Illustrator 无法按模板隔离印刷图层 | JSX：`Configured artwork layer not found: 印刷`。26E20A 三张只有「图层 1」；26G13B 睿峰刀版有刀线，印刷面也叫「图层 1」 |
| 桌面已有其他稿 | 2 | Illustrator 还有其他稿件打开 | Agent 规定 Session 1 只能开本任务源稿 |
| Agent 掉线 | 1 | Illustrator 桌面代理未在线 | `3a1fb44af991`，同 SKU 后来有出图 |

模板写死：`required_layers` / `print_layers` = `["印刷"]`。

### 2.3 待确认结构 19 张（故意不进 Blender）

V2 规定：没有证明「盒身环 + 上下封口」不得进 Blender，状态为 `review_required` + `waiting_input`。

| `structure_code` | 单数 | 含义 | 页面能不能往下走 |
|---|---|---|---|
| `structure_semantics_missing` | 8 | 无 `packaging:cut/crease`，第一次导出 0 边 | 多数 resolution 里已有刀版/刀线候选，可勾层；`dfb2ec70cb33`（26E20A）只有「图层 1」，无入口 |
| `structure_path_too_short` | 5 | 第一次把整稿描边（含表/标注）送进拓扑，残余短路径 | 部分单 job 上没有选层入口，像死单 |
| `structure_box_net_missing` | 6 | 人已勾层，二次识别仍 0 个完整盒型 | 不能点「生成打样图」 |

二次识别后刀版被踢成工艺板的现场：

| 单 | 产品 | 勾完后 |
|---|---|---|
| `9b2600784362` | 膜袋 26G30A | `刀版` → preview_plates |
| `d47820e07e41` | 膜袋 26H26A | `刀线` → preview_plates |
| `9f3222b7fd62` / `1b835cd2bd1d` | 3 片装花盒 26G30A | `刀版` → preview_plates |
| `b6b81ceea21e` | 7 袋装 26H24A | `刀线` → preview_plates |

JSX 判定：`item.stroked && !item.filled` 才当结构线。专色填色刀线会被当成击凹/烫金一类。

### 2.4 已出图 17 张怎么过的

能核对到选层的成功单，几乎都是人只勾了 **「刀版」或「刀线」**（少数顺带勾了「印刷」仍过）。例如：

- 刘籽烨 `ae7cca770415`：只勾刀版 → 26GH07B 出图
- 查欣悦 `6fec1cd7e682` / `aa622be3700a`：只勾刀版 → 26I01A 出图
- 魏炜 `9478758c1f8d`：只勾刀线 → 26H31A 出图

同一 SKU 既有出图也有待确认/失败（尤其 26H07A、26E20A、26H31A）。几何往往够，差在第一次导出和选层。

### 2.5 真实 `.ai` 图层（41 张能读出层）

设计按印刷/模切习惯分层，不是没规范。

| 习惯 | 出现 |
|---|---|
| 「印刷」 | 36 / 41 |
| 「刀版」或「刀线」 | 37 / 41（刀版 19、刀线 18，**从未同时出现**） |
| 「标注」 | 35 |
| 「表」 | 32 |
| 工艺板（击凹等） | 37 |
| 图层名含 `packaging:cut` | **0** |

乱的部分是少数：拼合「图层 1」（外发 26E20A）、印刷面改名、错字（`标注啊`、`喷吗不印刷`）、临时层（`图层 7/8`、`Dimensions`）。「码不印刷」有业务含义，不是乱起名。

仓库里 **没有** 发给设计的打样图层规范；只有工程师 ADR。Changelog 曾把「按刀线/刀版层名自动当结构」当成 bug 修掉，改成必须 `packaging:*` 或网页手勾。设计仍按旧印刷约定交稿。

### 2.6 代码合同（和语料错位）

第一次导出（`pipeline.py` + `export_structure.jsx`）：

1. 只收对象备注/对象名/图层名精确 `packaging:cut|crease|...`
2. 没有则 `proposal_layers=[]`，`chosenRecords` 为空，**结构边数 0**
3. 顺手盘点「描边且无填充」层，等人勾
4. 拓扑见 0 面 0 边 → `structure_semantics_missing`

UI 只预勾全稿唯一的「刀线」，不预勾「刀版」（这批稿「刀版」更多）。

成盒模型只认 FEFCO 类：四面盒身 + 上下封口。膜袋、内包、袋装、标贴物理上不是这个模型，但仍进同一套证明，失败显示为待确认。

杭州只有一个 Session 1 Illustrator Agent，全公司共用。开着别的稿或 Agent 掉线会计入打样失败。

ADR-005 原话：「自动率可能下降；错误自动接受必须为零。」现场就是这个结果。

---

## 3. 问题定位

### 3.1 Illustrator 卡顿

不是 CPU/内存/磁盘不够（32GB 空闲约 19GB，C 盘空 820GB，GPU 占用约 4%）。

按影响：

1. **网易 GameViewer 虚拟 144Hz 屏 + 真屏 60Hz**，DWM 合成/抓帧把输入做黏（GameViewer CPU 时间高于 Illustrator）
2. **30.5.1 + 实时绘制 + GPU 预览**：2026 拖对象发黏的已知组合；Adobe 官方建议关实时绘制
3. **当前刀版文件重**（大画板、多层、实时效果），空白文件需对照才能排除
4. 飞书 / 火绒 / 输入法 / WSL 抢 CPU，次要
5. Creative Cloud 未登录刷 IMS 错误，主要拖启动，不是画布主因

### 3.2 打样「一直失败」

失败和待确认被混在一起看。

- **7 张 failed**：环境/层名过不了门（缺「印刷」、Illustrator 占槽、Agent 掉线），3D 没开始
- **19 张 review_required**：V2 闸门。其中标准花盒多半还能勾刀版救出；膜袋/内包/拼合稿/填色刀版被踢掉的，点「生成打样图」也出不来
- 同一 SKU 连传，失败单不会从看板消失，视觉上像「一直都有错误」

### 3.3 成功率低（作为软件）

不是 Shapely 不会算，也不是 4060 不够。花盒在人勾对刀版之后能出图，后半段（确认 → Blender → 六面）对标准摇盖盒是通的。

低的是 **自动过闸率** 和 **非花盒可达率**：

| 口径 | 大约 |
|---|---|
| 第一次自动出图 | ~0% |
| 人只勾刀版/刀线的标准花盒 | 高（同 SKU 多次证明） |
| 膜袋 / 内包 / 袋装 / 仅「图层 1」 | 0%（模型外） |
| 刀版带填充，二次识别 | 经常 0%（真刀线被当工艺板） |
| 印刷层不叫「印刷」 | 硬失败 |

六个代码决策：

1. 语义门只认 `packaging:*`，不认工厂「刀版/刀线」
2. 第一次空 `proposal_layers`，导出 0 边
3. `!filled` 把专色刀版踢成工艺板
4. 印刷层字符串写死「印刷」
5. 打样台无品类门，袋子和花盒同一套成盒证明
6. 一台 Illustrator 当全公司互斥锁

### 3.4 设计有没有规范

**有，但是印刷厂规范，不是软件规范。**

对模切/印刷：36/41 有印刷层，37/41 有刀版或刀线，表/标注/工艺板稳定出现。  
对打样：0 份 `packaging:cut`，因为没人把这套发给设计。  
真正没按印刷规范交的是少数：外发拼合「图层 1」、印刷面改名。

两套合同：

```
设计交给印刷/模切              代码拿来折 3D
─────────────────────        ─────────────────────
印刷 / 刀版 / 表 / 标注       packaging:cut / crease
刀线可填专色                  必须纯描边无填充
图层 1 外发拼合可以           必须精确叫「印刷」
膜袋也是「包装稿」            只认 FEFCO 纸盒展开图
```

---

## 4. 推荐解决方案

原则：不按颜色/bbox 静默套盒；不重写 Blender；「刀版/刀线」只作默认提案，仍走同一套拓扑；过不了就标「当前不支持」，不要停成假待确认。零的是错盒子，不是零自动率。

### 4.1 软件（按杠杆）

#### P0　第一次就带上唯一刀版/刀线

- 全稿恰好一层名叫「刀版」或「刀线」→ 第一次导出就带上（与人手勾等价）
- 两个名字都有或一层都没有 → 仍停在选层
- UI 预勾改为「刀版或刀线唯一则预勾」（现在只认「刀线」）
- 「表 / 标注 / 码 / 印刷」永不进默认提案

预期：吃掉 8 张 `semantics_missing` 和大部分 `path_too_short`，标准花盒第一次走到选正面。

#### P1　刀版层允许填色切线

- 层名已是刀版/刀线：该层路径无论填色都当 cut 候选
- 工艺板用层名黑名单（击凹、击凸、烫*、哑油、垫白、丝印、注塑、漏银）
- 不要用「有没有填充」区分刀线和烫金

预期：勾了刀版仍组不成盒的花盒好转。膜袋仍走 P3，不放宽成盒模型。

#### P2　印刷层模糊匹配

- 顺序：精确「印刷」→ 唯一顶层且不在结构/工艺名单 → 再失败
- 失败文案列出稿里实际层名
- 只有「图层 1」的拼合稿：结构侧直接「当前不支持（拼合稿）」

预期：26G13B 可出图；26E20A 不再连打三次同一错误。

#### P3　品类门，待确认不要变停尸房

- 文件名/层名命中膜袋、内包、袋装、标贴、仅图层 1 → `unsupported`，不要 `review_required`
- 文案拆开：组不成盒 / 刀版被当工艺板 / 拼合稿 / 候选过期
- 选层后 0 个 net_proposals：写清「这组线组不成花盒」，给「只留刀版再识别」

#### P4　选层交互

- 候选排序：刀版/刀线置顶，表/标注/印刷沉底
- `structure_semantics_missing` 先引导勾刀版，不要开口叫人写 `packaging:cut`
- `structure_path_too_short` 只要盘到刀版，就必须还能选层

#### P5　Illustrator 占槽

- 接单前若有本任务以外文档：412，文案带文档名
- Agent 掉线：开工板红字，不要上传完才 412
- 打样结束关掉本次源稿
- 开工板可提示：GameViewer 虚拟屏开启时 Illustrator 易卡（运维项，不当失败码）

### 4.2 不要做的

- 不要按红色/专色自动当刀线
- 不要给膜袋硬套六面纸盒
- 不要把全员改 `packaging:cut` 当上线前提（印刷厂不认；可作新稿加分项）
- 不要重写 Blender / 六面验证

### 4.3 设计侧（软件先容错，规范后补）

在现有印刷分层上加硬约束即可，不必改成 Esko 英文语义：

1. 结构线顶层统一叫「刀版」（或全公司统一「刀线」，不要两种并存）
2. 必须有顶层「印刷」，禁止只交「图层 1」
3. 刀版层尽量只描边；专色填色放到击凹/烫银等工艺层（P1 落地前软件先容错）
4. 表 / 标注 / 码不要和刀线同层
5. 膜袋、内包、标贴不进打样台，或文件名标明品类
6. 外发拼层必须留一份未拼合源稿给打样

### 4.4 本机卡顿（运维，可与打样改动并行）

1. 彻底退出网易 GameViewer（含 Server），对照画布是否立刻顺
2. `首选项 → 性能` 关掉「实时绘制和编辑」；对比 GPU / CPU 预览
3. 空白 RGB 文件对照：空白也卡 → 系统/虚拟屏；空白不卡 → 当前 `.ai`
4. 查文档栅格效果是否远高于 300 ppi
5. Illustrator 升到 30.8+（输入延迟 / 越开越慢在 30.8 修复列表）
6. 火绒排除 Illustrator 与 `C:\supply\`
7. 打样前关掉桌面上无关的 `.ai`（含排查时开着的 26GH07B）

### 4.5 建议落地顺序

| 顺序 | 改什么 | 现场会少什么 |
|---|---|---|
| 1 | P0 唯一刀版/刀线第一次就导出 | 待确认里的标准花盒 |
| 2 | P3 膜袋/拼合稿 → 当前不支持 | 看板上的假待确认 |
| 3 | P1 刀版层允许填色切线 | 勾了刀版仍组不成盒 |
| 4 | P2 印刷层匹配 + 真层名报错 | 26E20A / 26G13B 类硬失败 |
| 5 | P4 文案和预勾 | 人再把「表」勾进结构 |
| 6 | P5 占槽 / Agent | 「其他稿件打开」 |

1+2 行为面小，不破坏「不静默套盒」，适合先合。P1 要补 L0：填色刀版仍能成盒，击凹仍不能当 cut。

---

## 5. 相关代码与文档

| 路径 | 点 |
|---|---|
| `docs/adr-005-packaging-structure-v2.md` | V2 闸门、零错误自动接受 |
| `workers/packaging/illustrator/export_structure.jsx` | `packaging:*`、`stroked && !filled`、空 proposal 导出 0 边 |
| `workers/packaging/pipeline.py` | 第一次空 `proposal_layers`；印刷层错误映射 |
| `workers/packaging/templates/flower_box_*.json` | `print_layers: ["印刷"]` |
| `apps/web/ui/src/pages/mockupStructure.ts` | 只预勾唯一「刀线」；`semantics_missing` 文案指向 packaging:cut |
| `apps/web/server/src/jobs.ts` | `review_required` / `waiting_input` 不进 Blender |
| `scripts/windows/README.md` | Agent、占槽、故障围栏 |

---

## 6. 一句话

设计按印刷分层交稿，大体规范；软件按 Esko 对象语义收稿，第一次故意不信「刀版」。花盒几何经常是够的。把唯一刀版纳入第一次提案、填色刀线当切线、袋子/拼合稿标不支持，成功率会从「看起来 40%、自动 0%」变成「花盒可出、非盒明确不做」。
