# RF-03 runtime 收口增量

2026-09-14 Q06.6 A 补记（`0.28.0.0` 内容）：显式临时 runtime 已接通固定 `packshot-carton-geometry-v1` 候选，先验证 RF-02 源再解析绑定结构；具体装配与身份见 [worker README](../../workers/packaging/README.md)。A 候选开发不依赖 Q06.7；B 生产装配须 Q06.4 与既定八点审计，C 启用须 Q06.7/.8 及明确授权。普通产品默认无注册、临时根及平台门保持有效，`productionEnabled=false` 本身不是保护开关；history/activate 对合法已有代仍可用。既有平台门允许 darwin/linux、拒绝 win32，本次实跑仅 Mac。

本地发布准备证据批次 `Q066-ship-20260914-Q7sMHL`：`beian-verify-9Zwo21/receipt.json` 的 test:quality 59、quality（59 项原基线不变）、typecheck/UI build、完整 L0 均 exit 0；server 751 pass / 1 skip，UI 378 pass，Python 1276 pass / 9 skip / 10 deselect。`mockup-render-versions` E2E 9/9 为独立临时构建、网络拦截的合成页面，无 Hono，不是性能采样。Claude 与 Codex 独立审查未留已证实 P0/P1/P2；静态路径评估 21/26（81%），非仪器覆盖率，仍披露五个测试补强点：候选开启后的能力拒绝矩阵、解析后目标身份漂移、非法 profile 输入形状、裸 SHA 归一化、中文错误映射断言。它们未补测，不另增待办主题。

原生证据批次 `Q066-native-prep-20260913-Um0ExX/native-1` 绑定 `0b9cd4bf63e5d2b8226e85c0cfbb4a47a62f17b4`：单次 Mac 合成 TS jobs/runtime→Python→Blender→seal/current 正常链 PASS，77.867 秒；14 项候选、13 项公开封存产物（blend 留在候选），最大尺寸误差 `2.3748725652694702e-6 mm ≤ 0.5 mm`。`production_ready=false`、`human_acceptance=pending`；之后仅两处导出、注释及版本元数据变化，不能称最终发布树重新跑过原生。registry、默认模板与正式 baseline 未改；Windows/原生异常/断电、真实稿 L2/UAT、人审及 Q06.6/.7/.8 整体仍未完成。后续 PR #113 已合入，`51a6d0a` / `0.28.0.0` 的可信发布与公网版本于 `2026-09-13T17:05:01Z` 核验通过，A 代码完成发版 L1；完整发布证据见 [TODOS.md](../../TODOS.md)。本次杭州合同冒烟成功不开放 B/C，也不替代上述原生异常与业务验收。以下 2026-09-06 轮次、数字及“upgrade 拒绝”等结论保留当时语境，不作为 Q06.6 A 新证据。

日期：2026-09-06。原开发分支：`codex/rf03-runtime-closeout`；本次收尾分支：`codex/rf03-runtime-ship`，起点 `e1c2d679` / 0.21.35.0。

**本次独立候选状态：RF-03 runtime/资源生命周期与产物验证已完成 Code/L0。** 代码提交为 `caef7a4`，版本提交为 `12b9f9f`（`0.21.36.0`）；不包含 RF-04 方案/API/UI 或 RF-05 几何。生产注册和主 Node 桥的 Windows 新建仍关闭，Windows 原生/L1/L2/UAT、断电耐久性与正式视觉 baseline 均未验收。

独立候选验证：服务端 **706 passed / 1 skipped**，UI **339 passed**，Python **976 passed / 7 skipped / 4 deselected（399.30 秒）**；服务端类型检查、UI 构建、质量合同 **47 passed** 与复杂度检查通过，**59 项原基线不变**。四个 `test_real_*` 均按完整 node ID 显式排除；本次没有执行真实稿、Blender、Illustrator 或 Windows 原生验证。这组数字独立于下文历史轮次，不累计，也不借用历史 Blender 成功作为本候选重跑证据。

**原开发树第五轮状态（历史快照）：本地工程可评审交付完成。** 当时 runtime/资源生命周期、Windows 原生托管代码与恢复门已实施，真实 Blender 合成全链及回归通过，RF-04 可实施 PLAN ONLY 已交付；当时未提交、推送、PR、部署或启用生产新桥。该工作树扩大回归曾误包含 4 个本地真稿 PDF 解析测试，已停止并单列偏差，不能声称该开发过程全程仅使用合成数据。原工作区的未提交修改保留，不混入本候选。

