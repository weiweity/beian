# Design System — 江华审稿室

来源：Figma「审稿室 · iOS 27」锁定稿（2026-08-20）。  
稿：https://www.figma.com/design/BL3PGUjLGLPb9iUZMzRhD6  
页：`Web · 锁定稿`（封面 `87:1448`）。`iPad` 页是探索，**不是**实现依据。  
资产：`apps/web/ui/public/brand/logo-mark.png`（侧栏）、`shine-mage.png`（拒绝页整标）、`public/brand/ui/*.svg`（侧栏/上传/等待，从锁定稿导出）。

实现入口：`apps/web/ui`。不要再画飞书顶栏。不要重写审核引擎和 3D 流水线。

## Product Context

- **What this is:** 供应链内部飞书网页。一个工作场，两张台：审稿台（Excel↔备案/包装 PDF，人终审）、打样台（2D 刀模稿 → 可旋转 3D，检验结构）。另两个侧栏页：历史记录、设置。
- **Who it's for:** 上海 2–3 位同事。第一期用户刘籽烨。
- **Space/industry:** 包装审稿 / 刀模打样。不是 ERP、不是 BI、不是聊天、不是原生 App。
- **Project type:** 内部工具。飞书只坐身份。

记住的一句：**这是给人签字的审稿台。**  
8/31 只交审稿台。打样台可交平面稿出白底 / PPT / GLB；验收仍只看审稿台，不对业务承诺 Windows 打样。

## Aesthetic Direction

- **Direction:** iOS 27 Liquid Glass 网站。白底、浅雾、淡紫点缀。侧栏是玻璃，主区是工作台。
- **Decoration level:** restrained。紫只做选中框、主按钮、钉、等待强调。不要铺成品牌墙。
- **Mood:** 干净、可扫、字够大、苹果味。机器圈疑点，人写结论。
- **Reference:** 官方库 iOS and iPadOS 27（Liquid Glass / Button / Progress）。网站不是原生壳，玻璃用 `backdrop-filter` + 半透明白近似，不要假装能嵌入 Apple 组件。
- **不要：** 飞书顶栏、Ant 默认蓝、旧主色 `#722ED1`、深紫中台侧栏、纸台印泥、「AI 已过审」。

## Information Architecture

一间屋子，两张台，两个侧栏页。历史不是第三张台。

| 侧栏 | 里面有什么 |
|---|---|
| 审稿台 | 看板（审核单）→ 新建双井 → **核对页**（专属，一对一） |
| 打样台 | 上传平面稿；跑的时候用等待卡 |
| 历史记录 | 审稿 + 打样混排。在设置之上 |
| 设置 | 外观 / 开工板 / 费用 / 密钥。永远在侧栏最后一项。外观只写本机 `localStorage`：主题、字号 px、半透明侧栏、侧栏雾面对比度滑条、核对页差异标记 |

核对页是审稿台的工作页，不是新台签。点看板卡片进入。

## Typography

- **UI:** 系统中文栈。优先苹方 / 微软雅黑；Figma 用 Noto Sans SC 作稿。禁止 Google Fonts / Geist 网络加载。
- **Data/Tables:** IBM Plex Mono 或 ui-monospace，15–17px，tabular-nums — Excel/PDF 原文、条码、批号
- **Scale（自适应，不要太小也不要太大）:** 辅助 ≥13px，正文默认 16px，页名 28px，侧栏项 17px。控件高度 ≥40px。设置 · 外观 UI 字号是 13–28 的 px（滑条 + 可手写），锁定稿 16。
- **字重:** 页名 Bold/Medium，侧栏选中 Medium，说明 Regular

```css
--font-body: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI",
  "Noto Sans SC", "Alibaba PuHuiTi", sans-serif;
--font-mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
```

## Color

Figma 变量集 `审稿室`（Light）：

| Token | Hex | 用途 |
|---|---|---|
| brand/purple | `#805898` | 选中框、主按钮、钉、等待数字 |
| brand/purple-soft | `#F6F1F8` | 选中底、当前疑点 |
| brand/purple-mist | `#EDE7F1` | 浅雾、弱分割 |
| surface/bg | `#F8F5FA` | 页底 |
| surface/white | `#FFFFFF` | 主区 |
| text/ink | `#1C1A1F` | 正文 |
| text/mute | `#6B6572` | 次要 |
| line/subtle | `#E7E2EC` | 线 |

- **Semantic:** 一致可用绿字+汉字；疑点/待人工确认 `#D48806`；缺失 `#F5222D`。禁止只靠色点。
- **Hover 灰:** `#E2E2E8`（侧栏项 Hover）。
- **飞书头像底（无图时）:** `#3370FF`。
- **Dark mode:** 默认浅色。设置 · 外观可改浅色 / 深色 / 跟随系统。深色不是灰黑中台：页底 `#141018` 紫黑，主台 `#221B28`，字 `#F6F1F8`（品牌 purple-soft），点缀仍是 `#805898` 提到 `#C9A3D6`。字重 500，避免细灰字。只写 `localStorage`。
- **外观控件（iOS 27）:** 离散项用 Segmented（主题、差异标记）；连续项用苹果滑条（侧栏对比度、字号）+ 可手写 px。对比度只调半透明侧栏雾面：低更透、高更实。关掉半透明后滑条无效。

