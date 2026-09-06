# RF-E02：隔离灯光实验与清晰度证据

## 第 04 批交付边界（2026-09-06）

本批交付离线实验驱动、Blender 薄包装、封闭实验声明及合同测试；默认只输出 dry-run 计划，只有显式 `--render` 才调用 Blender，输出必须在新建的隔离临时目录。产品 renderer、作业入口、默认灯光与批准基线均不由本批修改。实验候选 `normalized-rig-v1` 与历史 F 决策记录不是产品 registry 的配置入口；后续显式可选 F profile 已由第 02 批接入，当前产品合同见 `packaging-quality-f-contract.md`。

本批还修复观察拼图重复应用 Alpha 的问题，改为 source-over 合成并测试透明边界；工作树隔离测试使用独立 Git inventory 夹具，兼容 CI 单 checkout，不降低拒绝其他工作树的保护。PDF ROI 按正面在合成展开页的位置取样，仍仅是诊断采样，不是产品输入分辨率或 full/card 物理配准的证明。

本批独立审计后补齐两处回执合同：每单渲染前后重新核对源输入、结构 sidecar、模板、PDF 和六面贴图身份，缺失或变化即终止本轮；全部六张必需输出记录文件 SHA、RGBA 解码像素 SHA 和实际尺寸，并与逐 pass 文件 SHA 对照，坏图不会进入观察拼图或被记为成功。回归由真实小文件与 mock 渲染编排验证，未因此调用 Blender。

下文为此前实验的历史记录：旧测试数量、渲染耗时、本机临时证据、当时授权及“未提交/未发布”等描述仅对应各自实验时点，不代表本批新执行或当前发布状态。本批 ship 验证以对应 PR 的当前源码、测试和 CI 结果为准；不重新渲染矩阵，也不以历史样片冒充 Windows L2、真实稿或画质验收。第 01 批 PNG 解码优化、第 02 批 F profile、第 03 批产品预览修复已独立交付，不重复纳入本批代码。

## 历史实验记录

日期：2026-09-05。状态：E02-A 修复及 E02-B 合成矩阵重跑完成；已生成候选样片，尚非画质验收。E02-C 已完成浏览器取证、实验 PDF ROI 修复及用户追加授权的预览尺寸/全图升级修复与本机复验；物理 ROI 全链路配准、真实稿验收仍未完成。详见 `packaging-quality-rfe02-browser-findings.md`。

> 执行更新（2026-09-05）：wide smoke 已成功。首轮 matrix 在白盒 control 的 180 秒上限停止；保留失败产物。独立诊断确认 GLB PNG 解码是主要耗时点。用户明确授权修改 `workers/packaging/glb_verify.py` 和对应测试并重跑，本次将它们追加到窄切片白名单；实验回执同时加入 decoder 源码哈希。只优化等价解码，不改变像素、Alpha、校验门槛、渲染参数或超时上限。本更新优先于下文对产品文件的一般禁止；不授权其他产品路径或发布。

## 授权与基点

用户在 RF-E01.4 收口后同意下一步开展灯光 A/B 与字体链路取证，并要求开始。
最初由 Grok 编码、Codex 核验；用户随后明确要求“你自己维修吧，不用grok”，本轮修复和重跑由 Codex 执行。

## 本轮实际结果（2026-09-05）

- PNG 解码仅增加等价快速路径：None 直接复用行；Up 的全零差分直接复用上一行；透明像素计数改用等价字节计数。CRC、格式限制、像素与 Alpha 身份校验保留。
- 同一已导出白盒 GLB 在 Blender 内完整校验：修复前 82.369 秒，修复后 6.731 秒，两次均 `ok=True`。重复 Up 行回归测试先在旧实现复现失败，再在新实现通过；五种 PNG filter 均与预期像素及 Pillow 对照。
- 聚焦测试 206 passed；Python 全量 739 passed、5 skipped（另有 5 条 SWIG 弃用警告）。未据此宣称 Windows L1 或真实稿 L2 通过。
- 新矩阵 UTC 04:08:28–04:21:50，约 13 分 22 秒：10/10 作业完成、60 个必需 pass 文件哈希核验一致、5/5 配对检查通过；全部成片 3000×3600，每项仍遵守原 180 秒上限。
- 实验身份已绑定当前 `glb_verify.py` 源码哈希。tall 为预期灯光不变负对照；其余配对仅声明范围内灯光变化。
- 旧失败批次与新 control 的 wide/white 产品及 ground 解码像素完全一致；set 中个别图片有 1–2 像素、最大通道差 1 的差异，原因未确认，不宣称整批文件逐字节不变。
- 人工查看拼图：宽盒和文字夹具的明暗层次变化更明显，白盒及深色盒改善有限；这不是整体真实感或字体清晰度达标结论。full/card 的物理文字 ROI 未注册，浏览器未测，不从诊断 PDF 栅格分辨率推断产品输入分辨率。
- 成功证据目录：`/private/var/folders/tz/wswl3q3117v437rw68yd90gh0000gn/T/beian-rfe02-zglmxnr4`，含 `report.json`、`contact-sheet-white-observation.png` 和 `type-frequency-chain.json`。
- 首轮失败证据保留：`/private/var/folders/tz/wswl3q3117v437rw68yd90gh0000gn/T/beian-rfe02-fecfy27v`。以上为本机临时路径，不是仓内正式基线。
- 未修改产品默认灯光；未 commit、push、PR、merge、deploy。下一检查点是 E02-C 的视觉判断与浏览器/字体采样链路，不能直接推广候选灯光。

