# AGENTS.md

请用中文回复。

## 项目

`beian`：供应链备案审核网页。打样台调用 `workers/packaging`（缺 Blender 要失败写清）。平面出图用 pymupdf（对照同一 `.venv`），杭州不要装 qlmanage。第一期验收人刘籽烨，收尾 2026-08-31。

## 硬约束

- 不重写审核引擎和 3D 流水线，在迁入代码上改。
- 不重写 3D 流水线。打样台只调用 `workers/packaging`，缺 Blender 要写清失败。
- 不得提交 `.env`、`.env.baidu`、`.env.secrets`、`backend/data` 运行时文件、稿件、Vite 缓存、`.claude/`。
- 不得 `git add -A`。`docs/designs/hangzhou-production-cutover.md` 禁止进仓（已 gitignore）。推迟的 `docs/designs/login-and-permissions.md` 未 ignore，发版只按文件名 add。
- 不得读取或打印真实密钥。
- 不得自行改 DNS、发布飞书版本、购买云、映射公网端口。
- 公网/Tunnel 后禁止显示名裸登录。
- Mac 绿灯不等于 Windows 已验收。杭州生产怎么升版见文末「Deploy Configuration」。合 `main` 后 runner 自动跑 `release.ps1`；Actions 红或公网 health 对不上 VERSION 时不要报已上线。
- 对照失败或已完成的单不能签字；干净签字单不能再对红；对红后优先读非空 `hits_v2`（空数组回退第一轮）。工艺说明 / 颜色要求 / 版本号 / 更新内容的 pending 不挡签字。
- 飞书授权失败回到飞书，不要把远程验收人送到本机 `:8787`。JSON 404 不是 Vite 挂了；只有 HTML 或空 Content-Type 才当开发页没转到 8787。

## 目录

- 网页：`apps/web/ui`（React+TS）+ `apps/web/server`（Hono+TS，对外 :8787）
- 对照 worker：`apps/web/backend`（Python，由 TS `app.cli` 调用）
- 3D CLI：`workers/packaging/`
- 本机配置：侧栏「设置」→ 默认 `apps/web/backend/data/settings.json` + `settings.secrets.json`（gitignore；`WB_DATA_DIR` 可改）。密钥不要写进前端或仓库。
- 文档入口：`README.md`（完整文档地图、启动、设置）、`DESIGN.md`（视觉）、`docs/00-charter.md`（8/31 章程）、`docs/adr-004-ousterhout-design.md`（深模块）、`docs/adr-005-packaging-structure-v2.md`（打样结构）、`docs/adr-007-packaging-render-fidelity.md`（3D 渲染真实感、材质、棚光、清晰度与能力矩阵；RF-00 测量尺、RF-01 独立合同与 RF-02 流水线接线已交 Code/L0；RF-03+ 输出代际、画质改造、批准基线及 L1/L2/UAT 未完成）、`docs/designs/review-job-module.md`（对照/对红/打样入队）、`docs/designs/illustrator-unattended-control.md`（Illustrator 完工信号与禁杀阶段）、`docs/pouch-v1-acceptance.md`（膜袋 v1：L0 已接线为 3 mm 薄盒，无杭州金标不得宣称真实膜袋能力）、`CHANGELOG.md`、`TODOS.md`。实现约定见下面「设计哲学」。
- 入口：开发口 `:5173`（Vite 听本机网卡，`/api` 反代到 8787）；产品/验收入口 `:8787`。不要再加第三个 HTTP 入口。
- 旧 `apps/web/frontend/` 已删除；网页入口只有 `apps/web/ui` + Hono `apps/web/server`。

## 加长作业（对照 / 对红 / 打样）

对照 / 对红 / 打样共用作业合同。确认合同不必启动产品。

0. 不启动产品、先核对 CLI 合同：

```bash
cd apps/web/backend && PYTHONPATH=. .venv/bin/python -m app.cli --help
```

禁止：`uvicorn`、把 FastAPI 加回来、把 `save_task` 抄回 CLI。产品入口仍是 `./scripts/dev-start.sh` → Hono `:8787`。

1. CLI 在 `apps/web/backend/app/cli.py`。stderr 打 `STAGE <name>`。stdout 最后一行是结果 JSON（不要 `ocr_text`）。不要 `save_task`。
   打样不是 `app.cli` 子命令；`jobs.ts` 调 `workers/packaging`；HTTP 仍是 `/api/mockups`。packaging stderr 打 `STAGE illustrator_<stage>|render_pdf|blender|export`（打开稿件/盘点图层/保存 PDF/出图/打样/导出）。结构阶段不要写死 120 秒。平面出图 pymupdf 先，macOS `qlmanage` 只在 pymupdf 失败时兜底。

2. 第一次 queued 落盘之后，只有 `apps/web/server/src/jobs.ts` 再写任务文件。`enqueue({ kind, id })`。路由只 save queued 一次，之后这个 tid 归 `jobs.ts`。