Ant Design 6 只当零件箱：

```
colorPrimary            #805898
colorSuccess            #389E0D
colorWarning            #D48806
colorError              #F5222D
colorBgLayout           #F8F5FA
colorBgContainer        #FFFFFF
colorText               #1C1A1F
colorTextSecondary      #6B6572
colorBorder             #E7E2EC
borderRadius            16
fontSize                16
controlHeight           40
```

## Spacing

- **Base unit:** 8px
- **Density:** comfortable（大字优先）
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48)
- **壳层内边距:** 页 20px；侧栏 20×16；主区标题到内容 16

## Layout / Chrome

- **Approach:** iOS 27 分栏：侧栏贴窗口左边，主区连成同一块工作台。不是两张漂浮卡。页底淡紫雾；`.workspace` 一块圆角 28 的窗口（`--stage`）。aside / main 之间只有一根 0.5px `--hairline`（`ink` 10%），只要隔开。
- **滚动:** 壳 `100dvh` `overflow: hidden`。侧栏不 sticky、不跟页滚。只有 `.stage`（设置页是内部 `.settings-main`）滚动。`backdrop-filter` 只留在侧栏，避免双滚动卡顿。
- **展开侧栏:** 280px。玻璃层宽度锁在 280px，折叠只裁切窗口（iOS 27 sidebar 贴边）。Liquid Glass：`blur(16px) saturate(180%)`，底 `rgba(255,255,255, var(--glass-alpha))`。外观「对比度」0–100 无极调 alpha（55 对准锁定稿 0.55）。可关半透明，改成实心底。文案不卸载，折叠用 overflow 藏，避免展开残影。
- **折叠侧栏:** 76px。图标 44pt 热区，垂直居中。
- **折叠顶身份:** 默认 `logo-mark`；悬停变成展开按钮（sidebar.right）。同一 44pt，280ms Gentle 交叉淡入。不要把折叠按钮和 logo 做成两个热区。
- **展开顶品牌:** 左 `logo-mark` 36px +「SHINE MAGE」13px tracking 0.6px；右独立折叠按钮（sidebar.left）44 玻璃圆。
- **侧栏项:** 248×56（展开时撑满内宽），圆角 12px，图标 **24px** + 17px 文案（锁定稿图标 22px，实机偏小故加大）。Hover 浅灰块；Selected **2px** `#805898` 框 + `purple-soft` 底 + 紫字。不要紫胶囊填满。
- **顺序:** 审稿台 → 打样台 → 历史记录 → 设置。
- **账户行:** 左下角。飞书头像 **36px** + `花名（真名）` **15px**（锁定稿 28/13，实机过小）。例如 `天元（魏炜）`。来自登录态，不要写死。点开可退出。无花名时只显示真名。
- **主区页名:** 28px。说明 16px mute。主按钮 40×圆角 20，实心紫，一屏尽量只留一个实心紫。
- **看板:** 三栏玻璃卡 圆角 26：对照中 / 待她判 / 已签字。任务行 圆角 14，品名 + 状态汉字。
- **新建:** 品名与包装面同一行；Excel / 包装 PDF **左右双井**，虚线 1.5px `rgba(128,88,152,0.28)`，圆角 22。底下三步：传一对 → 机审标疑点 → 她来签字。
- **打样台:** 同一玻璃语言，一个大井交平面 PDF/AI。不要做成审稿的双井。
- **核对页（专属）:** 左画布 + 编号钉（紫框已命中 / 黄框待核对）；右 400px 一对一检视（当前字段、Excel 应印、稿上 OCR、定位、一致/有错/忽略、疑点列表、写下结论）。点字段，图上跟到这一条。
- **等待卡:** 狐狸球（正圆身体 + logo-mark + 绕轨/彩环）+ 大号「大约还要 N」+ 阶段胶囊 + Apple 式进度条。ETA 用大约，不装精确。对照约 40 秒，打样约 4 分钟。**不要做假取消**——后端取不消对照/Blender 就不要写「取消」。
- **登录:** 没有自建登录页。未登录直接去飞书官方授权。只放行伸美企业（`tenant_key`）。拒绝页：完整 `shine-mage.png` +「进不了这间审稿室」+ 原因 +「再试一次」。
- **窄屏:** ≤1024 默认折叠侧栏（折叠轨 `39:1116`）。390 一列看板。展开不挤主区：≤720 用 Figma `32:1081` 玻璃层盖在主区上，点遮罩收回。台签不拆字。
- **Max content:** 审稿画布吃满剩余宽度
- **Border radius:** 钉 9999px，侧栏项 12，井 22，玻璃卡 26，侧栏 28，主按钮 20

## Motion

