# RF-E02-C：浏览器采样与字体链路取证

## 第 03 批独立发布范围（2026-09-06）

本批包含预览清晰度/高光保护 UI 与回归，不包含下文提及的 PDF 实验工具修复（属于第 04 批）。下文保留各轮历史诊断和验证数字，不代表本批重新运行。最新历史 React 证据以高光接入文档中的 `beian-rfe02-c-final-XGqxRg` 为准；本次修补前重新核验报告绑定的 53 个 UI 源文件哈希全部匹配，修补后仅 `MockupPage.tsx` 多一行加载门控，原历史报告不覆盖此差异。Windows、Safari、实体跨屏、真实稿及端到端文字可读性仍是独立验收项。

### 本批复审补充：旧单加载前打开灯箱

独立复审发现旧单图片尚未加载时打开原图，灯箱提前挂载后因零尺寸返回，加载后引用未变化而不重画。用实际 React 组件、延迟合成图片的本地浏览器探针复现：源图已为 40×50、预览 240×300，灯箱仍为 0×0，无 JS 异常。灯箱改为 `imageReady && imgRef.current` 后同探针变为 40×50。持久化回归位于 `apps/web/ui/e2e/mockup-lightbox.spec.ts`：每次构建当前源码到私有临时目录，所有网络拦截为合成响应，验证加载中打开、加载后自动绘制的尺寸和实际 RGBA；不依赖产品服务或已有 dist。该针对性验证不替代旧 13 个场景的整组重跑或实机验收。

日期：2026-09-05。状态：已复现并修复浏览器预览尺寸/来源缺陷及实验 PDF ROI 定位；完整物理 ROI 链路仍未配准。非正式画质验收。下文调查保留修复前事实，末节记录本次授权后的结果。

## 实际环境与证据边界

- 工作树 `beian-3d-rfe02-lighting-evidence`，分支 `codex/3d-rfe02-lighting-evidence`。
- Chromium 151.0.7922.34，headless；DPR 1、2，每种测试 1440 初始、放大至 1920、1920 刷新三种状态，高度 1000。
- 使用本分支实际 React 入口、样式、GroundedShot 和 compositor，esbuild 内存打包；复用主仓已安装依赖，未安装依赖。请求全部由 Playwright 拦截，API 为合成响应，PNG 为 E02-B 的合成文字夹具 control 产物。没有连接 Hono、生产、Illustrator 或新建 HTTP 服务。
- 5173 已被另一个项目占用，未停止或修改该进程。测试地址只是被拦截的浏览器地址，不代表访问该项目。
- 本次不提供 GLB、品牌图标等无关资产，因此截图包含对应空态/缺图；不以此报产品缺陷，也不声称完整产品 E2E 通过。浏览器 JS pageerror 六种状态均为空。
- 临时证据：`/tmp/beian-rfe02-c-PcErAd/browser-report.json`，包括应用源码哈希、输入图 SHA、请求路径、ImageBitmap 尺寸、画布与印刷面尺寸。脚本 `browser-probe.mjs` 和六张截图在同目录。浏览器已关闭。

## 已确认的两个产品预览问题

### 1. 容器放大后，旧画布被再次放大

`MockupPage.tsx` 的 GroundedShot 初始化 effect 读取 frame.clientWidth/clientHeight 和 DPR，但不观察容器尺寸或 DPR 改变。

| DPR / 状态 | CSS 宽度 | 画布像素宽度 | 应有像素宽度 |
|---|---:|---:|---:|
| 1 / 1440 初始 | 342 | 342 | 342 |
| 1 / 放大至 1920 | 502 | 342 | 502 |
| 1 / 1920 刷新 | 502 | 502 | 502 |
| 2 / 1440 初始 | 342 | 684 | 684 |
| 2 / 放大至 1920 | 502 | 684 | 1004 |
| 2 / 1920 刷新 | 502 | 1004 | 1004 |

两张产品预览均复现。放大后横向只有目标约 68.1% 的采样数，浏览器将旧画布拉伸约 1.47 倍。这能解释窗口放大后的额外模糊，不能解释初始渲染的一切模糊。跨屏 DPR 改变本次未实测。

### 2. 全图预取不等于首屏来源升级

`previewStill` 优先选 card；`previewSource` 用 createImageBitmap 将输入先缩至目标尺寸。GroundedShot 随后 `void loadStillImage(...)` 预取 full，但其结果没有替换 previewRef 或触发重绘。实际浏览器记录包含 card 取图和 full 预取，而 bitmap 缩放仍属于首屏来源。

这与 TODOS 中“全图加载后必须原位升级”的未完成项一致。它是已确认的生命周期缺口；本次没有完成同一物理文字 ROI 的 card/full 质量比较，不宣称每种屏幕下 full 都会明显改善。

## PDF 取证工具的错误与修复

