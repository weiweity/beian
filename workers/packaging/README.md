# AI 包装稿 → 3D/PPT 快速流水线

这是包装平面稿到既有 Blender 流水线的本地批处理入口。V2 不再把“红线、间距或 bbox 看起来像盒子”当作可自动接受的结构事实；它消费版本化 `PackagingStructure`，把结构识别、拓扑验证、人工确认和 3D 生成分开。旧 `dieline.py` 只保留给命令行诊断，不在网页新任务路径中。

结构事实与成盒闸门以 `docs/adr-005-packaging-structure-v2.md` 为准；渲染真实感、family 几何分派、纸材/涂层、棚光、清晰度预算和质量评测以 `docs/adr-007-packaging-render-fidelity.md` 为准。RF-00 测量尺、RF-01 独立合同和 RF-02 流水线接线（含 RF-02.3 磁盘执行边界）已交 Code/L0：新 V2 任务在切面栅格前解析 persistable render plan，写入 resolved job、fingerprint 和 result；这没有改变 Blender 几何或棚光。非 V2 只是命令行诊断路径，不是网页产品通道。RF-03 本地产物验证、资源生命周期与 Windows 托管代码，以及 RF-04 出图版本 API/UI 已实现；生产注册、原生 Windows 验证、RF-05+、approved baseline、L1/L2/UAT 和断电耐久性仍未完成。`0.21.25.0` 起的膜袋仍只是 `add_box` 生成的 3 mm 薄盒预览，不是写实软袋。

RF-03 新候选路径由 `render_generation.py` 校验实际 GLB、full/card 和六面 PNG 网格，Hono 的 `renderGenerationBudget.ts` 把磁盘预留、运行输出/RSS 采样、封存与最终 current 提交绑定到同一资源和时间预算。一次性 `runtime_verified` 凭证仅表示本轮产物合同与资源执行验证，不代表人工视觉通过。正常 registry 只接受系统临时目录内的显式本地评审数据根，生产注册与主 Node 桥的 Windows 新建仍关闭，没有可打开生产能力的环境开关。独立候选 L0、历史开发证据和未完成门见 [RF-03 收口记录](../../docs/designs/packaging-quality-rf03-runtime-closeout.md)。 RF-04 在同一打样单提供“出图版本”：历史切换改变团队共享 current，不启动 Blender；重新出图期间保留当前成片，文件读取和下载绑定同一代。旧 `/relight` 已转入同一代际队列，托管代禁止旧换正面/补面入口原位覆盖；生产新代执行和升级仍未开放，HTTP、操作及本次 Code/L0 证据见 [RF-04 交付记录](../../docs/designs/packaging-quality-rf04-closeout.md)。

当前可验证的语义来源有两种：

- 同稿件哈希绑定的 `packaging-structure/1` JSON sidecar；
- Illustrator 中对象的备注、对象名或图层名精确写成 `packaging:cut`、`packaging:crease`、`packaging:perforation`、`packaging:glue` 或 `packaging:ignore`，由语义导出器同时生成结构 JSON 和隐藏这些对象后的 artwork PDF。
- macOS 用 AppleScript；Windows worker 通过 UTF-8 命名管道请求登录桌面的 PowerShell Agent，Agent 再调用现有 VBScript/COM。两端都执行 `export_structure.jsx`，不维护第二套 Windows 识别算法。Windows 清单必须传开工板扫描到的 `Illustrator.exe`；LocalSystem 服务和 runner 禁止自己拉起 Illustrator。