- 历史工作树：独立 `beian-3d-rfe02-lighting-evidence` checkout。
- 分支：`codex/3d-rfe02-lighting-evidence`。
- 基点：本地 `origin/main`，`24b9fdfafb0f6a565041138f0607a09b18e25b6a`；本轮 `git ls-remote origin refs/heads/main` 因网络超时失败，不宣称已同步最新远端。后续提交/合流前重新核对；本地隔离实验不据此发布。
- RF-E01.4 三个未跟踪文件保留在原工作树，不复制、不提交、不移动。
- 本文只替代本切片的历史实施顺序，不取消 AGENTS 的安全、结构、六面 UV、GLB 与发布边界。
- 不 commit、push、PR、merge、deploy，不写正式基线，不处理真实稿，不启动产品或 Illustrator，不删除旧工作树或数据。

## 为什么先做这一轮

源码 `blender/render_job.py:add_studio` 中，三灯位置、面积和指向固定；`camera_frame.py` 的相机随盒子尺寸适配。
这是受控实验假设，不是已证明的根因。纸材、外置印刷面、色彩变换、缩图与浏览器采样仍可能分别影响结果。

目标是产出能判断下一步的图片，不继续扩建通用比较框架：

1. 四种形态/颜色下比较现有棚光与尺寸归一化棚光。
2. 用同一合成文字稿追踪 PDF、面贴图、full、card 的分辨率与细节。
3. 真实浏览器阶段另设检查点；离线 Pillow 拼图不能证明浏览器或产品 UI 已验收。

## 实施顺序与本次停止点

- E02-A（本次 Grok）：实现实验驱动、Blender 薄包装、证据整理与失败测试。只跑不调用 Blender 的测试，结束交 Codex 核验。
- E02-B：核验 A 的修改范围、基准无干预、参数回执和写入边界后，先一对样片，再跑有界矩阵。不能用旧 RF-00 图片顶替本轮 A。
- E02-C：Codex 查看实际图片和逐段证据；必要时开展现有 compositor 的浏览器实验，明确浏览器、视口、DPR、加载源与 canvas backing 尺寸。该部分不在 A 的代码白名单内。

这不是要求每个正常实现选择再问用户；A 结束仅停止自动扩范围和未经核验的大量渲染。产品画质默认变更仍不在本包。

## 白名单

仅新增或修改以下文件；本方案由 Codex 维护，Grok 只读：

1. `workers/packaging/tools/render_quality_experiment.py`：纯参数函数、受控驱动、证据检查、接触表/局部图导出。
2. `workers/packaging/tools/render_quality_experiment_blender.py`：仅实验进程加载的薄包装，复用原 renderer。
3. `apps/web/backend/tests/test_packaging_render_quality_experiment.py`：不依赖 Blender 的合同测试。
4. `workers/packaging/fixtures/render-quality/experiments/rfe02-lighting.json`：版本化实验声明。

不修改 RF-00 evaluator/manifest/baselines、RF-E01 comparator、产品 renderer/pipeline/render_contract/camera_frame/registry、UI/server、VERSION、依赖锁文件和 AGENTS。白名单无法完成时报告具体接口阻碍，不自行放开产品代码。

## 复用与接口