- **Approach:** Apple 味、短、可关
- **Easing:** Gentle（接近 ease-in-out）
- **Duration:** 折叠身份 280ms；侧栏项 hover 150–180ms；狐狸球轨道慢转（对照 8s/圈，打样略快）
- **尊重** `prefers-reduced-motion`
- 登录无自建动效。未登录即跳飞书授权页。

## 文案与状态

| 状态 | 她看见 |
|---|---|
| 未登录 | 直接去飞书授权。非伸美企业：logo +「进不了这间审稿室」+ 原因 +「再试一次」 |
| 无任务 | 不画空表、不画三栏「没有单」。加载中也不抬看板。卡片：「还没有审核单」+「把 Excel 和备案/包装 PDF 交上来对照」+「新建 Excel↔PDF」 |
| 机审中 | 等待卡「对照中」+「大约还要 40 秒」。机审只标疑点，不会自动过审 |
| 待她判 | 核对页：图上钉 + 右侧一对一；OCR 不清必须写「待人工确认」 |
| 她提交 | 「已记录你的结论，不是系统过审」 |
| 打样中 | 等待卡「打样中」+「大约还要 4 分钟」。本机 Blender。白底不要带尺寸标注再交备案 |
| 打样台可跑 | 选稿 → 跑 worker → 下载白底/PPT/GLB；失败写清缺 Blender |

禁止：「已过审 / 已发送 / AI 已确认」。禁止达肤妍吉祥物当本产品品牌。

## Logo

- 侧栏：`logo-mark.png`（狐狸头，光学居中 48×48）。折叠/展开都用它，不要改回完整词标占顶栏。
- 拒绝页：完整 `shine-mage.png`（狐狸头 + SHINE MAGE），高度约 32px。
- 等待：logo-mark 放进狐狸球，不要换成 Grok 官方双眼标。轨道语言可借 morph，不复刻官方图标。
- 不要再手写中文词标，不要黑底矩形。

## Figma 对照（实现时打开对应 node）

展开

- 审核单 `28:956`
- 审稿 `32:967`
- 新建 `32:1005`
- 1024 `32:1043`
- 390 `32:1081`

折叠

- 侧栏折叠 `39:1116`
- 折叠悬停 `71:1321`

工作

- 核对页 `46:1021`
- 对照中 `68:1515`
- 打样台 `51:1362`
- 打样中 `68:1660`
- 历史记录 `76:1443`

组件

- 侧栏项 `58:1091`
- 折叠身份 `71:1313`
- 账户行 `73:1323`
- 狐狸球 `67:1167`
- 等待卡 `68:1218`
- 任务行 `31:956`

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-18 | 一间审稿室、两张台 | 用户锁定：一个工作场，审稿 / 打样 |
| 2026-08-18 | 放弃纸台印泥 | 当时要紫调、白底、大厂风 |
| 2026-08-19 | 顶栏用完整 logo | 当时不要只放头 |
| 2026-08-19 | HTTP 产品层 TypeScript | 对照/Blender 仍是 Python worker |
| 2026-08-19 | 登录定稿 A 飞书 SSO | 进站即飞书授权；只放行伸美 tenant |
| 2026-08-19 | 看板 + 费用 C 档 | 审稿三栏看板；设置开工板；厂商余额 + 本机台账 |
| 2026-08-20 | 锁定 iOS 27 玻璃侧栏 | 网站不是原生；Liquid Glass；logo-mark；淡紫点缀；不要飞书顶栏 |
| 2026-08-20 | 核对页专属 | 一对一定位，不是列表上的小窗 |
| 2026-08-20 | 历史是侧栏 tab | 审稿+打样混排，不是第三张台，不放在打样台下面 |
| 2026-08-20 | 账户行花名（真名） | 飞书头像 + 天元（魏炜）；无花名则真名 |
| 2026-08-20 | 折叠身份 hover-morph | logo-mark 与展开按钮同一 44pt，280ms |
| 2026-08-20 | 等待用狐狸球 | logo-mark + Grok Bot 轨道语言；ETA 用大约 |
| 2026-08-20 | Web 为实现依据 | iPad 探索页不指导 `apps/web/ui` |
| 2026-08-21 | aside+main 连成窗口 | iOS 27 侧栏贴窗口边；发丝线隔开；玻璃层固定宽度裁切，修展开残影 |
| 2026-08-21 | 390 展开走 Figma 层 | 锁定稿 `32:1081` 是整宽玻璃侧栏，不是 280 挤主区。默认仍折叠 `39:1116` |
| 2026-08-20 | 主区淡白板块 | Figma Body/Main 是白台，雾只做页底；壳 100dvh 隔离滚动 |
| 2026-08-20 | 空审核单不闪三栏 | 初次点审稿台、加载中都不画「没有单」列 |
| 2026-08-20 | 设置 · 外观 | 主题/字号/玻璃侧栏/对比度/差异标记；参考 Codex 行式控件 |
| 2026-08-20 | 外观连续量 | 对比度=侧栏雾面滑条；字号=可手写 px；深色走品牌紫雾 |
