# 成片、导出与资产路由合同

本文件保存原 AGENTS 的对应工程合同，仅在涉及本主题时读取。产品行为不构成执行作业、发送消息或操作生产的授权。日期与验收状态是记录时快照，当前结论须绑定本次证据。路径除链接外均相对仓库根。

## 打样成片与背景

打样单白底浅底+内描边；产品灯光和背景灯光分开调（静帧产品层 CSS 滤镜、白底/GLB 背景色、GLB 曝光），不重跑 Blender。下载白底是调过光的合成图。有 `white_a_ground` / `white_b_ground` 的新单走 grounded 成片：canvas 铺 `rgb(228,228,232)` 再 multiply 地面、叠产品，预览和下载同一合成器；布局仍是一屏三列（正面+侧面、反面+侧面、GLB），grounded 框 5:6，不要上 1 下 2；页头藏「下载 PPT」，灯光收到页头「调灯」后面。成片背景三键白底/银底/白桌白墙走 compositor，不排队 Blender；白/银不乘地面；白桌白墙有 `white_*_set` 时画 set+产品（不再 CSS 墙、不再乘旧 ground），缺则 CSS 近似加接触影，不是木桌。`*_set` 不能当产品静帧。GroundedShot 第一屏先读 `white_*_card`（Blender 后最长边 1440），解码成功的 full 原位替换 canvas 源；卡 415/失败回退全图，full 失败保留卡图并提示重新打开此单。`*_card` 不能当产品静帧，也不能当 `*_ground`。地面图坏了就藏原图和下载。`*_ground` 不能当产品静帧。没有地面图的旧单仍是三栏白底、浅底+内描边、页头「下载 PPT」。

成片下载在点击时冻结出图版本、背景选择和产品/背景灯光；灯箱打开时以灯箱正在使用的图层选择背景。已显示布景但布景 full 尚未就绪或失败时提示重试，不放大卡图导出或改用地面背景；当前显示地面近似时继续使用同代 full 产品/地面，不等待未使用的布景。切换版本或离开页面后，已开始的下载继续完成。原图灯箱先保留可用图层，product/ground full 无需等待 set full；set full 失败保留已显示的 set card。

## 重试、补图与进度

打样中和打样失败可重试，用机上已有稿再排，不必重传；先确认旧 worker 已退出；仍运行时遵守 [结构与宿主合同](packaging-structure.md) 的 Illustrator 禁杀阶段，无法安全退出就 409。已出图缺印刷面走 `POST /api/mockups/:id/print-faces`（V2 `render_face_assets`，不跑 pipeline/Blender，status 仍 done；持久入队立即返回 202，页面轮询补面子状态，失败可重试，刷新或离页不取消作业）；不要对 done 打 retry。下载提示走 `mockupHud.ts`（不挡点击）；GLB 全屏走 `mockupFullscreen.ts`。等待圆盘是 `WaitLoader`（对照中 / 对红中 / 打样中，不要英文 Generating）。结构导出阶段 WaitCard / `liveJobLine` 只写「打开稿件 / 盘点图层 / 保存印刷 PDF」等中文阶段，没有 `job_eta_s` 就不要编造 120 秒或 4 分钟。

## 资产与路由

下载白底只给 `front_right` / `back_left`，不要把 `ai-raster` 或 PPT 质检 PNG 当成白底。`*_ground` 映射 `white_a_ground` / `white_b_ground`，不能当 `white_a` / `white_b`。`*_card` 映射 `white_*_card`，不能当产品静帧或地面。读字只给 `read_front` / `read_back` 等 key，对应 `assets/panel_{face}.png`；不要把印刷面当白底，也不要用 GLB 或 3/4 白底静帧读小字。预览 inline 带 ETag，`private, no-cache`，未改可 304；`?download=1` 才附件且 `private, no-store`，不要把 304 空文件当下载。侧栏版本号只读 `/api/status.version`，紧跟在姓名下面，不另写常量。地址按台分开：`/reviewup` `/reviewup/new` `/review/:id` `/mockup` `/mockup/new` `/mockup/:id` `/history` `/settings`，后退换台。旧 `/` `/new` `/review` 302 到审稿台新地址。

调试：对外 `job_error` 用短中文。Node 日志写 problem + cause + fix。打开 `DATA_DIR/tasks/{tid}.json`。不要新 FastAPI 路由。

## 成片与导出补充

打样台和打样单主区白底深字（深色主题也是）；GLB 中性环境；每张图右上角下载。有 `white_a_ground` / `white_b_ground` 的新单走 grounded 成片：canvas 铺 `rgb(228,228,232)` 再 multiply 地面、叠产品，预览和下载同一合成器；正面大约 480px 的 5:6 主图；页头藏「下载 PPT」，灯光收到「调灯」后面；地面坏了藏原图和下载。GroundedShot 第一屏先读 `white_*_card`（Blender 后最长边 1440），解码成功的 full 原位替换 canvas 源；卡 415/失败回退全图，full 失败保留卡图并提示重新打开此单。`*_card` 不能当产品静帧，也不能当 `*_ground`。`*_ground` 不能当产品静帧。Blender 先出产品 RGBA，再单独跑地面 pass（EEVEE 阴影 + 接触阴影，地面 albedo 0.91），地面失败不挡产品图；重试先 `unlinkSameGenerationStills`（含地面和核对卡）。没有地面图的旧单仍是三栏白底、浅底+内描边，页头「下载 PPT」（没写成仍显示，点了出「PPT 没写成，白底仍可下」）。不提供 PDF 下载入口；点下载底部提示不挡操作；GLB 全屏居中；截图时下载钮藏起来；全屏被拒写「全屏打不开」。打样单下面印刷面读字。网页把产品叠到可调白底上，所以产品和背景能分开辨认、分开调光；GLB 本来就只导出盒身、环境灯另算。产品灯光调静帧产品层和 GLB 曝光，背景灯光调白底/地面和 GLB 底色，下载跟当前灯光走。原图是同页灯箱，不是另开未调光 PNG。打样中和打样失败可重试，先确认当前 worker 已退出；仍运行时只按既有安全取消合同处理，不能用重试绕过 Illustrator 禁杀阶段，无法安全退出就 409，不必重传。读字只给 `read_*`，对应 `assets/panel_{face}.png`，走现有 `canvasZoom.ts` 1–6×；白底仍只给 `front_right` / `back_left`，不要用 GLB 或 3/4 白底静帧读小字。详情 `publicMockup` / `fileOf` 才按磁盘补印刷面，列表 `publicMockupSummary` 不扫盘。打样 PPT 先用两张白底写 OOXML，不依赖 Node；写不出才试演示文稿运行时。缺 PPT 不要把整单判失败；内部仍用两张白底合成 PDF（页底先铺白；pymupdf 写不出且还没落盘才用已装 Pillow，不要盖掉已写成的文件，不要新装包）。磁盘上的产品 PNG 要重新打样才会变；页上灯光立刻作用。

### GLB 查看器显示

GLB 文件仍只含盒身。网页的白桌白墙由查看器容器绘制分层背景，model-viewer 保持透明，全屏沿用当前背景；白底、银底仍为纯色。默认镜头 `0deg 75deg 155%` 与最远距离 `auto auto 155%` 配套，留出四周空间，用户仍可旋转、缩放。产品滑条单独映射 GLB 曝光为 `1.1 × clampStudioLight`；该显示调整不改变静帧合成、Blender 材质、环境灯身份或下载的 GLB。网页背景不是模型内的三维桌墙，亮度和取景仍需真实样本确认。