```text
固定合成 manifest 的已知夹具
  → RF-00 materialize_fixture
  → 产品 preflight_product（V2 验证和贴图）
  → 产品 run_blender_job（私有快照 / nonce / 结果验证 / card）
  → 实验薄包装加载原 render_job.main
      A：只采集回执，不改变场景
      B：原 add_studio 后只调整三盏既有 AREA 灯
      原 render_still 前后：采集实际场景并绑定完成文件
  → 独立 rfe02 报告、配对检查、同尺度对照图
```

- 不复制 main、add_box、render_views、GLB 导出/验证或 preflight 流程。
- 实验驱动可在自己进程内临时选择 `pipeline.BLENDER_SCRIPT` 为固定同仓包装脚本，必须 finally 恢复；串行执行，不对用户任意脚本提供入口。
- 实验声明通过专用环境项传给 Blender 子进程；只在实验驱动运行期间设置并 finally 恢复。不更改用户 shell/Codex/全局代理配置。
- 包装仍只接收原来的单个快照 job 参数；不往产品 render_spec 塞实验字段、不伪造产品规范允许了候选灯光。
- 独立回执显式注明 `experimental_scene_override`，产品默认合同仍是 A 的语义。B 不能被命名为产品正式 profile。
- import 驱动或包装不得创建目录、调用 Blender、改环境或写结果。包装对 bpy 的使用应允许普通 Python 对纯数据逻辑做单测。

## 唯一候选：normalized-rig-v1

只接受 `control`、`normalized-rig-v1` 两个枚举，不增加自由参数注入。

原三灯：key `(-135,-190,275)`，fill `(155,-120,175)`，rim `(-90,210,280)`；目标 `(0,0,90)`。
候选用 `s=max(width,depth,height)/180`，目标 `T=(0,0,height/2)`：

- 位置 `P'=T+s*(P-(0,0,90))`。
- 原灯 size 与存在且适用的 size_y 乘 `s`。
- 原实际 energy 乘 `s*s`；保留已有 light_energy_scale 的作用，不重新猜默认值。
- 使用原 `look_at` 指向 T；颜色、AREA 类型、shape、光比不变。
- 三灯数量、名称和类型不满足已知合同就拒绝，不静默加灯或跳灯。
- 宽深高须为有限正数，bool、NaN、Infinity、缺值拒绝；输入仍须通过已有夹具/结构预算，不支持任意用户几何。

能量平方缩放是本候选的受控组成，意图减少尺度变化带来的照度变化；不是保证观感相同的物理验收结论。
180 mm 高且最长边为 180 mm 的 tall 夹具应数学上不变，作为候选变换的负对照。
白/深盒的尺寸相同，使用完全相同候选参数，不按颜色/SKU 调灯。

不改几何/倒角/印刷面偏移、纹理、相机、采样、曝光、world、色彩变换、地面或 set 材质。不以本轮证明这些方面正确。

## 夹具与运行预算

复用 RF-00 manifest 中 white、dark、tall、wide、type-frequency 五个已支持夹具；alpha-edge 可留后续，不改变 RF-00 manifest。
第一对为 wide，验证参数确实变化；完整矩阵为五夹具 × A/B，共十个作业，每个复用现有两视角和各 pass。
使用固定枚举选择 smoke 或 matrix，不接受外部产品 manifest，不读取客户数据根。

运行需显式 `--render`；无该标志只输出计划 JSON 到 stdout，零写入、零 Blender 调用。
串行；矩阵遇首个失败停止，保留失败证据，不自动重试或降低质量。不得降低产品当前分辨率来假称完整质量对照。
在原 pipeline subprocess 边界通过实验局部适配设定单作业 180 秒、总轮次 1800 秒的上限，finally 恢复；超时只终止本次专属 Blender 子进程，不 killall，不影响用户其他 Blender/Illustrator。若无法可靠限定子进程生命周期，报告阻碍，不改产品 pipeline。

## 输出与身份

不提供任意可写 output_dir。`--render` 时只在系统临时目录以 `tempfile.mkdtemp(prefix='beian-rfe02-')` 创建新私有根，拒绝位于任何仓库工作树或产品数据根内的临时根。
不复用或清理已有目录；所有输入为本次生成的合成文件，A/B 子目录分离。所有输出限定在该新根中，固定文件名，不接受 manifest 中的路径重定向。
拒绝工作树、WB_DATA_DIR 及常规产品数据根；resolve/samefile/casefold；不扫描或读取那些根里的业务内容。
不声称解决了同用户恶意进程对任意目录的所有竞态；不重新实现通用安全文件系统。