为迁移旧稿，Illustrator 先通过 `illustrator-stroke-proposal/1` 来源适配器盘点未分配的“仅描边、无填充”候选层，形成有上限、绑定当前源稿 SHA-256 的 `packaging-structure-input-candidates/2` 输入清单；`/2` 保留 Illustrator 原始图层名，并把不同物理层的同名或空格等价名称失败关闭，旧 `/1` 清单必须重新识别。普通 OCG、图层名、颜色或白色区域都不能自动选层。盘点时刀线候选与填色工艺板分预算：先扫描描边层，预算再装不下一条两点路径时不再读 `PathPoints`，第二遍只扫第一遍剩下的项；坏掉的工艺板单独跳过，不得清掉已有刀线预览。打样单详情只向管理员开放本次候选 ID 的多选入口；非管理员详情省略图层候选。Hono 校验管理员身份、`confirm_structure`、当前源稿身份和候选成员后，才把对应图层名写入新的源稿绑定清单并重跑同一作业。所选线稿仍是不可信输入：直线保持端点；贝塞尔曲线由 Mac/Windows 在运行前内联的同一份 ES3 helper 自适应细分，并把容差、源路径、分段数和 repair 写入 `source.geometry`。所有几何只进入一个画板左上角毫米坐标系，且完整盒身环与上下封口未通过时不得进入 Blender。

候选不是结构事实。解析器先按连通分量隔离刀版与尺寸标注、表格、签字框，再在有界预算内寻找“四个连续盒身面 + 上下封口组件”。完整单片盖板必须接近成盒 footprint；标准相向对开摇盖则要求两个成员连接相对盒身、单片覆盖 45%–55%、成员总和不超过 102%、组合几何并集至少覆盖 94%，短防尘翼或插舌不能单独冒充顶部/底部。每个物理成员保留自己的共享折线、仿射变换与覆盖范围；PDF 未绘制区和物理未覆盖区都输出 Alpha 透明遮罩。Blender 用 Alpha Clip 覆盖在显式纸板基底上，绝不拉伸印刷稿或填成白块；最终 GLB 会解码内嵌 RGBA PNG 并逐像素核对源图，回读六面 UV 方向/镜像，并验证唯一纸板 Core 是闭合连通流形且尺寸、表面积、体积和六个实体边界完整。未知基材默认白卡，牛皮纸或深色纸板必须在渲染配置中显式声明，不从稿件颜色猜。成盒尺寸只由盒身求解。外盒和内衬同时结构完整时各自成为候选并按体积排序，管理员叠着真实 artwork 通过视觉翻页选择整套盒型（仅多方案时），再只选择产品正面；颜色不参与识别。预检为每个可选正面写入几何推导的 `preferred_quarter_turns`，页面自动把它作为内部锚点提交；每个公开锚点都已由最终确认引擎预演，其他组合直接禁用。提交时再按源稿、结构 hash、basis 和稳定候选 ID 复核；缺失或畸形的推荐方向、hash 或 source 会整套丢弃，要求重新识别。其余五面由连通关系推导后进入现有 Blender。它不会自动接受，也不会回退旧方盒算法。

颜色、普通图层名和文件名不自动升级成语义。CF2/DXF、ISO 19593 等格式必须各自有已验证样本和专用适配器后才能接入，不能伪装成已支持。目标是在显式结构语义可追踪时完成：

1. AI/PDF 兼容性和页面尺寸预检；
2. 非 PDF 兼容 AI 自动调用 Illustrator 标准化；
3. 印刷层与完整图层分别高速栅格化（pymupdf 出图，杭州不靠 macOS qlmanage）；
4. 按切面切片纹理（膜袋只印正反，其余面空白纸面补齐）；
5. 多产品并行调用 Blender 后台建模、渲染并导出 .blend / .glb；静帧先出产品 RGBA，再单独跑地面 pass，地面失败不挡产品图；
6. GLB 自动复核轴向、毫米尺寸，以及 front/right/back/left/top/bottom 六面贴图来源、方向和镜像；
7. 用两张白底写成 1 页 OOXML PPT（正面+侧面、反面+侧面），不依赖 Node；写不出才试演示文稿运行时。导出时用 `png_bytes_over_white` 铺白，不覆盖磁盘上的 RGBA 产品层。stderr 打 `PPT 跳过` 时静帧、PDF 和 GLB 仍算成功，不要把整单判失败。`--no-ppt` 同样跳过 PPT。
8. 两张白底合成一页 PDF（页底先铺白，槽按源图比例 contain，标题用中文字体）。同样只在导出时铺白。pymupdf 写不出且还没落盘再用已装的 Pillow，不另装包，不要盖掉已经写出的文件。缺 PDF 不当失败。