`type_frequency_chain` 原来将正面局部毫米 ROI 直接当作整张展开图的页面坐标。文字夹具的正面位于 `[90,40,140,120] mm`；旧文字裁切提取结果为空，补上 `(90,40) mm` 后能提取 `RF00 4PT SAMPLE LINE`（后接合成数字序列）和 `RF00 6PT HAIRLINE`。

本次选择复用 RF-00 的 `carton_net_rectangles` 推导合成稿位置，不复制布局常量、不改 RF-00。这只适用于本实验已知合成夹具，不能推广为任意真实 PDF 的定位策略。

- 实验工具已为 text/barcode 都增加页面偏移，并标记 `diagnostic_only_not_pipeline_input`。
- 回归测试先在旧实现因空文本失败，再在修复后通过；按报告裁切回到 PDF 实际提取文字，不只断言同一套坐标公式。
- 实际 PDF 为 Helvetica Type1、4pt/6pt；包装文字进入浏览器时已经是 PNG，不由网页 CSS 字体重新排版。该合成例子不包含中文，也未验证真实稿字体嵌入/替换。
- PDF 的 144 DPI 栅格是诊断选择，不是产品流水线输入 DPI。实际 panel_front 为 2778×4444、约 55.56 px/mm；full 为 3000×3600，card 为 1200×1440。
- 印刷面在 DPR 1/2 的初始状态均以原图 2778×4444 加载，CSS 为 522×835.05，初始 transform 为 none；这不是已验证小字可读性。
- 新后处理证据 `pdf-corrected-chain.json` 单独绑定旧矩阵报告 SHA 和新实验工具 SHA；不覆盖旧报告，不将旧 Blender 运行伪装为新源码重跑。

## 建议的下一实施切片

先修预览采样生命周期，不先升 Blender 分辨率或加锐化。两个方案：

1. 保留预缩小 bitmap，容器改变时重新解码，并管理 card/full 两套缩放缓存。
2. 保留已解码来源，仅在 compositor 输出时按当前目标尺寸缩放；card 先显示，full 成功后原位接替。

推荐方案 2：避免容器尺寸泄漏到来源加载层，减少重复解码与过期 bitmap 管理；代价是全图解码内存，需复用已有加载缓存并保持懒加载，不无界增加缓存。

产品实施范围拟为 `MockupPage.tsx`、必要的 `mockupStudio.ts` 及对应纯函数/浏览器测试；实施前读 DESIGN.md。要求：

- ResizeObserver 处理真实容器变化，DPR 变化单独处理；rAF 合并尺寸更新，不只监听 window.resize，不在每次 resize 重新请求文件。
- 产品/ground/set 共享一致输出尺寸；先以可用 card 显示，full 加载成功才升级。失败保留可用来源，不因 full 失败清掉已展示 card。
- job/key 改变或卸载时拒绝旧异步结果；关闭不再使用的 bitmap，避免闪旧图和已关闭来源。
- 下载继续用 full 与同一合成器；原有地面损坏、背景三键、旧单兼容合同不变，不改变打样入队或重新跑 Blender。
- 回归覆盖首次 DPR 1/2、容器增长/缩小、侧栏切换、DPR 变化、card→full 成功/失败、切单竞态、卸载、懒加载。真实浏览器重跑相同六个状态作为最小复现集。

## 验证与剩余事项

- 本轮 Python：`test_packaging_render_quality_experiment.py` + `test_packaging_render_quality.py` + `test_packaging_glb_verify.py`，138 passed、5 SWIG 弃用警告，6.16 秒；未重跑全量测试，因为未修改产品代码。
- 未再运行 Blender；旧 E02-B 10 作业/60 pass 证据保持原样，不能称为当前后处理源码哈希下的新运行。
- full/card/浏览器之间的物理文字 ROI 投影尚未完成；缺少可读性/条码扫描的人验门槛；Windows、真实稿 L2、Safari/跨设备未测。归一化灯光仍是候选，不推广到产品默认。
- 未提交、push、PR、合并、部署，也未写批准基线。调查时产品预览修改超出原实验白名单；用户随后明确“开始授权”，本次仅扩入下节所列 UI 和对应测试。

## 授权后实施与复验

