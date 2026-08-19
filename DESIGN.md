# Design System — 江华审稿室

来源：`/design-consultation` + `/design-shotgun`（2026-08-18）。  
锁定稿：飞书顶栏 + 云文档批注钉 + 左上角仅蝴蝶 logo。  
预览：`http://127.0.0.1:4179/variant-ac.html`  
资产：`apps/web/ui/public/brand/logo.png`

## Product Context

- **What this is:** 供应链内部飞书网页。一个工作场，两张台：审稿台（Excel↔备案/包装 PDF，人终审）、打样台（2D 刀模稿 → 可旋转 3D，检验结构）。
- **Who it's for:** 上海 2–3 位同事。第一期用户刘籽烨。
- **Space/industry:** 包装审稿 / 刀模打样。不是 ERP、不是 BI、不是聊天。
- **Project type:** 内部工具。飞书只坐身份。

记住的一句：**这是给人签字的审稿台。**  
8/31 只交审稿台。打样台共用顶栏，点开写「内部准备中」，不对业务开放提交口。

## Aesthetic Direction

- **Direction:** 大厂白底 + Ant Design 极客紫。飞书顶栏导航，云文档式图上批注。
- **Decoration level:** minimal。紫只做选中、钉、主按钮。
- **Mood:** 干净、可扫、字够大。机器圈疑点，人写结论。
- **Reference:** shotgun 定稿 A+C。不要纸台印泥，不要 Ant 默认蓝，不要深紫中台侧栏当品牌墙。

## Typography

- **Display/Hero:** 阿里普惠体 Medium — 稿名、顶栏桌签
- **Body:** 阿里普惠体 Regular — 界面
- **UI/Labels:** 同上
- **Data/Tables:** IBM Plex Mono 或 ui-monospace，17px，tabular-nums — Excel/PDF 原文、条码、批号
- **Code:** 同证据栏
- **Loading:** 系统栈。禁止 Google Fonts / Geist 网络加载。等宽可后续自托管 woff2
- **Scale:** 辅助 ≥13px，正文 ≥16px，稿名 20–28px。默认密度 = 大字。控件高度 ≥40px

```css
--font-body: "Alibaba PuHuiTi", "PingFang SC", "Hiragino Sans GB",
  "Microsoft YaHei UI", "Noto Sans SC", sans-serif;
--font-mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
```

## Color

- **Approach:** restrained。1 个紫 + 白/浅灰。
- **Primary:** `#722ED1` — 顶栏选中、批注钉、主按钮
- **Primary soft:** `#F9F0FF` — 当前疑点底
- **Pin:** `#7B61FF` — 图上数字钉
- **Neutrals:** 布局 `#F5F6F8`，容器 `#FFFFFF`，正文 `#1F2329`，次要 `#646A73`，线 `#DEE0E3`
- **Semantic:** 一致可用绿字+汉字；疑点/待人工确认 `#D48806`；缺失 `#F5222D`。禁止只靠色点
- **Dark mode:** P0 不做

Ant Design 6 token 映射：

```
colorPrimary            #722ED1
colorSuccess            #389E0D
colorWarning            #D48806
colorError              #F5222D
colorBgLayout           #F5F6F8
colorBgContainer        #FFFFFF
colorText               #1F2329
colorTextSecondary      #646A73
colorBorder             #DEE0E3
borderRadius            8
fontSize                16
controlHeight           40
```

## Spacing

- **Base unit:** 8px
- **Density:** comfortable（大字优先，不为塞字段压到 12px）
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48)

## Layout

