# ADR-005：用语义结构 IR 取代包装刀线几何猜测

日期：2026-08-27

## 状态

已决定；`0.14.0.0` 先发布可回滚的 V2 能力，生产设置 `PACKAGING_STRUCTURE_V2_ENABLED` 默认关闭。Phase 0 私有真值、杭州 Windows L1/L2 与真实黄金样本未通过前，不得打开默认流量。

## 背景

旧打样链路只要发现“刀线/刀版”层，就从栅格或普通矢量线推断长宽高和六面。真实 AI 中结构线、转曲正文、工艺标注和重复路径可能位于同一 OCG；结果会出现错误裁切、红线进入贴图、文字丢失和尺寸看似合理但实际错误。继续增加颜色、间距或 bbox 阈值无法证明线条的包装语义。

## 决定

新增独立的 `workers/packaging/structure_v2` 深模块，以版本化 `PackagingStructure v1` 作为唯一结构事实源：

1. 输入适配器只把可验证的显式语义翻译为 IR。当前实现是结构 sidecar 与 Illustrator 语义导出；ISO 19593、CF2、DXF 等必须取得真实样本并完成独立适配器验证后再接入。
   Illustrator 语义导出只有一份 `export_structure.jsx`：macOS 由 AppleScript 调用，Windows 由 `Illustrator.Application` COM 的 `DoJavaScriptFile` 调用。平台桥只负责生命周期与启动，不复制结构算法。
2. IR 显式记录顶点、`cut/crease/perforation/glue/ignore` 边、面、折角、六面角色、artwork 变换和来源对象。
3. 使用 Shapely/GEOS 做吸附、线合并、polygonize 和 dangle/cut/invalid-ring 诊断。
4. 只有验证为 `accepted` 的 IR 才能生成 `ResolvedPackagingJob` 并调用现有 Blender；歧义结构进入人工确认，不再自动猜。
5. 旧 `dieline.py` 冻结，迁移期只作回滚基线。Hono 只在管理员明确打开 `PACKAGING_STRUCTURE_V2_ENABLED` 时给新任务写 `structure_engine=v2`；默认关闭时清单保持旧合同。V2 过黄金样本和 Windows 门后打开流量，稳定一个发布周期后删除旧控制路径和该临时闸门。

## 依据

- ISO 19593-1 定义包装 PDF 中切割、压痕、折叠、上胶和尺寸等处理步骤元数据。
- Esko 的结构设计/3D 文档把 cut、crease、fold angle 与 artwork 分离。
- Adobe Illustrator scripting 能读取路径属性，但不能凭 PathItem 本身证明包装领域语义。
- Shapely/GEOS 已提供 `snap`、`line_merge` 和 `polygonize_full` 及拓扑错误输出。
- FOLD 图模型证明 vertices/edges/faces/assignment/fold-angle 的抽象可复用；因规范仍是 rough draft，本项目不直接采用 `.fold` 作为生产合同。

## 边界

- Hono `:8787`、打样队列、Blender/PPT/GLB/白底输出合同保持不变。
- 不新增 Python HTTP、数据库、端口或第二套 3D 流水线。
- 无显式单位或结构语义的旧 AI 进入 `review_required`。
- 私有稿件、人工真值和金标输出留在 Git 外。
- Mac L0 不替代杭州 Illustrator/Blender L1/L2。
- PR 只在同仓分支触发杭州 self-hosted 冒烟：先等本机 Illustrator 队列空闲，再用 COM `DoJavaScriptFile` 执行一次临时 JSX；不改 `D:\beian`、不重启 `:8787`、不接触稿件。完整 L2 仍需真实黄金样本。
- 当前私有 Phase 0 的 13 份真实稿都还没有人工结构真值，因此本 ADR 的“默认切换”条件尚未满足。

## 后果

新增格式只需实现适配器，不再修改核心拓扑。短期存在 V1/V2 迁移代码，但双路径有明确删除任务，不能成为永久补丁层。自动率可能下降；错误自动接受必须为零。`0.14.0.0` 可部署代码与只读验证入口，但 Phase 0 + Windows 门未绿时闸门保持关闭，线上结果仍由既有入口控制。