3. Hono 动作立即返回。没有 `/api/jobs` 资源。新建审稿/打样先走上传会话：`POST /api/uploads/sessions` 创建或找回会话，`PUT /api/uploads/sessions/:id/files/:field` 按 1 MiB 分片落盘，`POST /api/uploads/sessions/:id/complete` 生成回执；再用回执调用 `/api/tasks/start` 或 `/api/mockups/start`。`POST /api/uploads` 只保留给旧页面兼容。`GET /api/uploads` 列当前登录者的 partial 会话和 ready 回执，`DELETE /api/uploads/:id` 两者都能放弃。新稿上传用两条流式落盘通道，不得退回 `parseBody` / `File.arrayBuffer()` 整包驻留内存；第三份立即 429。审稿总量固定不超过 100 MB，上传会话和回执 30 分钟过期，并限制每人/全局数量和字节数。分片用 SHA-256 与 offset 校验，同一 `client_upload_id` 只恢复本次上传；开始接口按 `owner + source_receipt` 串行并幂等。领取回执必须原子改名为 durable claim，任务 JSON 落盘后才 commit；准备失败 rollback，进程中断后启动恢复按持久化 `source_receipt` 决定恢复回执或完成清理。用户放弃回执时先把 claim 原子改成删除墓碑，重启只能继续删除，不能还原。回执过期的稳定错误码是 `upload_receipt_expired`，UI 不匹配中文文案。UI 上传状态跨 SPA 换台保留；整页刷新可找回服务端会话，重新选择同一文件后从已确认 offset 续传。

4. 测试：抄 `jobs.test.ts` 的对照块。必写断言：第二单 queued、GET 无 `job_pid`、没有最后一行 JSON →「对照中断」、对红失败仍可签字。打样结构：`STAGE illustrator_saving_artwork_pdf` 无假 `job_eta_s`；Agent busy 不领新 AI 单。pytest：CLI 不 `save_task`；`--help` 含 `STAGE` / `save_task` / `packaging`。打样出图测 pymupdf（`test_packaging_thumbnail.py`），不要假定有 qlmanage；Blender 后写最长边 1440 的 `*_card.png`。打样 PDF 测铺白和 Pillow 兜底（`test_packaging_dieline.py`）：pymupdf 已落盘则不覆盖，不要让人再装插件。Illustrator 无人值守合同见 `test_packaging_illustrator_structure.py`：saving 禁 Kill、busy 不当 offline；盘点 hide+outline、`restoreUnattendedArtwork` 失败禁 PDF、`eachInventoryPathItem` 展开组。