## Phase 0 只读语料审计

默认切换 V2 前，先用独立输出目录记录真实 AI 的哈希、画板、OCG、矢量数量、结构候选、当前解析结果和人工真值。工具不会复制或改写源稿，也不会改变线上生产选择：

    python3 tools/audit_corpus.py \
      --corpus-dir /path/to/private-ai-corpus \
      --truth /path/to/private-corpus-truth.json \
      --output-dir /path/to/private-phase0-evidence

真值格式参考 examples/corpus_truth.example.json。真实稿、真实真值和审计输出都不要提交。工具会校验阈值范围、正尺寸、完整六面、90° 旋转、人工批准人，并汇总候选方盒、结构族和黄金样本。只有每份样本都被人工批准或明确判为不支持、每个支持结构族至少有一份黄金样本、支持样本六面已确认、几何安全阈值已冻结后，才加 --require-phase0-exit 作为 Phase 1 入口门。

## RF-00 渲染质量测量尺

`tools/render_quality_eval.py` 用固定的合成夹具观测当前包装 3D 输出，只建立后续改进所需的测量合同，不改变 `pipeline.py`、Blender 场景或产品图片。清单包含 6 个已支持的矩形盒场景（白盒、深色盒、高盒、宽盒、字体频率和透明边缘）以及 1 个必须明确判为不支持的圆柱场景；结果不能代替杭州 Windows L1、真实稿 L2 或人工 UAT。

在仓库根目录运行：

    apps/web/backend/.venv/bin/python workers/packaging/tools/render_quality_eval.py \
      --output-dir /tmp/beian-render-quality-rf00-run-1

`--output-dir` 必须是仓库、产品数据目录和 `WB_DATA_DIR` 之外、父目录已经存在的全新专用目录；工具不会复用已有目录。需要指定 Blender 时加 `--blender /absolute/path/to/blender`。未找到 Blender 会明确失败，不会伪造结果或降级到另一条 3D 流水线。

输出只写入该目录，包括 `rf00-report.json`、`contact-sheet.png`、每个夹具的渲染与测量产物；批准基线不在普通采集时写入。只有人工评审确认本次报告完整且成功后，才能显式增加 `--update-baseline`。CLI 只允许把批准基线写到 `workers/packaging/fixtures/render-quality/baselines/`，并会同时校验输入、评估器、渲染作业、流水线、相机、模板、渲染配置、清单、依赖版本和嵌套指标身份。当前仓库没有正式批准基线。

合同测试不需要 Blender：

    cd apps/web/backend
    .venv/bin/python -m pytest -q tests/test_packaging_render_quality.py

## 运行

    # 网页打样台会调这份 CLI。本机直接跑也可以。PPT 用白底写 OOXML，不依赖 Node。不要提交 node_modules。
    python3 pipeline.py examples/jobs_26H17.json --workers 2 --force

`examples/jobs_26H17.json` 与 `examples/jobs_illustrator_smoke.json` 未写 `structure_engine=v2`，只走非 V2/命令行诊断路径，不是网页产品通道。生产与 smoke 模板不再带散落 `render`；该诊断路径通过 `render_contract.v1_diagnostic_render()` 取得历史 6 键参数（生产 `3000×3600`、smoke `1200×1440`、白底 `[1,1,1,1]`），不会裸 `KeyError`，也不会把 V2 再变成双事实源。网页新建打样单仍必须写 `structure_engine=v2`。

