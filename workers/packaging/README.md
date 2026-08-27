# AI 包装稿 → 3D/PPT 快速流水线

这是包装平面稿到既有 Blender 流水线的本地批处理入口。V2 不再把“红线、刀线图层名、间距或 bbox 看起来像盒子”当作结构事实；它只消费版本化 `PackagingStructure`，把结构识别、拓扑验证、人工确认和 3D 生成分开。旧 `dieline.py` 只保留为迁移期回滚基线，不是 V2 的判断依据。

当前可验证的语义来源有两种：

- 同稿件哈希绑定的 `packaging-structure/1` JSON sidecar；
- Illustrator 中对象的备注、对象名或图层名精确写成 `packaging:cut`、`packaging:crease`、`packaging:perforation`、`packaging:glue` 或 `packaging:ignore`，由语义导出器同时生成结构 JSON 和隐藏这些对象后的 artwork PDF。
- macOS 用 AppleScript、Windows 用 `Illustrator.Application` COM + VBScript 启动桥；两端都执行 `export_structure.jsx`，不维护第二套 Windows 识别算法。Windows 清单必须传开工板扫描到的 `Illustrator.exe`。

颜色、普通图层名和文件名不自动升级成语义。CF2/DXF、ISO 19593 等格式必须各自有已验证样本和专用适配器后才能接入，不能伪装成已支持。目标是在显式结构语义可追踪时完成：

1. AI/PDF 兼容性和页面尺寸预检；
2. 非 PDF 兼容 AI 自动调用 Illustrator 标准化；
3. 印刷层与完整图层分别高速栅格化（pymupdf 出图，杭州不靠 macOS qlmanage）；
4. 按切面切片纹理（膜袋只印正反，其余面空白纸面补齐）；
5. 多产品并行调用 Blender 后台建模、渲染并导出 .blend / .glb；
6. GLB 自动复核轴向、毫米尺寸，以及 front/right/back/left/top/bottom 六面贴图来源、方向和镜像；
7. 用两张白底写成 1 页 OOXML PPT（正面+侧面、反面+侧面），不依赖 Node；写不出才试演示文稿运行时。stderr 打 `PPT 跳过` 时白底图、PDF 和 GLB 仍算成功，不要把整单判失败。`--no-ppt` 同样跳过 PPT。
8. 两张白底合成一页 PDF（页底先铺白，槽按源图比例 contain，标题用中文字体）。pymupdf 写不出且还没落盘再用已装的 Pillow，不另装包，不要盖掉已经写出的文件。缺 PDF 不当失败。

## Phase 0 只读语料审计

默认切换 V2 前，先用独立输出目录记录真实 AI 的哈希、画板、OCG、矢量数量、结构候选、当前解析结果和人工真值。工具不会复制或改写源稿，也不会改变线上生产选择：

    python3 tools/audit_corpus.py \
      --corpus-dir /path/to/private-ai-corpus \
      --truth /path/to/private-corpus-truth.json \
      --output-dir /path/to/private-phase0-evidence

真值格式参考 examples/corpus_truth.example.json。真实稿、真实真值和审计输出都不要提交。工具会校验阈值范围、正尺寸、完整六面、90° 旋转、人工批准人，并汇总候选方盒、结构族和黄金样本。只有每份样本都被人工批准或明确判为不支持、每个支持结构族至少有一份黄金样本、支持样本六面已确认、几何安全阈值已冻结后，才加 --require-phase0-exit 作为 Phase 1 入口门。

## 运行

    # 网页打样台会调这份 CLI。本机直接跑也可以。PPT 用白底写 OOXML，不依赖 Node。不要提交 node_modules。
    python3 pipeline.py examples/jobs_26H17.json --workers 2 --force

V2 任务在产品项中写 `"structure_engine": "v2"`。显式 sidecar 可写 `structure_sidecar`；已从结构对象清理出的印刷稿可写 `artwork_pdf`。网页 `.ai` 通道由 Illustrator 同时导出这两个文件。首次运行加 `--force`；同一源文件、结构、artwork 和流程版本未变化时，去掉 `--force` 会复用缓存，但缓存命中仍必须先通过当前 sidecar 的 `validation.status=accepted` 闸门。