5. UI 等待：`shouldShowWaitCard`（`queued` | `running` | `comparing`；`done`/`failed`/`completed` 不当等待）。离开核对页后，看板 `liveJobLine` 和侧栏 `liveNavPulse` 仍显示阶段。打样台只交稿；点进度/已出图进单独打样单（WaitCard 或成片/三图看形，下面印刷面读字），不要在打样台底下摊开结果。唯一「上刀线」（或单层「刀线」/「刀版」）默认黑盒提交识别，候选里唯一「印刷」可随刀线带上，失败对籽烨结案为打样失败，选层只给 admin；单独「印刷」和工艺板不能当刀线。打样单白底浅底+内描边；产品灯光和背景灯光分开调（静帧产品层 CSS 滤镜、白底/GLB 背景色、GLB 曝光），不重跑 Blender。下载白底是调过光的合成图。有 `white_a_ground` / `white_b_ground` 的新单走 grounded 成片：canvas 铺 `rgb(228,228,232)` 再 multiply 地面、叠产品，预览和下载同一合成器；布局仍是一屏三列（正面+侧面、反面+侧面、GLB），grounded 框 5:6，不要上 1 下 2；页头藏「下载 PPT」，灯光收到页头「调灯」后面。成片背景三键白底/银底/白桌白墙走 compositor，不排队 Blender；白/银不乘地面；白桌白墙有 `white_*_set` 时画 set+产品（不再 CSS 墙、不再乘旧 ground），缺则 CSS 近似加接触影，不是木桌。`*_set` 不能当产品静帧。GroundedShot 第一屏先读 `white_*_card`（Blender 后最长边 1440），再预取全图；卡 415/失败回退全图。`*_card` 不能当产品静帧，也不能当 `*_ground`。地面图坏了就藏原图和下载。`*_ground` 不能当产品静帧。没有地面图的旧单仍是三栏白底、浅底+内描边、页头「下载 PPT」。打样中和打样失败可重试，用机上已有稿再排，不必重传；先确认旧 worker 已退出，杀不掉就 409。已出图缺印刷面走 `POST /api/mockups/:id/print-faces`（V2 `render_face_assets`，不跑 pipeline/Blender，status 仍 done）；不要对 done 打 retry。下载提示走 `mockupHud.ts`（不挡点击）；GLB 全屏走 `mockupFullscreen.ts`。等待圆盘是 `WaitLoader`（对照中 / 对红中 / 打样中，不要英文 Generating）。结构导出阶段 WaitCard / `liveJobLine` 只写「打开稿件 / 盘点图层 / 保存印刷 PDF」等中文阶段，没有 `job_eta_s` 就不要编造 120 秒或 4 分钟。核对页优先读服务端生成的 SVG 核对面，生成或浏览器加载失败自动退高清 PNG；SVG worker 必须独立进程、限时、限输出，失败写简短 problem/cause/fix。框在 `pinBox.ts`：有 bbox 才画真框，钉在框中心，不编造顶排钉。默认只画**当前字段**的钉和框；隐藏钉只藏当前圆圈，框仍在；显示框单独开关；拖动画布暂时藏框。永不恢复全页散钉。缩放在 `canvasZoom.ts`：初始 1× 输出 `transform: none`，非初始状态才用 CSS `transform` 1–6×；`will-change` 只在实际平移时短暂启用，拖动走 rAF 且禁止 img 原生拖拽，不上 OpenSeadragon。核对窗 `reviewDock.ts` portal 到应用顶层，高于侧栏、页头、签字和画布；进页展开并叠在左侧栏上，可拖到视口任何位置，不挤页图；窗内下拉弹层再高一层。位置持久化视口 `top/left`，展开/收起按各自可见尺寸夹在视口内，不设页头下方空气墙；收起/展开 280ms 动画，边框上下左右和四个斜角都能缩放；疑点列表置顶，当前字段先 16px 嘱咐（lead / because / ask）再结论下拉，Excel 应印与稿上读到两列，「查看全部」才出命中比；包装定位写「钉不住请整面看」；这单还剩 M 条、本页还有 X 条；钉号=疑点序；一致/有错/忽略用下拉框，旁边复制，下一行人工备注；结论在页头签字旁。二维码只按完整扫码关注引导语核对，解码内容只能作审计证据，不能覆盖引导语结论或 bbox。确认单底部工艺说明 / 颜色要求 / 版本号 / 更新内容不进机审（只认字段名开头，不要误杀「备案版本号」「执行标准版本号」；旧单假疑点签字时也跳过）。离开核对页或打样台后，历史记录仍列出进行中的单并显示 `liveJobLine`，点进去仍是 WaitCard / 打样单。稿上 OCR 走 `hitText.ts`（`coverage.hit` 回退；命中比只在「查看全部」；窗和复制清单用同一套口语模板，禁止 `score=` / `0/5`；品名/品牌/logo 没字就说明稿上多半是图）。打样 V2 只认显式 `PackagingStructure`：Illustrator 对象备注/对象名/图层名精确 `packaging:cut` / `packaging:crease` 等，或与源稿哈希绑定的 sidecar；显式语义或后续由已登录账号确认并绑定源稿的候选输入，才由同一 ES3 helper 有界细分，统一到一个毫米坐标系并按连通分量隔离标注噪声。没有对象语义的旧 AI 先盘点绑定源稿的纯描边候选层；只有管理员能提交详情返回的 1–16 个候选 ID，Hono 重新校验管理员身份、`confirm_structure`、当前源稿和候选成员后生成源稿绑定清单并重跑，旧 `/1` 清单必须重新识别。非管理员详情省略 `structure_input`。旧稿涂亮把刀线候选与烫雅银等填色工艺板分成两套预览预算（各 5000 路径 / 20000 点）；Illustrator 先盘点描边层，预算满了不再读 `PathPoints`，第二遍只扫第一遍剩下的项。未知或重复涂亮层和坏掉的工艺板单独跳过，不得把整份刀线预览清掉；超大或非法几何才关掉整份预览，管理员选层入口仍在。不得把两套预算合成一份。所选线稿仍须通过完整盒身环和上下封口验证，不能直接进入 Blender。Shapely 拓扑只向已登录账号暴露完整“盒身环 + 封口组件”候选，多方案时用真实展开图视觉翻页；唯一可确认正面时服务端自动出图，多面时已登录账号只点品名面；阅读方向由最终预检的几何建议自动带入；外盒/内衬按成盒体积排序，不能读颜色。每个公开锚点必须先经最终确认引擎预检；候选身份由绑定源稿、basis 与几何的稳定 ID，加上独立的当前结构 hash 双重约束；409 表示候选过期，422 表示语义上不能成盒。尺寸精度由适配器统一提供给提案、确认和最终解析；盒身决定成盒尺寸，顶底封口让位只做闭合校验，盒盖方向由唯一共享折线推导。不得把零散矩形交给用户，也不能按颜色、普通图层名、间距、bbox 或模板自动猜。桌面待选正面必须在一屏同时放下预览、选项、原位错误与主动作；提交失败可原位重试，不叠第二层确认框。旧 `dieline.py` 冻结为回滚基线，Phase 0 + Windows 门通过后才能默认发布。GLB 必须验证 front/right/back/left/top/bottom 六面贴图来源、方向和镜像，不只核尺寸。下载白底只给 `front_right` / `back_left`，不要把 `ai-raster` 或 PPT 质检 PNG 当成白底。`*_ground` 映射 `white_a_ground` / `white_b_ground`，不能当 `white_a` / `white_b`。`*_card` 映射 `white_*_card`，不能当产品静帧或地面。读字只给 `read_front` / `read_back` 等 key，对应 `assets/panel_{face}.png`；不要把印刷面当白底，也不要用 GLB 或 3/4 白底静帧读小字。预览 inline 带 ETag，`private, no-cache`，未改可 304；`?download=1` 才附件且 `private, no-store`，不要把 304 空文件当下载。侧栏版本号只读 `/api/status.version`，紧跟在姓名下面，不另写常量。地址按台分开：`/reviewup` `/reviewup/new` `/review/:id` `/mockup` `/mockup/new` `/mockup/:id` `/history` `/settings`，后退换台。旧 `/` `/new` `/review` 302 到审稿台新地址。

调试：对外 `job_error` 用短中文。Node 日志写 problem + cause + fix。打开 `DATA_DIR/tasks/{tid}.json`。不要新 FastAPI 路由。

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