- **Approach:** hybrid。顶栏网格纪律，审稿区画布 + 右抽屉。
- **Chrome:** 56px 白顶栏。左上角放完整 `public/brand/shine-mage.png`（紫狐狸头 + SHINE MAGE），不要裁成只留头，不要再旁标「江华」。
- **一级切换:** 顶栏「审稿台 / 打样台」，飞书式字 + 底线。选中用字重 + 紫底线，不要紫胶囊。一屏只留一个实心紫：列表上的「新建 Excel↔PDF」。
- **本机配置:** 右上角点姓名打开菜单（设置 / 退出）。设置不是第三张台，不要和台签抢权重。
- **审稿台列表:** 顶栏是工作场，H1 是「审核单」。默认看板三栏：对照中 / 待她判 / 已签字。也可切回表格。空列表不画表头、不放搜索。
- **设置:** 含开工板（三步能否干活）和费用账单（厂商余额/月账单 + 本机台账）。字段先全开，权限以后再切。
- **审稿台:** 左画布（包装图 / OpenSeadragon）+ 图上编号钉；右 340px 批注列（字段、Excel/PDF 原文、状态汉字）；右下「写下结论」。
- **登录:** 没有自建登录页。未登录直接去飞书官方授权。只放行伸美企业（`tenant_key`）。其他公司主体进不来。拒绝页要像结果页：logo +「进不了这间审稿室」+ 原因 +「再试一次」。
- **打样台:** 同一顶栏。交平面稿，下载 2 张白底 + PPT + GLB。GLB 可旋转供她截图。备案用静帧，不要带色泽尺寸标注。
- **窄屏:** 顶栏两行——logo + 姓名在上，台签整行在下。台签文字不拆字。
- **Max content:** 审稿画布吃满剩余宽度
- **Border radius:** 钉 9999px，按钮/卡片 8px，批注块 10px

## Motion

- **Approach:** minimal-functional
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50–100ms) short(150–250ms)
- 登录无自建动效。未登录即跳飞书授权页。

## 文案与状态

| 状态 | 她看见 |
|---|---|
| 未登录 | 直接去飞书授权。非伸美企业：logo +「进不了这间审稿室」+ 原因 +「再试一次」 |
| 无任务 | 不画空表。卡片：「还没有审核单」+「把 Excel 和备案/包装 PDF 交上来对照」+「新建 Excel↔PDF」 |
| 机审中 | 「正在对照，请稍候」 |
| 待她判 | 图上钉 + 右侧疑点；OCR 不清必须写「待人工确认」 |
| 她提交 | 「已记录你的结论，不是系统过审」 |
| 打样台可跑 | 选稿 → 跑 worker → 下载白底/PPT/GLB；失败写清缺 Blender |

禁止：「已过审 / 已发送 / AI 已确认」。禁止达肤妍吉祥物当本产品品牌。

## Logo

- 文件：`apps/web/ui/public/brand/shine-mage.png`（完整：狐狸头 + SHINE MAGE）；`logo-mark.png` 仅登录卡片小标
- 用法：顶栏左侧整图出现，高度约 32px，宽随图，不要裁头
- 不要再手写中文词标，不要黑底矩形

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-18 | 一间审稿室、两张台 | 用户锁定：一个工作场，审稿 / 打样 |
| 2026-08-18 | 放弃纸台印泥 | 用户要紫调、白底、Ant Design、大厂风 |
| 2026-08-18 | 定稿 A+C | 飞书顶栏 + 云文档批注钉 |
| 2026-08-18 | 左上角只放蝴蝶 | 用户提供 logo，不要旁标「江华」 |
| 2026-08-19 | 顶栏用完整 logo | 用户不要只放头；整图是狐狸头 + SHINE MAGE |
| 2026-08-18 | 3D 9 月再接线 | 8/31 只验收人终审 |
| 2026-08-19 | HTTP 产品层 TypeScript | 对照/Blender 仍是 Python worker |
| 2026-08-19 | 打样台交三件套 | 同一人第二段土办法：备案立体图 |
| 2026-08-19 | 登录定稿 A 飞书 SSO | 居中卡片 + 飞书蓝主按钮；调试入口折叠 |
| 2026-08-19 | 登录按入口分流 | 飞书内授权；外网伪装表单。字体阿里普惠体 |
| 2026-08-19 | 去掉登录页 | 进站即飞书授权；只放行伸美 tenant |
| 2026-08-19 | 行业对照后全量调 chrome | 下划线台签；紫只留给新建；姓名菜单收设置/退出；空状态当功能；拒绝页当结果页；H1=审核单 |
| 2026-08-19 | 看板 + 费用 C 档 | 审稿三栏看板；设置开工板；百度财务余额/月账单 + MiniMax 余量 + 本机台账 |