声明须在第一个 Blender 作业之前落盘并取 SHA；记录运行开始/结束、实验源码与包装/产品依赖源码哈希、版本、输入文件 SHA、产品规范身份、各输出文件 SHA/像素 SHA/尺寸。
检查源码与输入前后不变；A/B 对应夹具的语义声明、PDF 和纹理内容相同，路径/nonce 可不同；其余非灯光生效设置逐项相等。
RF-E01 尚不接受这个新回执 schema：不要伪造 RF-00 报告送进去、不要放宽 RF-E01。独立 RF-E02 检查只对本候选负责。

## 真实参数回执

薄包装可替换加载模块的 `add_studio` 和 `render_still`，不修改源文件；结束恢复引用。
调用原 `render_still` 前从传入 scene 读取，完成后记录该 pass 实际文件 SHA。不能在 factory startup 或 GLB 验证清场之后才采样。

每个 pass 至少记录：

- execution_nonce、实验声明 SHA、快照字节 SHA、源文件身份、variant、输出 key。
- 三灯位置/旋转/类型/shape/size/size_y（适用时）/energy/color，world 实际节点背景参数。
- camera 世界矩阵、类型、ortho_scale；对象 yaw、主要模型变换/几何摘要、材质参数及纹理内容身份。
- scene render engine，实际可读的该引擎采样设置及其属性名；缺失写 unavailable + reason，不回填声明值。
- 实际 resolution_x/y/percentage、film_transparent、PNG 色深/模式、view_transform/look/exposure/gamma。
- pass 完成与否、输出 SHA；必需产品/地面/set pass 缺失不能标整轮 complete。原 renderer 吞掉地面异常时，实验层仍要识别不完整。

原 main 完成、nonce 和输出闭合后才标该作业 complete。单纯有 receipt JSON 不等于渲染成功。
完整参数证据不足应写 `evidence_insufficient`；不得自动判定 B 更好。质量改善、人验、Windows、L2 均默认 not_assessed。

## 首包可视证据

在新临时根写固定 PNG 接触表：每夹具一行，A/B 两列，等尺寸 contain、不拉伸，标 variant 和源尺寸。
白底合成仅做相同白底的离线观察，不冒充产品 compositor；另存透明产品原图与地面/set 原图，避免合成掩盖证据。
禁止锐化、AI 重绘、自动曝光、单图归一化和按候选改裁切；原图不改写。

字体：复用 type-frequency 的 text/barcode ROI。PDF 和面贴图记录毫米到像素关系，full/card 记录相同图像位置的裁切与尺寸。
无法可靠将 PDF ROI 投影到 3/4 视图时必须标未配准，先交整张同尺度 full/card 对照，不能假称同一个物理 ROI 的全链路指标。
不把 FIND_EDGES 方差或锐度值称为可读性/条码可扫描验收；不得用平均分掩盖某夹具退化。
不生成 HTML/新服务/浏览器模拟结论；实际浏览器验证留在 E02-C。

## 本次必须测试

1. 纯参数变换：tall 恒等，wide 有差异，同尺寸白/深盒相同，s² 能量和位置/面积公式。
2. 无效 variant/尺寸/缺灯/错类型失败；不出现颜色路由。
3. control 原函数只被调用一次，无灯光修改；B 只允许修改灯光白名单，其他设置不变。
4. 原渲染完成前不能记完成，失败/缺 pass/缺实际属性/旧 nonce/输出 hash 不符不通过。
5. 干运行和 import 无副作用；missing Blender 明确失败，不产生成功样片或偷偷安装依赖。
6. 临时目录隔离、固定输出、拒绝数据根/工作树/symlink/大小写别名；不写旧 RF00/批准基线。
7. pipeline 脚本选择、环境和局部 subprocess 适配在成功/异常时恢复；超时不影响非本次进程。
8. 源码/input 前后变动、非灯光参数差异拒绝；未知浏览器/字体映射保持未测量。
9. 对照图两列缩放/底色相同，不放大低清图冒充原图；失败不生成“改善通过”标签。

先运行新增 pytest，再运行 RF00/render_contract 相关测试；不得把 mock 测试写成 Blender 成功。
Python 复用本机已安装的 backend `.venv/bin/python`，cwd 必须本工作树 backend，不建立跨树源码或 UI dist symlink。不装新依赖。

## Grok 完成回执

输出 STATUS、分支、实际修改文件、测试命令/退出码/计数、未验证项、具体下一步。显式写“未运行 Blender；未产出真实候选样片；未改产品默认；未提交/发布”。
发现必须超白名单、复制渲染流水线或修改规范才可实现的阻碍时，止于具体证据，不自动放宽合同。