- 产品想法 → /office-hours
- 架构 → /plan-eng-review
- 完整审查 → /autoplan
- 缺陷 → /investigate
- 发 PR → /ship（只在 Mac 开发机。杭州生产机禁止 /ship 产品功能。）没听到用户说 `/ship` 或「开始 ship」不要出 PR。用户说「先不进入 ship」就只改代码。
- 合 main → /land-and-deploy（只合 GitHub。不重启杭州、不改 DNS。）
- 杭州上线 → 合 `main` 后等 `hangzhou-release` 变绿，再等约 20 秒，公网 health 的 version 等于刚合进去的 VERSION。不要报已上线。不要给杭州贴 pull / rebuild / 重启 8787 或本地执行 `release.ps1` 的升级提示词。runner 灰掉先恢复同一 runner；在途作业挡住发版就等作业结束，然后只重跑刚才那条可信 `main` push run。
- 用户贴的 `www.jianghua.site` / 开工板截图是杭州当前 VERSION，不是你工作区未合的分支。没 land 绿之前不要拿公网画面证明「已经改好了」。
- 配置发布 → /setup-deploy
- 写 issue → /spec

## 易忘约定（防记忆漂移）

升 VERSION 时：`VERSION` 文件和 `apps/web/server/src/index.ts` 里的 `VERSION` 常量必须同号。`package.json` 只写三位（npm 不认第四位）：MICRO（`0.12.8.0` → `0.12.8.1`）三位不动；PATCH/MINOR/MAJOR 才改三位。4 位号，本线现为 `0.21.x.0`。用户点名大版本才跳 MINOR。开放 PR 的 VERSION 若落后于 `main`，不合；先 `/ship` 重占号。

杭州机箱管理员必须在生产数据目录 `users.json` 中用真实飞书 `open_id` 显式绑定 `role: "admin"`，才能扫描 Blender / Illustrator（含 PATH）。姓名、花名和显示名只展示，绝不参与提权；同企业首次登录一律是 `reviewer`。删除账号、设 `disabled: true` 或调整角色后，已有飞书会话在下一次请求立即撤销或同步，不要求重新登录；公网模式还必须撤销并落盘清除旧显示名会话。退出直接删 token，不得因账号目录暂时不可读而保留。伸美其他人默认审稿员：能进审稿台，不能扫本机 exe。2026-08-24 当周不做品牌登录闪屏、申请权限工单（office-hours D1=A）。

飞书推送不必装 lark-cli。点「发一条测试」用已填的飞书应用发给**当前登录**；成功才打开 `FEISHU_ENABLED` 并在空时写入 `FEISHU_OPEN_ID`。`lark_send` 需要 `create` 权限（只读访客 403）。开工板绿 ≠ 籽烨已收到；她当审稿接收人要在「飞书推送」页自己再测。不要把开关 / open_id / bot 当主路径让人手填。探测 id `lark_send` 的 pending/结果必须画在行 `lark`，否则按钮看起来没反应。

MiniMax 未开语义复核是「未用」，不是「可用」；探测是 `GET /v1/models`，不是对话也不是余额。百度 OCR 绿 = 对照同款识别接口通了，不是静默授权。已通的密钥默认折叠，点开才改。

开工板是线性进度 + 7 行清单，不要画成圆环仪表，不要用「通 / 不通」当状态字。界面单测只测纯函数，不引入 RTL。