以下五个轮次及测试数字均保留为原工作树开发过程记录；第五轮代表该历史开发树的收口状态，不能替代上面的独立候选验证或证明 RF-04 已进入本分支。

此前八批已交付的存储、原子 current、候选隔离、幂等/队列与 POSIX 退出屏障继续复用，详见 [C2 台账](packaging-quality-rf03c2-acceptance.md)。本文件不重新证明旧发布链，也不把本地防护当作 Windows/L2/画质验收。

## 第一轮：输入资源防护（历史过程）

| 边界 | 实现 | 失败语义 |
|---|---|---|
| Python 源计划 | stat 预检 + 最多 8 MiB+1 的实际读取，打开后验证普通文件/inode | 超限 `source_plan_budget`，不进入 JSON/候选准备 |
| 文件身份 | 单文件 512 MiB，上限先验并在每个 1 MiB 块复核；读取前后大小/mtime 一致 | 超限或读取中变化拒绝，不能获得原 SHA 的身份 |
| 六面贴图准入 | 创建私有候选前读 33 字节 PNG 头，校验 IHDR/CRC 与单图 32 MP | `asset_pixel_budget`，不创建候选、不启动 Blender，不改旧图 |
| 私有贴图复制 | 复制前文件大小与复制中累计字节上限 | 增长文件不能无限写入候选目录；失败候选不封存/不切 current |
| PNG 基本验证 | 32 MP 先验；按声明 scanline 字节+1 有界 inflate；拒绝溢出、截断和附加压缩流 | 不能先无界解压再按尺寸拒绝；仍不是视觉质量通过 |
| GLB 容器读取 | 默认 512 MiB 预检与有界实际读取 | 超限在容器解析前拒绝；不是六面几何/UV 完整验证 |
| Node 桥接预算 | 一份单调时钟 deadline 跨 verifyBytes/verify、候选 render、源/输出哈希；每次子进程只获剩余时间 | 超时凭证在第二次 spawn 前拒绝且消费；不能每次重新领取 1260 秒 |
| 取消 | 源读取前、流式哈希块及验证/出图边界检查 AbortSignal | 已取消请求不为探测输入而继续读文件；在途子进程仍走现有实际退出屏障 |

边界说明：32 MP 是每张图的像素上限，不是全进程内存上限。Node 的哈希检查是协作式 I/O 检查点，不能打断卡在内核的文件操作；bridge deadline 也尚未覆盖 jobs 的同步 sealing/copy/fsync。Python 中 Blender 的内层日志捕获、综合磁盘预留、全程 deadline 与 Windows 进程树仍待后续。不能把本轮写成“完整资源准入已完成”。