V2 任务在产品项中写 `"structure_engine": "v2"`。显式 sidecar 可写 `structure_sidecar`；已从结构对象清理出的印刷稿可写 `artwork_pdf`。网页 `.ai` 通道由 Illustrator 同时导出这两个文件。结构模板只声明 `render_profile_id` 和可选对象 `output_request`：生产花盒用 `compat-legacy-v0`，Illustrator smoke 用 `smoke-v1`。缺 profile、未知 profile / family、falsy 非对象 output request，或模板 raster 与 spec 冲突时只用 spec。这些检查都在 `render_face_assets` 和 Blender 之前失败关闭。普通新任务缺 render spec 永远失败，不会合成兼容合同。

`pipeline.py` 只消费合同深入口返回的已验证 plan（spec、平面 render、sampling、四项顶层 identity、fingerprint token）。新任务 + 缓存结果走 `render_plan_for_new_job_and_persisted_result`（同一次 registry snapshot）；Blender 启动走 `blender_execution_plan`（校验真正交给 Blender 的磁盘 payload，四项顶层 identity 与 spec 派生 flat render 必须齐全且与内存一致）。磁盘/内存相等不等于路径合法：六面 `assets` 必须恰好是本单 `assets/panel_{face}.png` 的非 symlink 普通 PNG。它不读 registry，不复制 nested hash 字段名。Blender 仍读平面 `render` 参数。切面宽度只取 plan 里的 `legacy_raster_width_px`。

所有非 cache Blender 任务都从当前内存 job 写成私有执行快照并注入本轮 `execution_nonce`，subprocess 不再直接读可被改写的 `resolved_job.json`。V2 在生成快照前仍走 `blender_execution_plan` 的磁盘/内存/spec/路径/asset 校验。非 V2 诊断路径跳过该 V2 合同校验，但仍用同一套私有快照和 nonce。Blender 返回的 `blender_result.json` 是不可信边界：必须回传同 nonce，只接受测量字段，`code`/`outputs` 必须与执行快照 canonical 全等；未知字段、越界输出或 `project_dir`/`render`/`spec`/identity 注入在写核对卡和 relight 提交前失败。

首次运行加 `--force`；同一源文件、结构、artwork、流程版本和 plan fingerprint token 未变化时，去掉 `--force` 会复用缓存。缓存命中还要求：result 绑定本次实际 `project_dir` 与预期 `resolved_job.json`（不信 previous 自报路径），sidecar `validation.status=accepted`，result 带完整 spec，四项 identity 一致，六面 assets 与 blend/glb/front/back 均在本单目录内互不重复（已存在文件比 inode，未存在目标按 casefold）、非 symlink、非空、带格式签名；未知 output key 或与 resolved_job/六面 assets/source/template（含 symlink 目标与 hardlink 同 inode）重叠只 miss。该缓存路径的格式检查只读文件头 8 字节；RF-03 新候选路径另有内容 SHA、实际产物验证和不可变 generation manifest，不能用旧缓存命中替代它。只改 JSON 空白不改变规范化合同 hash；registry 原始字节变化通过 plan identity 使缓存失效。

`--blender-only` 只处理已有 `resolved_job.json`：已含完整 spec 时严格绑定到本单 family/hash/三轴尺寸，四项顶层 identity 与派生 flat render 必须存在且一致，hash / profile / registry 身份被篡改则拒绝。缺 spec 时，只有已知 pre-RF02 V2 作业（`pipeline_version=1.4.0` 且 `structure_engine=v2`）才合成 `source=legacy_synthesized` 的 `compat-legacy-v0`；当前/未来/未知/缺版本且缺 spec 一律拒绝。合成还要求历史实际持久化的最小 render 键（substrate/resolution/camera/rotation）完整且逐项匹配 compat；`None`、`{}` 或缺键失败，不要求当时未持久化、由 Blender 默认提供的新键。缺少可证明 family / 完整六面 / 结构身份时失败，不按文件名、颜色或任务 ID 猜。