杭州打样平面出图走 pymupdf（对照同一 `.venv`），不要让人装 qlmanage。macOS Quick Look 只在 pymupdf 失败时兜底。打样结构以 `docs/adr-005-packaging-structure-v2.md` 为准：显式语义/有界曲线适配 → 单一毫米坐标 IR → 连通分量优先拓扑 → 必要时完整盒身环+封口组件及正面锚点确认 → 自动推导其余五面 → 现有 Blender。尺寸策略由输入适配器统一决定，盒身决定成盒尺寸，封口让位只校验闭合，盒盖方向从唯一共享折线推导；标准对开摇盖必须保留两个物理成员并按几何并集验证，未覆盖区用 Alpha Mask 露出显式纸板基底，不得填白或改用半透明纸盒。无语义或不安全结构不得进入 Blender，不得回退颜色/bbox/模板猜测。工厂旧稿全单恰好一层「刀版」或「刀线」时，第一次导出就带上该层（填色切线也算，击凹/烫金等仍是工艺板）；印刷层先精确「印刷」，否则才用唯一非刀版/工艺顶层。拼合「图层 1」、内包/标贴标当前不支持，不要停成假待确认。膜袋只认词「膜袋」，花盒折不通且两块相近刀线才走袋片。印刷、表、标注永不进默认结构提案。唯一「上刀线」（或单层「刀线」/「刀版」）默认黑盒提交候选 ID，不是把图层名当成 cut/crease；失败对籽烨结案为打样失败，选层只给 admin。拓扑成功且只有一个可确认正面时服务端自动出图；多面时只点品名面。管理员可对已出图且只有一套公开盒型的单换正面，只重跑 Blender。膜袋标准见 `docs/pouch-v1-acceptance.md`（L0 已接线；无杭州金标不得宣称产品存在）。旧稿涂亮：刀线候选与填色工艺板分预算，坏层跳过不关整份预览；超大或非法几何才 fail-closed。不得把两套预算合成一份。Illustrator 语义导出只维护一份 JSX、一份曲线 helper 和一份 `unattended_host.jsx`；macOS AppleScript 与 Windows VBScript/COM 只在运行前内联 helper 与宿主并承担平台启动桥职责，Windows 清单必须带开工板扫描到的 `Illustrator.exe`。盘点前 hide 顶层、`enterOutlineView` 只按一次 menu `"preview"` 并用 `getViewMode` 认 Outline/轮廓，zoom 0.0625。`restoreUnattendedArtwork` 在存 PDF 前执行，任一原可见顶层仍隐藏则抛 `Cannot fully restore artwork layers`，失败走已有印刷层恢复映射，不要说成语义标记问题。关稿 `prepareUnattendedClose` 再 hide+outline+zoom 0.03125。盘点 `eachInventoryPathItem` 走 `layer.pageItems` 并展开 GroupItem/CompoundPathItem；跳过 表/标注/Dimensions/尺寸；每层 remainder 上限 512；空的隐藏集合不要把 fallback 从 `document.pathItems` 闩走。完工信号是本代 `illustrator_result.json`，不是墙钟 Kill；`opening` / `inventory` / `saving_*` / `writing_result` / `closing` 期间禁止 Kill cscript。外层天花 1260 秒。心跳 busy 时新打样单排队，不是 412，也不是围栏。`illustrator-fault.json` 的 `faulted` 只在进程重启后仍有不明文档或 Illustrator 无法再启动时落下。网页新打样已固定走 V2，不再有 `PACKAGING_STRUCTURE_V2_ENABLED` 运行时开关；Phase 0 私有真值和杭州 Windows L1/L2 未绿前，不能把代码完成或身份冒烟写成真实生产验收。26H21A 仍是 land 后杭州人工金标，未跑不得宣称控制面已换。PR 不得在杭州生产 self-hosted runner 执行；Windows L1 由可信 `main` 发版在 transaction fence 内验证 COM→JSX，不替代真实稿 L2。GLB 除轴向和毫米尺寸外，还必须验证六个已确认面的纹理来源、方向与镜像，底面空贴图不得通过。离开核对页后看板/侧栏/历史记录仍看阶段，不要只把进度画在 WaitCard 上。核对页优先 SVG、失败自动退高清 PNG；初始无恒等 transform，只有非初始缩放/平移才用 CSS transform，`will-change` 只在平移时临时开启，不要接 OpenSeadragon。核对窗液态玻璃 portal 到应用顶层，可覆盖侧栏、页头、签字和画布；持久化视口 `top/left`，展开/收起按当前可见尺寸碰撞，可拖到视口底边，窗内弹层再高一层；收起/展开有动画，边框上下左右和斜角都能缩放；疑点列表置顶，当前字段先嘱咐再两列证据，定位和人工操作在下；隐藏钉只藏当前圆圈；显示框单独开关。打样台和打样单主区白底深字（深色主题也是）；GLB 中性环境；每张图右上角下载。有 `white_a_ground` / `white_b_ground` 的新单走 grounded 成片：canvas 铺 `rgb(228,228,232)` 再 multiply 地面、叠产品，预览和下载同一合成器；正面大约 480px 的 5:6 主图；页头藏「下载 PPT」，灯光收到「调灯」后面；地面坏了藏原图和下载。GroundedShot 第一屏先读 `white_*_card`（Blender 后最长边 1440），再预取全图；卡坏了回退全图。`*_card` 不能当产品静帧，也不能当 `*_ground`。`*_ground` 不能当产品静帧。Blender 先出产品 RGBA，再单独跑地面 pass（EEVEE 阴影 + 接触阴影，地面 albedo 0.91），地面失败不挡产品图；重试先 `unlinkSameGenerationStills`（含地面和核对卡）。没有地面图的旧单仍是三栏白底、浅底+内描边，页头「下载 PPT」（没写成仍显示，点了出「PPT 没写成，白底仍可下」）。不提供 PDF 下载入口；点下载底部提示不挡操作；GLB 全屏居中；截图时下载钮藏起来；全屏被拒写「全屏打不开」。打样单下面印刷面读字。网页把产品叠到可调白底上，所以产品和背景能分开辨认、分开调光；GLB 本来就只导出盒身、环境灯另算。产品灯光调静帧产品层和 GLB 曝光，背景灯光调白底/地面和 GLB 底色，下载跟当前灯光走。原图是同页灯箱，不是另开未调光 PNG。打样中和打样失败可重试，先杀掉当前 worker 再用机上已有稿再排，杀不掉就 409，不必重传。读字只给 `read_*`，对应 `assets/panel_{face}.png`，走现有 `canvasZoom.ts` 1–6×；白底仍只给 `front_right` / `back_left`，不要用 GLB 或 3/4 白底静帧读小字。详情 `publicMockup` / `fileOf` 才按磁盘补印刷面，列表 `publicMockupSummary` 不扫盘。打样 PPT 先用两张白底写 OOXML，不依赖 Node；写不出才试演示文稿运行时。缺 PPT 不要把整单判失败；内部仍用两张白底合成 PDF（页底先铺白；pymupdf 写不出且还没落盘才用已装 Pillow，不要盖掉已写成的文件，不要新装包）。磁盘上的产品 PNG 要重新打样才会变；页上灯光立刻作用。

## Design System