网页生产发布默认不写 `structure_engine=v2`。只有管理员在真实稿真值和杭州 Windows 验收完成后打开 `PACKAGING_STRUCTURE_V2_ENABLED`，新建打样单才进入 V2；关闭时清单保持旧入口合同。此开关是迁移闸门，V2 稳定一个发布周期后应连同旧控制路径一起删除。

## 输入边界

- PDF 兼容 AI 直接走高速通道，不启动 Illustrator。平面 PNG 用 pymupdf 按 MediaBox 整页出图（细 CropBox 不按可见条带放大）。杭州 Windows 与对照共用 `apps/web/backend/.venv` 里的 pymupdf，不要装 macOS Quick Look。pymupdf 失败时，本机若有 `/usr/bin/qlmanage` 才兜底。
- 原生 AI 或非 PDF 兼容 AI 自动通过 Illustrator 导出完整稿和印刷层 PDF，再进入相同建模流程。
- Illustrator 冷启动和复杂转曲稿解析可能较慢，建议保持应用常驻并批量处理异常稿；兜底 Worker 默认 7 分钟硬超时。
- 相同结构只需新增任务记录即可并行处理；缓存键包含源稿、结构 sidecar、清理后的 artwork 和流程版本。
- `structure_v2` 用 Shapely/GEOS 做单位归一、吸附、noding、polygonize 和拓扑诊断。结构可闭合但六面角色/方向有歧义时返回 `review_required`，由管理员确认；缺语义、曲线路径需专用适配器或超过安全上限时返回可执行的 `review_required` / `unsupported`，不会进入 Blender。
- 只有 `validation.status=accepted`、源稿 SHA-256 匹配、六面角色唯一且拓扑闭合的结构才能形成 `ResolvedPackagingJob`。人工确认结果写成新的批准 sidecar，再进入现有建模、渲染、PPT 和 GLB 合同。GLB 导出后还要逐面核对已确认 artwork 绑定；底面缺图、方向错误或镜像错误都判失败。
- Blender MCP 只保留给交互调试。稳定生产通过独立 Blender 后台进程并行执行，避免界面串行和上下文开销。

## Illustrator 兜底验证

强制让一份正常 AI 走 Illustrator 通道，用于安装或升级后的真实稿 L2。PR 上的 Windows L1 只验证 COM 能返回版本、没有其他文档打开，并通过同一 `DoJavaScriptFile` 桥执行临时 JSX；它不读取真实稿，也不冒充 `structure.json` / artwork PDF 的 L2 证据：

    python3 pipeline.py examples/jobs_illustrator_smoke.json \
      --workers 1 --force-illustrator --no-ppt

生产任务不应使用 --force-illustrator；流水线会根据文件头自动分流。

## 输出

每个产品目录包含：

- .blend：可编辑 Blender 文件；
- .glb：可旋转查看的通用 3D 文件；六个已确认面都通过贴图来源、方向、镜像和尺寸复核后才交付；
- 正面/右侧面和背面/左侧面白底渲染图（棚只提亮产品和接触阴影，不改盒子材质。已经出过的图要重新打样或加 `--force` 才会变）；
- 打样单 PDF（两张白底一页，页底先铺白，槽按源图比例 contain。pymupdf 写不出且还没落盘再用已装的 Pillow，不另装包、不盖掉已写成的文件；跳过时没有，也不当失败）；
- 独立 .pptx（一页两张白底：正面+侧面、反面+侧面；先写 OOXML，不依赖 Node。跳过 PPT 时没有这一项，也不当失败）；
- qa/：仅演示文稿运行时兜底才会有 PPT 质检图；OOXML 直写没有 qa/；
- pipeline_result.json：本产品产物和尺寸验证结果。

批次根目录的 pipeline_report.json 记录总耗时、缓存命中和 10 分钟 SLA 是否达成。