现有 `--blender-only` 重渲先在临时目录生成并验证全部新输出；提交前才对流式拷贝到磁盘的原已存在文件建备份，并记录每个目标提交前是否存在。任一第 1..N 个替换或最终 job 写入失败，恢复原文件、删除本轮新建目标（含 optional ground/set/card），并恢复内存 job。备份不把 Blend/GLB/大 PNG 读进 RAM。`resolved_job.json` 使用同目录临时文件 + `os.replace`。这只覆盖该路径的同步异常回滚；RF-03 新候选路径另走不可变 ready 代与原子 current 提交，尚未注册为生产路径，也未取得断电耐久性验收。

网页新建打样单一律写 `structure_engine=v2`，不再提供运行时旧引擎开关。杭州 Windows 的 Illustrator/Blender 验证是合并部署门：失败时保持上一生产版本；任务本身若缺少可验证结构，则停在 `review_required` / `unsupported`，不会用旧引擎伪造成功。

## 输入边界

- PDF 兼容 AI 直接走高速通道，不启动 Illustrator。平面 PNG 用 pymupdf 按 MediaBox 整页出图（细 CropBox 不按可见条带放大）。杭州 Windows 与对照共用 `apps/web/backend/.venv` 里的 pymupdf，不要装 macOS Quick Look。pymupdf 失败时，本机若有 `/usr/bin/qlmanage` 才兜底。
- 原生 AI 或非 PDF 兼容 AI 自动通过 Illustrator 导出完整稿和印刷层 PDF，再进入相同建模流程。Windows 上管理员必须保持登录，`beian-illustrator-agent` 的 Session 和心跳必须正常；Agent 接单后按需启动并验证同会话可见窗口与文档列表。生产任务与可信 `main` 发版内的 L1 请求共用同一个执行锁及持久故障围栏，执行中断或清理未确认后不能由另一请求接手；只能按 `scripts/windows/README.md` 的交互管理员流程确认并清除。心跳 busy 时新单排队，不是 412。用户注销、Agent 离线或 faulted 时开始接口返回 412，不消耗待开工回执，也不退回 Session 0。
- Illustrator 冷启动和复杂转曲稿解析可能较慢，建议保持应用常驻。无人值守控制面：无进度 60 秒（存 PDF 300 秒）才放弃；作业墙钟 900 秒只表示 cancel_pending，外层 1260 秒。禁止在 saving 期间 Kill cscript。盘点前 hide 顶层、进轮廓视图（`executeMenuCommand("preview")` 只按一次）、zoom 0.0625；`eachInventoryPathItem` 走 `layer.pageItems` 并展开组和复合路径，跳过 表/标注/Dimensions/尺寸，每层 remainder 上限 512；空的隐藏集合不要把 fallback 从 `document.pathItems` 闩走。存 PDF 前 `restoreUnattendedArtwork` 必须把原可见顶层恢复，否则抛 `Cannot fully restore artwork layers`。关稿再 hide+outline+zoom 0.03125。26H21A 仍是 land 后杭州人工金标。
- 相同结构只需新增任务记录即可并行处理；缓存键包含源稿、结构 sidecar、清理后的 artwork、流程版本，以及 contract 给出的 render plan fingerprint token（其中含合同 hash、profile hash 和 registry 原始字节身份）。
- `structure_v2` 用 Shapely/GEOS 做单位归一、同源近点归一、noding、polygonize 和拓扑诊断。结构可闭合但产品正面仍有业务歧义时返回 `review_required`。网页路径上，唯一可确认正面且带 `preferred_quarter_turns` 时由服务端自动确认并继续出图；多面时已登录账号只提供一个正面锚点。系统只公开最终确认引擎接受的方向，自动带入其几何推荐，再从完整盒型推导其余五面。管理员可对已出图且只有一套公开盒型的单再提交正面，只重跑 Blender。尺寸不匹配与贴图方向不唯一使用不同错误码，不能用方向文案掩盖尺寸失败。曲线适配或结构工作量超过安全上限时返回可执行的 `unsupported`，不会进入 Blender。确认接口用 409 表示候选已过期、422 表示当前结构不能成盒；它们不是网络错误。
- 只有 `validation.status=accepted`、源稿 SHA-256 匹配、六面角色唯一且拓扑闭合的结构才能形成 `ResolvedPackagingJob`。人工确认结果写成新的批准 sidecar，再进入现有建模、渲染、PPT 和 GLB 合同。GLB 导出后还要逐面核对已确认 artwork 绑定；底面缺图、方向错误或镜像错误都判失败。
- Blender MCP 只保留给交互调试。稳定生产通过独立 Blender 后台进程并行执行，避免界面串行和上下文开销。