改任何界面之前先读 `DESIGN.md`。字体、色、间距、侧栏、核对页都以那份为准。锁定稿是 Figma Web 页，不是飞书顶栏。

- Figma：https://www.figma.com/design/BL3PGUjLGLPb9iUZMzRhD6 （`Web · 锁定稿`。侧栏材质对照：`Web · 侧栏材质对照`。iPad 页是探索，不是实现依据。）
- Ant Design 6 只当零件箱。`colorPrimary` = `#805898`，不要默认蓝，不要旧主色 `#722ED1`。
- 左侧玻璃侧栏切「审稿台 / 打样台 / 历史记录 / 设置」。展开 280px，折叠 76px。不要飞书顶栏。页底淡紫雾；侧栏与主区连成一块 28px 圆角工作场。≤1024 默认折叠；≤720 展开为遮罩抽屉。
- 侧栏顶用 `apps/web/ui/public/brand/logo-mark.png`。折叠时悬停变成展开按钮（同一 44pt）。完整 `shine-mage.png` 只放拒绝页。
- 左下角飞书头像 36px + `花名（真名）` 15px，例如 `天元（魏炜）`；服务端版本用弱化文字紧跟在姓名下面。
- 空审核单不画三栏。设置里有「外观」：主题、13–28px 字号（可手写）、侧栏材质（实心 / 毛玻璃 / 液态玻璃）、侧栏雾面对比度滑条、差异标记。只写 `localStorage`。深色走品牌紫雾，不是灰黑中台。
- 审稿：专属核对页，画布吃满宽度。核对面优先 SVG，失败自动退高清 PNG；初始 1× 不施加恒等 transform，`will-change` 仅在平移时临时启用。钉和框分开关，只作用于当前字段；「隐藏钉」只藏当前编号圆圈，永不恢复全页散钉。左图 CSS transform 缩放（1–6×），拖动走 rAF，禁止原生图片拖拽，不上 OpenSeadragon。核对窗 portal 到应用顶层，可覆盖侧栏、页头、签字和画布；进页展开并叠在左侧栏上，可拖到视口任何位置，不挤页图。展开/收起按当前可见尺寸碰撞，可拖到底边；窗内弹层再高一层。收起/展开有动画，边框上下左右和斜角都能缩放。疑点列表置顶，当前字段先 16px 嘱咐再结论下拉，Excel 应印与稿上读到两列；包装定位和人工操作在下。结论写在页头签字旁。禁止「AI 已过审」。
- 历史记录是侧栏 tab，不是第三张台。进行中的审稿/打样也列在里面，点进去看进度。
- 打样台 8/31 不对业务开放。打样台和打样单主区白底深字（不是紫雾台，深色主题也是）；有地面图的新单走 grounded 成片（台面 `rgb(228,228,232)`），布局仍是一屏三列，grounded 框 5:6，不要上 1 下 2；第一屏 1440 核对卡、点原图换全图，预览和下载同一合成器，页头藏「下载 PPT」，灯光收到页头「调灯」后面；成片可切白底/银底/白桌白墙，当场合成不重打。没有地面图的旧单仍是上面三图看形、浅底+内描边、页头「下载 PPT」。缺印刷面时事故条在三图之上，可补则「补印刷面」。下面印刷面读字；每张图右上角下载，不提供 PDF 下载入口；截图时下载钮藏起来。QA 时标出任何与 `DESIGN.md` 不符的实现。

## Testing

三层。`npm test` 只等于 L0。不要在杭州跑单测。不要单测打外网、OCR、Blender、Illustrator COM。

- L0 单测（Mac，`/ship` 必绿）：仓库根目录 `npm test`。复杂度工具链独立运行，不把 Knip 的 Node 版本要求泄漏到产品 `Node >=20` 合同；`/ship` 还必须在 Node 20.19+ 或 22.12+ 下执行 `npm run test:quality` 和 `npm run quality`。
  - 服务端：`npm run test -w beian-server`（`node:test`，`apps/web/server/src/*.test.ts`）
  - 界面：`npm run test -w beian-ui`（`node:test`，`src/**/*.test.ts` 自动发现；纯函数，不引入 RTL）
  - 对照 worker：`cd apps/web/backend && .venv/bin/python -m pytest -q`（CLI 契约 + 对照/打样单测。没有 FastAPI 测试）