- 实施文件：`MockupPage.tsx`、`mockupStudio.ts`，新增 `mockupStudioPreview.test.ts`。保留现有合成器、原图/下载逻辑、背景三键和懒加载入口，不改 Blender 参数或业务入队。
- 取消预缩小 ImageBitmap，卡图按原始尺寸解码且仅组件局部持有；全图复用既有缓存，成功后逐层原位接替。失败保留对应卡图；set 缺失仍可降级，必需 product/ground 全部不可用时仍失败。
- ResizeObserver 与 DPR resolution 查询驱动 rAF 合并重绘；来源加载不依赖容器大小。取消/切单/卸载使旧异步结果失效，切单清空旧画布；不再生成需关闭的预览 bitmap。
- 新增 7 项单测覆盖升级、失败、缺卡兜底、必需 ground 失败、初始/升级中取消、尺寸/DPR/零尺寸与监听清理。局部共 27 项通过；UI 全量 330 项通过。
- `npm run build -w beian-ui` 通过（含 tsc），Vite 保留大 chunk 提示；指定既有后端虚拟环境 Python 后 `npm run quality` 通过，仍为 59 条既有基线，未修改质量基线。
- 工作树原本无依赖目录，初次全 UI 测试因 React 无法解析失败；复用本机已安装依赖后重跑通过。新增 node_modules / UI node_modules / tools/quality node_modules 为被忽略的依赖 symlink，不是源码或 dist symlink；UI dist 是本工作树真实构建目录。未安装新包。
- 最终浏览器证据：`/tmp/beian-rfe02-c-final-HapEy5/browser-report.json` 与同目录截图/下载。11 个采样状态尺寸断言通过，源文件哈希与最终 UI 实现一致，均无 JS pageerror。其中六个为原 DPR 1/2 矩阵，三个为 full 请求 404、保留卡图的矩阵，一个为容器缩小，一个为模拟 DPR 加显式 resize 事件。
- 先阻塞 full 响应，观察 1200px card 实际绘制，再放行并观察 3000px full 实际绘制；不把“发出了预取请求”当升级成功。两次下载 PNG 均为 3000×3600；实际点击三种背景后仍能导出。
- 修复后窗口放大：DPR 1 的 502 CSS px 对应 502 backing px，DPR 2 对应 1004 backing px，无需刷新。缩小到 1280 后也匹配当前容器。
- CDP 单独变更 DPR 在空白页也不派发 resize/resolution change，因此最初附加测试超时已保留在 `/tmp/beian-rfe02-c-final-ryp0rU`；最终测试显式派发 resize 验证回退监听。真实跨显示器自动事件及 Safari 仍未验证，不声称物理跨屏通过。
- 未运行完整产品 E2E/Hono、Windows L1/L2 或新 Blender 矩阵。合成文字更清楚不等于所有包装文字可读；画质/真实感整体任务仍未结案。

## 独立复核后的同单重渲修复（2026-09-05）

- 独立 UI 复核发现一个 P2：成功重渲保持 job ID / file key 不变，原 sourceIdentity 不触发重载；重新进入页面后，全图缓存还可能把新卡图覆盖成旧全图。使用真实加载器与模拟 Image 复现新一代显示序列为 `[B, A, A]`。这次复核只覆盖 UI 切片，不代表整个 RF-E02 分支完成审查。
- 用户明确授权修复后，静帧统一使用 `studio_relit_at`（无则 `job_finished_at`）作为 URL generation 与预览来源身份。产品、卡图、ground、set、原图和合成下载共享同一代；无时间戳旧单保持原 URL。WhiteShot 同样切代重置；GLB、印刷面和业务入队未改。
- 读取新一代全图时移除同一逻辑资源的旧缓存条目，避免重复重渲永久积累历史解码图。已在用的图片引用不被销毁，取消标记继续阻止旧异步结果发布；失败清理只删除自身 Promise，不误删后来的加载。
- 增补两项测试：URL 编码/旧单下载兼容，以及真实缓存参与的同单切代、下载与旧代缓存淘汰。UI 全量最终 332 passed，构建（含 tsc）通过，质量门仍为 59 条既有基线；`git diff --check` 通过。Vite 既有大 chunk 提示仍在。
- 最终浏览器证据位于新的独立目录 `/tmp/beian-rfe02-c-final-FZCwlx/browser-report.json`，不覆盖此前报告。DPR 1/2 实际点击页面“重渲棚”，由拦截的合成 API 返回新时间戳；检查新代卡图、全图实际绘制，打开原图并下载。13 个采样状态通过且无 JS pageerror，两份下载均为 3000×3600；53 个 UI 源文件哈希绑定此次最终实现。
- 前一轮 `/tmp/beian-rfe02-c-final-dwLhOg` 保留失败记录：刷新后的 full-failure 场景只等待第一张卡图，取样时第二张 canvas 尚为 0×0。测试脚本补齐双图实际绘制等待后重跑，不修改产品代码或尺寸断言，也不把失败批次计为通过。
- 浏览器两代使用同一合成 PNG，验证的是请求/缓存/绘制生命周期，不是 Blender 新旧像素差异；单测另以不同代 Image 验证旧缓存不能覆盖新图。全部网络拦截，未启动或调用真实 Hono/Blender，不占用或停止其他服务。
- generation 是客户端缓存身份，不是服务端不可变资产或原子多文件发布合同；后者仍属于后续 RF-03。Windows、真实稿 L2、实体跨屏与整体文字可读性仍未验收。本轮未 commit / push / PR / 合并 / 部署。