## Illustrator 兜底验证

强制让一份正常 AI 走 Illustrator 通道，用于安装或升级后的真实稿 L2。可信 `main` release transaction 内的 Windows L1 只通过同一 Session 1 命名管道验证 Illustrator 能返回版本、存在可见窗口、没有其他文档打开，并执行固定 smoke JSX；它不读取真实稿，也不冒充 `structure.json` / artwork PDF 的 L2 证据。runner 自身保持 Session 0，不直接启动或 COM Illustrator：

    python3 pipeline.py examples/jobs_illustrator_smoke.json \
      --workers 1 --force-illustrator --no-ppt

生产任务不应使用 --force-illustrator；流水线会根据文件头自动分流。

## 输出

每个产品目录包含：

- .blend：可编辑 Blender 文件；
- .glb：可旋转查看的通用 3D 文件；六个已确认面都通过贴图来源、方向、镜像和尺寸复核后才交付；
- 正面/右侧面和背面/左侧面静帧（RGBA 产品层；棚走 EEVEE 阴影 + 接触阴影，只提亮产品和落影，不改盒子材质。磁盘文件要重新打样或加 `--force` 才会变；网页再套白底，下载图按当前灯光合成）；网页打样单下载白底只认这两张，不要把印刷面当白底；
- 可选地面 pass：`front_right_ground.png` / `back_left_ground.png`（非发光灰平面阴影垫，albedo 约 0.91，不是木桌）。网页映射 `white_a_ground` / `white_b_ground`，canvas 铺 `rgb(228,228,232)` 再 multiply 地面、叠产品；`*_ground` 不能当产品静帧。地面 pass 失败时仍交付产品图；
- 可选白墙白台 set pass：`front_right_set.png` / `back_left_set.png`（产品 holdout，白台+白墙）。网页映射 `white_a_set` / `white_b_set`。`white_set` 有 set 时画 set+产品，不再 CSS 墙、不再乘旧 ground；缺则回退 CSS。`*_set` 不能当产品静帧。set pass 失败不挡 `done`；
- 可选核对卡：`*_card.png`（Blender 后最长边 1440，网页第一屏；坏了回退全图。不能当产品静帧，也不能当 `*_ground`）；
- `assets/panel_{front,back,right,left,top,bottom}.png`：各面印刷图。网页打样单读字区用这些图，不是 GLB 截屏，也不是 3/4 白底静帧。已出图缺面时 `repair_print_faces.py` 走 V2 `render_face_assets` 写到 `.print-faces-tmp` 再原子替换，不跑 `pipeline.py` / Blender；
- 打样单 PDF（两张白底一页，页底先铺白，槽按源图比例 contain。pymupdf 写不出且还没落盘再用已装的 Pillow，不另装包、不盖掉已写成的文件；跳过时没有，也不当失败）；
- 独立 .pptx（一页两张白底：正面+侧面、反面+侧面；先写 OOXML，不依赖 Node。跳过 PPT 时没有这一项，也不当失败）；
- qa/：仅演示文稿运行时兜底才会有 PPT 质检图；OOXML 直写没有 qa/；
- pipeline_result.json：本产品产物和尺寸验证结果。

批次根目录的 pipeline_report.json 记录总耗时、缓存命中和 10 分钟 SLA 是否达成。