- L1 冒烟（杭州 `hangzhou-release`）：`release.ps1` 在 transaction fence 内查 health.ok、version==VERSION、8787 listener、logo PNG，并通过生产 Session 1 Agent 验证管道 → VBS → 唯一 JSX 的身份链。不跑 `npm test`，也不替代真实稿 L2
- L2 金标（人核定后）：`apps/web/backend/scripts/run_eval.py`。未核定的 `data/gold` 不进默认 `npm test`
- 类型：`npm run typecheck -w beian-server` 与 `npm run build -w beian-ui`
- 浏览器交互（Mac）：`npm run test:e2e`（Vite + 合成 API，只验证页面行为，不替代真实 Hono / Windows L1）
- 复杂度门禁（Mac / GitHub-hosted PR）：`npm run quality`；基线只读、只能经评审缩小，新增发现、过期条目或相对 base 扩张都失败。本地自动解析 `origin/HEAD`（再回退 `origin/main` / `main`），找不到目标分支就失败关闭；CI 使用 PR base 精确 SHA。同文件同名诊断按重数比较，行号移动不改变身份，但新增第二处不能被折叠。`npm run quality:deep` 只生成手工清理报告，不自动删除。`npm run test:quality` 还要求 `.agents/skills` 实际目录、审核清单与 `skills-lock.json` 完全一致；项目 skill 不自动授予 shell。`antd` 是仓库 vendored 源，只能经 `scripts/quality/antd-readonly.mjs` 调固定 6.6.1；禁止用上游 restore/update 覆盖本地 hardening，恢复走受信任 Git 提交并重验哈希。
- `.github/workflows/quality.yml` 的 Linux Node 22 质量 job 与 `windows-2022` PowerShell 5.1 合同 job 都使用 GitHub-hosted runner；禁止使用杭州/self-hosted runner。Windows job 实跑 `.NET File.Replace` 无备份原子替换，并验证 Illustrator Agent 计划任务的隐藏窗口、持久/临时触发器和 `Quiesce` 顺序；它不注册或控制生产任务，不调用 `release.ps1`，也不替代杭州 L1。Knip 只锁在 `tools/quality`，Vulture 只放 `requirements-quality.txt`，两者不得进入杭州生产依赖图。
- 新逻辑要有行为测试（含失败路径）。不要把密钥写进测试。

## 设计哲学

来源：John Ousterhout《软件设计的哲学》第 2 版，经 Codex 顾问蒸馏（`docs/adr-004-ousterhout-design.md`）。管复杂性，不是把文件切碎。

- 以 2026-08-31 刘籽烨独立完成 Excel↔PDF 人工终审为当前首要目标；不为 ERP、BI、自动审批或 3D 业务开放扩展设计。
- 优先做深模块：对外接口少而稳定，把进程、路径、超时、供应商差异和失败处理藏在实现内。
- 遇到只转发参数、迫使调用者理解内部步骤的浅模块，先尝试加深现有模块，不要继续叠包装层。
- 把 `apps/web/server` 作为唯一 HTTP 产品边界和 `:8787` 唯一验收入口。
- 把 `apps/web/backend` 视为 worker；TS 只能通过 `python -m app.cli` 调用，不得新增 Python HTTP 路由或以 uvicorn 启动产品。
- 不得在 `:5173`、`:8787` 之外增加第三个开发、验收或生产入口；必须写清每个现存入口的用途。
- 新登录、身份、会话和计费能力只放在 `apps/web/server` 的 Hono 层，不得复制到 Python。
- 保持不同层有不同抽象：UI 表达审核动作，Hono 表达产品用例，Python 表达对照命令，`workers/packaging` 表达 3D 作业。
- 把复杂度向下拉：调用者不应知道 Python 模块结构、Blender 命令、飞书 OAuth 步骤或供应商账单分页。
- 会一起变化且共享隐藏知识的代码放在一起；仅因文件较长，不得机械拆分。
- 不得「一页签一个 package」或「一动作一个 5 行函数」；按稳定接口和信息隐藏划分模块。
- 新增参数前先判断能否在模块内部推导默认值，避免把特殊情况和供应商细节泄漏给调用者。
- 能通过接口定义消除错误就不要增加错误分支；不能消除时，返回可执行、面向用户的失败原因。
- `workers/packaging` 缺 Blender 时必须明确失败，不得静默降级、伪造成功或另建 3D 流水线。
- 每个非琐碎改动先比较至少两个设计，记录为什么选择接口更小、泄漏更少的方案；预留约 10%–20% 时间做设计。
- 注释写约束、原因和失败语义，不复述代码；名称必须体现产品边界，如 worker、snapshot、human decision。
- 沿用已有术语、路径和错误格式；已删除旧 `frontend/` 和 FastAPI HTTP 壳，产品路径只有 React UI + Hono，对照只走 `python -m app.cli`。
- 人工终审不可抽象成机器过审；账单 `charge_status` 必须保持 `unknown`，除非已有可核验的供应商扣费事实。

## Deploy Configuration (configured by /setup-deploy)