PNG inflate 使用 `Decompress.decompress(max_length)`，不把 `flush(length)` 当最大输出限制；语义核对见 [Python 官方 zlib 文档](https://docs.python.org/3/library/zlib.html#zlib.Decompress.decompress)。

### 第一轮测试证据

- 资源防护首轮红测：原实现存在 6 项失败（有界 inflate、附加压缩数据两例、源合同字节上限、文件 hash 上限、源像素准入）；旧行为被实际复现，不以改 snapshot 消除失败。
- Node deadline/提前取消：新增 2 项先红后绿；过期凭证未启动第二个进程，候选目录不存在，同凭证重试仍拒绝。
- GLB 有界读取：新增 1 项先红后绿。
- 服务端完整测试：**652 passed / 1 skipped**（Windows 新桥平台测试在 Mac 跳过）。
- Python 相关完整集合：**271 passed**，范围为 `test_packaging_glb_verify.py`、`test_packaging_render_generation.py`、`test_packaging_pipeline_v2.py`、`test_packaging_render_contract.py`。
- 服务端 TypeScript 类型检查通过；`npm run quality` 通过，保持 59 项既有基线，未修改质量阈值。以上 Python Node→Python 联调用例只替换 Blender subprocess，不证明真实 Blender 渲染成功。
- 未执行 Windows 新桥实机、真实 Blender、真实 `.ai` L2/UAT、断电持久性测试；本轮无 UI 代码变更，RF-04 仅方案草稿。

## 前四轮结束时的剩余清单（历史快照；当前状态见第五轮）

1. **真实 runtime quality proof**：候选 CLI 已接入 GLB、full/card 与源 PNG 网格密度子门，并提供绑定 seal 拷贝后 files/faces fingerprint 的进程内一次性子门凭证；仍需完整资源生命周期及真实 full/card 渲染证据，才能讨论完整 runtime gate 的状态与接线。源 PDF 内嵌位图清晰度、历史重采样次数与投影反推采样没有被证明，不能用本轮 PNG 网格报告代替 RF-08。runtimeQuality 仍为 unwired，不允许新桥候选激活。g0 的历史存档完整性与新代质量通过分开，不能重写旧图或伪造旧代通过。
2. **完整资源生命周期**：源/输出综合字节检查、源 PNG 总像素、Blender 内层有界日志、启动前磁盘水位、Node→Python 剩余时间预算已加入；仍需真正的磁盘预留/运行期写入控制、全进程内存准入、seal 同步 copy/fsync 与最终提交的统一 deadline。到时只取消本次 owned 进程；未确认退出继续保留共享槽。不得以超时 Promise 已返回释放槽。
3. **Windows owned process tree**：设计并实现可证明拥有的进程树容器及重启恢复，避免启动/归属 race、PID 重用和父进程先退的假完成；Mac 替身测试与 Windows 原生验证分别记录。无托管实现仍在 spawn 前拒绝，不新增 taskkill fallback。
4. **生产适配器注册**：不再用测试 hook 作为生产能力。只有相应 runtime/资源/平台门具备证据时才按已有授权实施注册；未授权本轮不启用。历史读取和合法激活能力不应被 Blender 是否在线一刀切。
5. **真实验收与视觉链**：正式 baseline、RF-05+ 几何/材质/棚光/清晰度、Windows L1、私有 L2、人工 UAT 分别完成。默认 F、旧 profile 和业务开放状态保持不变。

后续实施顺序建议：runtime proof → 完整资源生命周期 → Windows 托管/证据 → 有门禁的生产适配器。RF-04 可同步做只读/禁用 UI 的方案与合同，见 RF-04 方案（待后续 RF-04 分支交付），不能为按钮可点提前放宽质量或平台门。

## 第二轮：候选 GLB 实际字节子门

`glb_verify.compare_glb_artifact_contract` 直接从 GLB 的 active scene、节点层级、矩阵/TRS、bufferView/accessor、实际三角形和纹理字节取证，复用既有毫米尺寸、UV、闭合 Core 与六面像素/Alpha 检查。坐标和矩阵解释参照 [Khronos glTF 2.0 规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#transformations)：column-major、T×R×S；glTF 的 Y-up 转回既有校验器的 Z-up，纹理 V 转回 Blender UV。不是读取 accessor 自报 min/max 或 Blender 结果中的尺寸来判断。

当前只支持既有静态平面六面纸盒的导出子集：七个 mesh、每面两个实际覆盖整面的三角形、每面唯一材质和一个闭合纸芯；节点最多 64、单 accessor 最多 8192 项、bufferView 最多 256。循环/共享节点、越界/非有限 accessor、未支持的 sparse/动画/skin/必需扩展、未知可见 mesh 均拒绝。不宣称通用 glTF 解码器，也不把这个限制推广为 RF-05 未来几何合同。

候选执行完成后，CLI 先检查实际 GLB，再复核 GLB 文件 SHA 与六面私有贴图 SHA；任一不符返回 `runtime_glb_quality`，旧源目录和当前成片不动。Node 仍复核全部输出字节，真实 adapter 仍返回 unwired；**本子门没有开启 seal/current 的质量通过分支**。

新增对抗覆盖空/缺面/重复面、错误材质、同名伪材质、tint 系数、贴图变换、被贴图覆盖的纸芯、镜像 UV、面离开纸芯、纸芯开口、坏索引/NaN/超大 accessor、短 buffer、外部 buffer、循环节点，以及通过校验后 GLB/私有贴图被替换。原候选入口对“空但可解析的 GLB + 本轮成功 nonce”实际出现红测，修复后拒绝，不能把容器合法当作模型合法。

本机 Blender **5.2.0 LTS / Darwin / fbe6228777e7** 用现有 `add_box` / `export_model` 和纯合成 2×2 六面贴图真实导出，再由 Python 读实际 GLB 验证。**只做模型导出，没有渲染 full/card，也没有客户稿或杭州测试。** 调用通过显式测试环境 `BEIAN_TEST_BLENDER_EXPORT=1` 开启，不要求普通 CI 安装 Blender。

真实导出发现既有印刷材质的 baseColorFactor 是 0.70，而非 1.0。该既有 `PAPER_ALBEDO_LINEAR` 数值原样移到共享校验模块，由渲染器和校验器共用；未改 F、纸白系数或批准新基线。严格按原值检查（浮点容差 1e-4），不是放宽成“任意系数都能过”。

本轮聚焦验证：**24 passed**（含真实合成 Blender 导出）。稳定代码的四个相关完整集合 **294 passed / 1 skipped**（148.04 秒）；跳过项就是需显式开启的真实 Blender 导出，本轮已另跑通过。`npm run quality` 通过，仍为 59 项原有基线；`git diff --check` 通过。第一轮的 271/652 仅对应第一轮，不作为本轮新增实现的全量证据。

过程记录：新增 16 项 artifact 测试先红后绿；空但可解析 GLB 的候选入口出现真实红测；后续同名材质/tint/短 buffer/纸芯贴图四项对抗先红后绿。0.70 共享常量调整期间曾有一个在途测试进程缓存旧模块，导致四项 ImportError；固定代码后重新启动完整测试进程取得上述 294/1 结果，未改断言绕过错误。

## 第三轮：full/card 与封存子门凭证

CLI 按 RF-02 绑定的分辨率验证两张产品全图，不读取 worker 自报尺寸作为真值。两张图必须是有界可解码 RGBA PNG，同时包含 alpha=0 的背景和 alpha=255 的产品像素；这只是透明背景/非空的机械检查，不代表构图覆盖率或视觉质量。核对卡按现有 `write_review_card` 的最长边 1440 与 LANCZOS 算法重算，逐字节比对解码后的 RGBA 像素，支持无需缩小的全图；不依赖压缩文件 SHA 相同。所有被解码字节先与输出 evidence 的 SHA/bytes 绑定，错误返回 `runtime_full_card_quality`。

Python 只在实际 GLB 和 full/card 子门都通过后返回 `artifact_checks`。Node 桥先检查该固定协议，再复核输出和源字节；缺失/失败的子门字段不能铸造凭证。`createPartialSealVerifier` 只接受同一桥实例产生的候选对象，凭证期望值保存在 WeakMap/闭包内，调用者改 outputs 或复制/序列化对象不能修改或重建它。工厂只能取出一次，验证回调不论成功、拒绝、取消或超时均消费一次。

封存回调精确比较 mode、源合同 SHA、全部已映射 outputs 的 key/SHA/bytes、六面 SHA 和规范化 content fingerprint。缺项、额外项、重复项及任一替换都拒绝；与 adapter 共用输出 key 映射，与 store 共用 fingerprint 函数，避免两套算法漂移。未入代际存储的 `.blend` 不在该 fingerprint 内。g0 导入仍走独立历史存档校验，不允许用新候选凭证冒充历史证明。

真实 Node→Python→store 测试使用合成图片和受控 Blender subprocess，保留 RF-02 验证、nonce、实际 PNG/GLB 检查、卡图生成和 store 复制/hash 全链。正常复制后可封存为 `quality_status: unwired`；在候选验证后以合法反面 PNG 替换正面，store 复制后触发凭证拒绝，没有新代 ready。均不提交 current patch、不改旧源图。纯 Node worker 是协议替身，不单独用它证明实际产物质量。

**边界保持关闭**：该回调只给出“子门字节一致 / 完整质量未接线”，没有新增 pass 枚举，也没有在 jobs 或生产 adapter 中注册它。adapter 仍返回 `runtimeQuality: unwired`，现有 jobs 测试继续证明其不能激活。回调继承 bridge deadline，可在复制结束后拒绝过期；尚不能打断同步 copy/fsync，也没有覆盖最终提交阶段，不等于整个 sealing 生命周期已有时间预算。未执行真实 Blender full/card 渲染、Windows 新桥、L2/UAT。

本轮服务端完整测试 **666 passed / 1 skipped**；Python 四个相关完整集合 **315 passed / 1 skipped**（162.48 秒）。Python 跳过项为需显式开启的真实 Blender 导出，上一轮另测通过，本轮未重跑；Node 跳过项为 Mac 不可执行的 Windows 平台用例。类型检查与复杂度门通过，59 项原有基线不变。新增 Python 16 项单图/配对测试、3 项候选成功 nonce 后损坏测试、2 项真实复制后的封存链，以及 Node 14 项凭证/协议/失效测试均通过。

## 第四轮：源采样与候选执行预算

### 源采样

`verify_source_sampling` 读取六张源 PNG 的 IHDR 尺寸，按 RF-02 已验证的毫米尺寸与逐面最低 ppm 计算 `max(8, ceil(mm × target_ppm))`，同时核对 SHA 和 profile 像素上限。不足时在创建候选前返回 `source_sampling_quality`；旧图、旧合同与 g0 存档不改写。候选 GLB 子门随后实际解码同 SHA 的 PNG，不能只用 PNG 头作为完整质量证明。

报告只描述 `source_stage: resolved_face_png`，列出六面实际尺寸、两轴 ppm、目标 ppm、最低像素尺寸与 SHA。`upstream_resample_count` 和 `projected_pixels_per_mm` 明确为 null：不捏造原 PDF 固有分辨率、既往缩放次数或相机 Jacobian。新桥的 `artifact_checks` 必须另外包含 `source_sampling: passed`，缺失/失败不能取得子门封存凭证。

同时修正生成端的最低像素取整：普通切面保留原较高采样尺寸的 round，但不得低于 ceil 后的最低网格；纯纸板面直接用 ceil 最低网格。30.01 mm × 20 px/mm 原来产生 600 像素的两条路径均已有红测并修正到 601。最初尝试全量 ceil 导致正常高采样因 PDF 小数噪声从 2500 变为 2501；已收窄到仅守住最低采样下限，不改变已有 2500×4167 合成输出合同。pipeline 从同一 plan 传递最低 ppm 和最大面像素，不再只传 raster width；未改变 profile、F、灯光或几何。

### 资源与时间

- 六面合计上限：96 MP 网格、256 MiB 源文件字节；仍保留每张 32 MP。96 MP 不是进程 RSS 上限，不声称覆盖 Blender/GPU 内存。
- 创建候选前、启动 Blender 前各检查一次所在磁盘水位：按产品/地面/场景六张 full 与六张 card 的原始字节、两个单文件上限的二进制输出、源副本与封存第二份输出估算，并保留 128 MiB 水位。源/合同不写回，空间不足不自动删除任何历史代。该检查不是物理占位文件或排他预留，其他进程仍可能占用空间。
- 候选配置内的输出单文件仍为 512 MiB，总量不超过 2 GiB，并不得超过启动前估算上限；即使 optional 图不可解码/未被纳入 evidence，其实际文件字节仍计入资源限制。检查在渲染后进行，不声称可阻止 Blender 在检查前写爆磁盘；store 的既有 256 MiB 单文件准入仍独立保留。
- 新增 `blender_process.run_bounded_blender`：只供带 deadline 的新候选路径使用，非阻塞读取合并 stdout/stderr，合计最多保留 8 MiB 原始日志字节。超限/超时保留有界日志并失败，先终止、再强停本次 Popen 直接子进程；不建立新 session/group，不将后代移出 Node 已有归属。直接父进程退出但输出管道未关闭也不当完成；全进程组退出仍由 Node 既有屏障判定。Windows 该实现启动前拒绝；旧生产 `run_blender_job` 未传 deadline 的分支暂不切换。
- Node 每次调用只传剩余 `timeout_ms`（1–1,260,000），Python 以独立 ContextVar 保存本次单调时钟 deadline，覆盖读取/流式哈希/私有复制、Blender 捕获与质量前后边界；退出成功或异常都会复原 ContextVar。强停后的有限退出等待不等于追加渲染预算。CLI 质量解码和同步 OS 操作仍不能任意中断，外层 Node deadline/归属屏障继续有效；seal copy/fsync 与最终提交仍待补齐。

实现依据：[Python subprocess 文档](https://docs.python.org/3/library/subprocess.html#subprocess.Popen) 与 [selectors 文档](https://docs.python.org/3/library/selectors.html)。本轮只用本机受控 Python 子进程测试日志洪泛、非零退出、忽略终止信号与过期不启动，没有真实 Blender 渲染、Windows 原生或客户稿验证。

本轮验证：服务端完整测试 **667 passed / 1 skipped**（13.81 秒）；Python 六模块完整集合 **362 passed / 1 skipped**（192.86 秒），范围为 generation、GLB、pipeline V2、render contract、structure artwork、bounded Blender process。捕获器随后补齐管道初始化异常的直接子进程清理，并独立重跑该模块 **6 passed**（与全套已有用例重叠，不能直接相加为新增用例数）。服务端类型检查通过；最终 `npm run quality` 通过，仍为 59 项原基线；`git diff --check` 通过。跳过项仍分别为 Mac 不运行的 Windows 平台用例、显式开启才执行的真实 Blender 导出。

过程记录：源采样/非整数尺寸 7 项先红后绿，其中低清源的 prepare 原本未拒绝、两条最低取整路径原本均输出 600 而不是 601；磁盘水位/源像素总量 2 项先红后绿。既有低清 legacy 测试原用 8×8 贴图，现在拆成低清拒绝与新绘制足密度合成夹具两条；不以放宽采样门保持旧假阳性。高采样 2500×4167 合同曾出现一次真实回归，已修正取整策略并重新验证；未更改该期望值。

## 第五轮：Goal 本地工程交付

目标限于本地工程可评审交付和 RF-04 可实施 PLAN ONLY，不是生产上线。以下实现接续前四轮，不重复计算其测试为本轮新证据。

### 资源生命周期

`renderGenerationBudget.ts` 提供真实预留文件（默认 4 GiB，可由受信主机收紧），逐 MiB 写入、fsync 并核对实际 allocated blocks，不用 sparse truncate 冒充预留。每个 mutation 独占 `.reserve-<id>`；分配前保存 inode/dev 元数据，正常结束/失败只释放本次 inode。退出归属未确认时关闭本地描述符但保留预留，boot 在进程退出屏障后按元数据恢复；同名替换或坏元数据保留待核验，不清任何 root/g0/ready/candidate。恢复元数据经 O_NOFOLLOW、持有 fd 的 inode 核对、固定 4097 字节读取与前后 size/mtime 验证；超 4096 字节、null、外来 mutation 或链接均拒绝，不用 lstat 后的无界 readFile。

候选执行每 100 ms 统计整个候选目录（含未声明文件），最多 256 项/6 层，拒绝 symlink/hardlink；增长消耗预留 credit，候选最多 2304 MiB，全部本轮候选/封存写入共享预留总量。封存复制改为 1 MiB 检查点、独占创建、复制前后身份/大小/mtime 核验；在写入前消耗 credit。保留 128 MiB 磁盘水位，不能为腾空间删除旧图。

内存默认预算 4 GiB，可收紧、上限 8 GiB。准入使用 Linux MemAvailable 或 macOS 原生 memory pressure 可回收评估（不是把 free pages 当全部可用内存）；另留 512 MiB。执行期统计专属 POSIX group 中所有 worker/Blender 后代 RSS 加 Node RSS，超限停止 owned group，统计失败同样失败关闭。POSIX 仍以受信 Python/Blender 不脱离 group 为边界，不能说成禁止任意 setsid 的沙箱。

**资源限额的准确含义**：这是实际预留 + 受信执行链的采样式增长/RSS 控制，不是对同一磁盘其他用户或任意恶意程序的内核文件系统 quota。100 ms 采样可能有瞬时超调，不能承诺 OS/RSS 从不超过某一字节；单文件/像素/日志/输出后验上限继续叠加。Windows Job Object 另有内核 job commit-memory 限制，但原生证据尚缺，不能从 Mac 推导其已通过。

同一单调 deadline 从准备经两次 CLI、哈希、候选执行，延伸到 g0/new seal 的复制/哈希/fsync、ready 最终复核与 current 提交。`atomicReplaceJobJson` 在写后 fsync 与 rename 前检查同一预算；rename 是提交线性化点，成功后不因晚到时钟错误宣称已回滚。同步内核调用无法由 JS 抢占，故这是检查点合同，不是硬实时承诺。超时可留下 staging/ready orphan，但不得返回 current patch；恢复只补索引不激活。

### 完整 runtime 凭证及正常接线

`runtime_verified` 新枚举只表示本轮产物合同与资源执行验证，不使用含糊的视觉 `pass`。桥接必须先完成实际 GLB、full/card、源 PNG 网格、输出/六面 SHA 与归属退出；只有真实 lifecycle 实例可以铸造一次性 runtime seal verifier。它绑定 mode、源合同、六面、全部输出 key/SHA/bytes、fingerprint，并要求 store 使用同一个仍有效的资源实例。关闭/取消/超时/复制替换/上下文缺失均拒绝；子门 verifier 仍只返回 unwired。

store 在最终 jobs CAS 锁内用 `sealed.prepareCommit()` 重读 ready 文件和清单，并与本轮封存清单精确比较；替换产物或自洽但不同的清单都不能套用已拿到的 patch。g0 继续独立的历史存档 verifier/unwired，不补写旧代视觉通过。

正常 `renderGenerationRuntime.ts` registry 与 `setJobsTestHooks` 分开。默认无适配器；唯一可注册入口仅接受系统临时目录下的显式 local-artifact-review 数据根，`productionEnabled` 固定 false，真实数据根注册拒绝；没有生产环境开关。jobs 通过正常 registry 取得 prepare/历史 verifier，新代使用本轮 executor 的闭包 verifier。upgrade admission 仍明确拒绝。历史读取/合法激活没有被 Blender 在线与否一刀切。

### Windows 代码与证据边界

新增 `windows_job_native.py`、`windows_owned_job.py`、`windows_render_supervisor.py`、`windows_blender_capture.py`。原生实现先配置不可继承的 KILL_ON_JOB_CLOSE + job memory limit，使用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在 CreateProcessW 内原子归属，并以 suspended 启动、验证 membership 后 ResumeThread；只显式继承三条管道，不继承 Job handle。比先 CreateProcess 再 Assign 更重要的是：创建后、加入前的 supervisor 崩溃窗口也被消除。依据 [Microsoft 对原子 Job 创建的说明](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812) 与 [Job Object 限额](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)。

容器名称绑定完整 execution token，使用 Global 命名空间以避免服务/交互 session 切换导致查错空间；现有同名对象拒绝接管，权限错误返回 unknown。命名空间依据 [Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces)。停止使用 retained handle/TerminateJobObject，不使用 taskkill 或重查 PID 后强杀。父进程退出、管道 EOF 均不足以证明完成，必须查询 active process count=0；重启恢复同时要求 supervisor 已 missing/other 与对应 Job 已空/消失，supervisor owned/unknown 一律留槽。Node boot 已接该独立恢复协议。

独立 supervisor 协议是一行有界请求 + 保持打开的控制管道；EOF/取消都关闭本次工作，内层 Blender 只有验证当前 native Job membership 后才能使用 Windows 有界捕获。**主 Node 桥的 Windows 新建能力门仍关闭**；原生入口供独立原生验证，不因存在代码或 Mac 模型测试就开放主桥/生产。后续原生验证与受控开放还需独立证据/授权。

### 本轮最终验证

- 正常 local registry → 实际 RF-02/Python → 受控 Blender → 实际产物门 → seal/current：6 项集成测试通过，其中 jobs 路径明确移除 VITEST，不调用 jobs test hooks。
- 显式 `BEIAN_TEST_BLENDER_FULL=1 BEIAN_TEST_BLENDER_EXPORT=1`：**真实 Blender 合成 full/card/GLB + 正常 registry/seal/current，以及独立实际 GLB 导出，共 2 passed，72.45 秒**。这是最终代码上的重新执行，不借用早先 65.38 秒结果；使用现有 compat-legacy-v0 和现有分辨率，不改 profile/F、材质、灯光或批准 baseline；源稿只是测试生成的合成结构/PDF。
- 七个 Python 相关完整模块（generation、GLB、pipeline V2、render contract、structure artwork、bounded Blender process、Windows owned job）：**379 passed / 6 skipped，191.29 秒**。其中 2 个真实 Blender opt-in 已按上一项另跑通过；另 4 个 Windows 原生 opt-in 在 Mac 未运行。Windows model 16 passed，不是原生通过。
- 最终扩大到全部 **24 个 `test_packaging*.py` 模块**，明确排除四项真稿测试后：**845 passed / 6 skipped / 4 deselected，198.44 秒**。该集合包含上面的 379 项，不相加；六项跳过仍是同样的 2 个 Blender opt-in 与 4 个 Windows 原生测试。四项 deselected 是范围限制，不是删断言、降阈值或已取得真稿验收。
- 服务端全部 `src/*.test.ts`：**706 passed / 1 skipped，14.22 秒**；跳过项为 Mac 不能运行的 Windows 平台用例。包含最后补充的预留恢复有界元数据用例；早先 684/123 等聚焦数字不与此结果相加。
- `npm run typecheck -w beian-server`、`npm run quality` 通过，**59 项原基线（knip 57 / vulture 2）不变**，未调阈值或删除有效断言。Python 有 5 条第三方 SWIG 类型 DeprecationWarning，不是项目用例失败。本轮没有 UI 实现改动，UI 构建/E2E 不作 RF-04 已实现证据。
- 已覆盖真实 allocator 进程退出恢复、同名替换保留、资源超限停止 worker、封存/提交超时保留旧图、最终 ready 文件/清单替换拒绝，以及 Windows parent/container 12 种恢复状态组合。

### 剩余外部门禁（不纳入本地通过）

1. Windows 原生 opt-in：真实 Job atomic creation、父先退/后代、内存、取消、创建后 Resume 前 supervisor 崩溃与恢复；之后再评估主桥受控创建能力开放。
2. 生产适配器注册/发布授权及杭州来源、可信 main 发布链和公网版本证据；本轮没有开启或执行。
3. 真实客户稿 L2、刘籽烨 UAT、正式视觉 baseline、断电耐久性；本轮没有杭州客户作业或金标。下述误执行的本地 PDF 解析测试不计 L2 或本目标合成验收。
4. 原 PDF 内嵌图像清晰度、重采样历史、投影反推 ppm 属 RF-08；本轮只证明已解析六面 PNG 网格，不宣称原始内容清晰。

RF-04 保持 可实施 PLAN ONLY（方案文档待后续 RF-04 分支交付）：明确 per-action 权限、三个接口/CAS、16 条创建幂等、旧 relight 迁移、全资源旧单虚拟身份、三图绑定、activated 审计恢复、回滚和 A/B/C/D 测试矩阵；界面尚未实施。

### Goal 逐项交付核对

| 已授权要求 | 本地实现/证据入口 | 结论与边界 |
|---|---|---|
| 磁盘预留、异常/崩溃释放 | `renderGenerationBudget.ts`；budget 测试含真实 allocator exit(37)、过期分配回收、替换与坏元数据保留 | 已实现/本地验证；unknown ownership 保留预留，不删除业务代 |
| 运行输出增长与全进程内存 | budget + bridge；真实子进程 RSS、输出增长超限停止与退出屏障测试 | 已实现/本地验证；采样限额不冒充内核硬峰值保证 |
| seal/最终 current 统一时间预算 | `renderGenerations.ts` + `mockupAtomicWrite.ts` + jobs；复制、fsync 后、rename 前超时/取消断言 | 已实现/本地验证；同步 OS 调用为协作检查点 |
| 旧图与共享槽安全 | jobs-generation/store/bridge 回归：取消、超时、复制失败、unknown worker、崩溃 orphan 恢复 | 已实现/本地验证；失败不自动激活 ready orphan |
| Windows 归属竞态、父先退、取消与恢复 | 四个 Windows Python 模块 + Node boot；16 个本地 model 用例与 12 种 Node supervisor/container 组合 | 代码/本地替身完成；4 个原生用例未跑，主桥新建门继续关闭 |
| 完整 runtime 凭证与正常接线 | 实际产物子门 + lifecycle 绑定一次性 verifier + final ready 重验；普通 local registry 无 jobs hook 集成 | 本地产物合同路径完成；productionEnabled 固定 false，upgrade 拒绝 |
| 真实合成 full/card/GLB | 显式 Blender full 与实际 GLB 导出测试，使用已有参数/纯合成数据 | 本机合成证据；没有客户稿、默认 F/profile 改动或基线批准 |
| RF-04 可实施方案 | RF-04 §3–10：权限/HTTP/CAS/幂等/旧入口/代绑定/审计/回滚/A–D；§11 产品取舍 | PLAN ONLY 完成；没有实施 API/UI |
| 文档与验证交付 | 本节测试总表、ADR-007 当前增量、TODOS 外部门禁 | 各阶段证据分开；无提交/推送/PR/合并/部署/消息 |

### 验证范围偏差记录

扩大 packaging 回归时，首次通配符命令误包含 `test_packaging_dieline.py` 中 4 个 `test_real_*`。其样张目录在本机存在，测试阶段已越过该模块；不能把这轮称为纯合成测试。发现后对本次 pytest PID 发 SIGINT 并确认退出（exit 2；中断汇总 530 passed / 2 skipped），该汇总不计作交付通过证据。

从测试与 `make_layer_pdf()` 源码核对，这 4 项会读取本地 AI 内嵌 PDF、把图层筛选副本写入 pytest `tmp_path` 后做刀线解析；没有调用 Illustrator/Blender 或源文件写回。没有再次读取真稿进行核验，没有发送/上传这些派生数据，也没有擅自删除临时派生文件。此误执行违反了本目标“不使用真实客户稿”的范围约束，已向用户明确报告；不能由后续绿测抵消。

后续扩大回归命令以四个完整 node ID 显式 `--deselect` 排除这些测试，不修改测试或弱化断言；仅其余合成/源码合同测试计入本地回归。默认全仓命令是否将真稿测试改为显式 opt-in 属于另一个测试策略变更，本轮未顺带修改。

最终安全范围复跑命令（在 `apps/web/backend`，普通回归不启用 Blender/Windows opt-in）：

```bash
PYTHONPATH=. .venv/bin/python -m pytest -q -rs tests/test_packaging*.py \
  --deselect=tests/test_packaging_dieline.py::test_real_26h17_recovers_square_flower_box \
  --deselect=tests/test_packaging_dieline.py::test_real_26f23_collagen_stick_folds \
  --deselect=tests/test_packaging_dieline.py::test_real_5pack_is_flat_carton \
  --deselect=tests/test_packaging_dieline.py::test_real_30ml_is_pouch
```

实际最终调用还带有原想避免重跑七个核心模块的 `--ignore` 参数，但 shell 已把通配符展开为显式文件，pytest 仍收集了它们；因此最终证据按全部 24 模块记录，不错误宣称为不重叠的 17 模块，也不叠加测试数量。上面的等效复跑命令去除了无效 ignore。
