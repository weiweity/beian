# AI 包装稿 → 3D/PPT 快速流水线

这是面向重复包装结构的本地批处理流程。网页打样先读稿上 `刀线` / `刀版` 还原盒面（尺寸不预置）；密折痕花盒先密后疏试间距，折得出盒面再停；光栅读不出时才描刀线路径再折一次。没有刀线才回退 `templates/` 已登记 JSON（含 47.5 × 47.5 × 177.5 mm 方形花盒）。已能折的大方盒不改。目标是在 AI 稿结构不变时，自动完成：

1. AI/PDF 兼容性和页面尺寸预检；
2. 非 PDF 兼容 AI 自动调用 Illustrator 标准化；
3. 印刷层与完整图层分别高速栅格化（pymupdf 出图，杭州不靠 macOS qlmanage）；
4. 按切面切片纹理（膜袋只印正反，其余面空白纸面补齐）；
5. 多产品并行调用 Blender 后台建模、渲染并导出 .blend / .glb；
6. GLB 尺寸自动复核；
7. 用两张白底写成 1 页 OOXML PPT（正面+侧面、反面+侧面），不依赖 Node；写不出才试演示文稿运行时。stderr 打 `PPT 跳过` 时白底图、PDF 和 GLB 仍算成功，不要把整单判失败。`--no-ppt` 同样跳过 PPT。
8. 两张白底合成一页 PDF（页底先铺白，标题用中文字体）。pymupdf 写不出且还没落盘再用已装的 Pillow，不另装包，不要盖掉已经写出的文件。缺 PDF 不当失败。

## 运行

    # 网页打样台会调这份 CLI。本机直接跑也可以。PPT 用白底写 OOXML，不依赖 Node。不要提交 node_modules。
    python3 pipeline.py examples/jobs_26H17.json --workers 2 --force

首次运行加 --force；同一源文件、模板和流程版本未变化时，去掉 --force 会直接复用缓存。

## 输入边界

- PDF 兼容 AI 直接走高速通道，不启动 Illustrator。平面 PNG 用 pymupdf 按 MediaBox 整页出图（细 CropBox 不按可见条带放大）。杭州 Windows 与对照共用 `apps/web/backend/.venv` 里的 pymupdf，不要装 macOS Quick Look。pymupdf 失败时，本机若有 `/usr/bin/qlmanage` 才兜底。
- 原生 AI 或非 PDF 兼容 AI 自动通过 Illustrator 导出完整稿和印刷层 PDF，再进入相同建模流程。
- Illustrator 冷启动和复杂转曲稿解析可能较慢，建议保持应用常驻并批量处理异常稿；兜底 Worker 默认 7 分钟硬超时。
- 相同刀模只需新增任务记录即可并行处理。
- 网页打样先读 `刀线` / `刀版` 层，从展开图还原长宽高和切面（花盒或膜袋，尺寸不预置）。密折痕先密后疏试间距，折得出盒面再停；光栅读不出时才描刀线路径再折一次。没有刀线层才回退到 `templates/` 里已登记 JSON。读不出结构时失败，不要把方盒硬套到扁平盒或膜袋。
- Blender MCP 只保留给交互调试。稳定生产通过独立 Blender 后台进程并行执行，避免界面串行和上下文开销。

## Illustrator 兜底验证

强制让一份正常 AI 走 Illustrator 通道，用于安装或升级后的烟雾测试：

    python3 pipeline.py examples/jobs_illustrator_smoke.json \
      --workers 1 --force-illustrator --no-ppt

生产任务不应使用 --force-illustrator；流水线会根据文件头自动分流。

## 输出

每个产品目录包含：

- .blend：可编辑 Blender 文件；
- .glb：可旋转查看的通用 3D 文件；
- 正面/右侧面和背面/左侧面白底渲染图（灯光收一点、地/背板更白。已经出过的图要重新打样或加 `--force` 才会变白）；
- 打样单 PDF（两张白底一页，页底先铺白。pymupdf 写不出且还没落盘再用已装的 Pillow，不另装包、不盖掉已写成的文件；跳过时没有，也不当失败）；
- 独立 .pptx（一页两张白底：正面+侧面、反面+侧面；先写 OOXML，不依赖 Node。跳过 PPT 时没有这一项，也不当失败）；
- qa/：仅演示文稿运行时兜底才会有 PPT 质检图；OOXML 直写没有 qa/；
- pipeline_result.json：本产品产物和尺寸验证结果。

批次根目录的 pipeline_report.json 记录总耗时、缓存命中和 10 分钟 SLA 是否达成。