- Platform: 杭州 Windows（UU 远程「人事-台式」）+ Cloudflare Named Tunnel。不是 Fly / Vercel。生产发布的 GitHub Actions 只跑 **self-hosted `hangzhou`**（机器名 `hangzhou-windows`）；GitHub-hosted runner 只跑 `.github/workflows/quality.yml` 的质量合同，禁止升生产。
- Production URL: https://www.jianghua.site
- Deploy workflow: `.github/workflows/hangzhou-release.yml`（仅 `push` `main`；从事件 SHA 下载发布组件到 `RUNNER_TEMP`，再以不可变 `TargetSha` 操作 `D:\beian`；PR 与可选择 ref 的 `workflow_dispatch` 禁止触达生产 runner）。
- Deploy status command: 无平台 CLI。看 [hangzhou-release](https://github.com/weiweity/beian/actions/workflows/hangzhou-release.yml) 是否绿。杭州环回才是杭州进程：`curl -sS http://127.0.0.1:8787/api/health`。公网 health 仅在 Named Tunnel 跑在杭州时有效。
- Merge method: squash
- Project type: web app（Hono `:8787`）
- Post-deploy health check: Actions 绿后再等约 20 秒，`https://www.jianghua.site/api/health` 的 `version` 等于刚合进去的 `VERSION`，且带 `jobs.illustrator`。隧道必须在杭州；Mac 上的 cloudflared 不当生产。`/api/health` 的 `version` 目前写死在 `apps/web/server/src/index.ts`，不能单独当发版证据；以杭州工作树 `VERSION` 文件和 merge SHA 为准。

### 机器分工

- Mac：开发。入口 `http://127.0.0.1:8787`。跑 `/ship`（出 PR）和 `/land-and-deploy`（squash 合 `main`）。不要 SSH。不要把 `www.jianghua.site` 当本机开发入口。不要只开 Vite `:5173` 就点开始打样/对照——`:8787` 没开时 `/api` 会变成 HTML，单不会入队。
- 杭州 Windows「人事-台式」：生产。入口 `https://www.jianghua.site` → 本机 `:8787` → Cloudflare Named Tunnel（只在杭州跑）。仓库 `D:\beian`，数据 `C:\supply\data`（`WB_PUBLIC=1`，`WB_DEV_DISPLAY_LOGIN=false`）。self-hosted runner 机器名 `hangzhou-windows`、标签 `hangzhou`。密钥只在杭州开工板 / `C:\supply\data`，不进仓库；Mac 不要要、不要写密钥。
- 远程：UU 远程用来看着人事-台式。Mac 对话不能 SSH 进杭州，也不能把 UU 当成自动部署后端。杭州机开机即可；`:8787`、cloudflared、Actions runner 是 Windows 服务（无人值守）。Illustrator/Blender/对照仍要交互桌面，不要做成 Session 0 服务。

### Custom deploy hooks

- Pre-merge: `/ship` 已跑 `npm test` 与 ui build。Mac `/land-and-deploy` 只合 GitHub。
- Deploy trigger: **合进 `main` 后，只由杭州 self-hosted runner 处理该次可信 `main` push**。workflow 从事件提交下载绑定过的发布组件，并把同一个完整 `GITHUB_SHA` 作为不可变 `TargetSha` 交给 `release.ps1`；杭州 checkout 里的本地脚本不是兜底入口。runner 灰掉就先恢复同一 runner；对照/打样/Illustrator 在途就等作业结束，然后仅对刚才那条 push run 使用 **Re-run failed jobs**。`0.19.x → 0.20.x` 首次切换也是在批准维护窗停止旧 WinSW 后重跑同一失败 run，不创建 `workflow_dispatch`，不从分支、本地 checkout 或另一 SHA 发版；来源已是 `0.20` 或目标达到 `0.21` 时不得复用该授权。

  发布脚本在不停服时完成不可变 SHA、依赖图、离线运行时和 admission readiness 核对；随后用 ACL journal、SYSTEM watchdog、WinSW 停服、ff-only、UI 构建、InteractiveToken Agent 同步、transaction fence 和 Session 1 L1 身份冒烟组成一个恢复事务。请求生命周期必须由 Node `fetch` 最外层的 `ReleaseCoordinator` 按请求登记，并同时等待 handler 与 `ServerResponse finish/close/error`；不得退回 Hono 中间件标量计数、`Response.body` 包装器、超时清零或 PID/连接数猜测。恢复必须在独占锁内重读 journal；回滚到不理解 fault fence 的 legacy 版本前会保持 8787 停止，并要求 Illustrator fault 文件及 Illustrator/AIRobin/cscript/wscript 全部不存在。脚本不杀全部 `node.exe`，不做 PID 型 listener 清理，不动 cloudflared，不在停服后在线安装 npm/Python 依赖。密钥只在杭州数据目录和 loopback 控制头内，不进仓库或日志。细节见 `scripts/windows/README.md`。

- 杭州 Grok 禁止：在生产机 `/ship` 新功能、改产品代码当开发机用、把生产隧道指到 Mac、对照跑着时 pull/重启、`git reset --hard`。发版后若只脏 `package-lock.json`，杭州自己 `git checkout -- package-lock.json`。
- Mac Grok 禁止：
  - `cloudflared tunnel run beian`（隧道只能在杭州，抢了就 1033/串台）
  - 合完 PR 立刻说「已上线」
  - 给杭州贴 pull / rebuild / 重启 8787 或本地执行 `release.ps1` 的升级提示词；runner 灰掉只恢复 runner，在途作业结束后只重跑同一可信 push run
  - 把 `www.jianghua.site` 当本机开发入口
  - 改 Cloudflare DNS、飞书控制台、买云、映射端口
  - 指挥杭州改产品代码或当开发机
  - 向杭州要密钥
- 杭州运维（Mac 不改、不贴升级步骤）：Clash 系统代理时备案域名必须直连，否则进度条会绕日本节点；Error 1033 = Named Tunnel 和 `:8787` 都不在，杭州自己拉起，Mac 不动 DNS。站点拆包是以后的产品活。
- `release.ps1` 起停 `:8787` 只走 WinSW 服务 `beian-server-8787`（`Restart-Service`），不要 `schtasks /Create ONLOGON`。cloudflared 是官方 Windows 服务（token），发版不动隧道。
- Deploy status: [hangzhou-release](https://github.com/weiweity/beian/actions/workflows/hangzhou-release.yml) 绿 → 约 20 秒 → 公网 health 的 version 等于 VERSION。公网再用 `/canary https://www.jianghua.site` 前，先确认 Mac 没有 cloudflared。
- Health check: `https://www.jianghua.site/api/health` 必须打到杭州。细节见 `scripts/windows/README.md`。
