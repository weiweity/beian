# ADR-005：用语义结构 IR 取代包装刀线几何猜测

日期：2026-08-27

## 状态

已决定；`0.14.0.0` 引入 V2 能力，后续版本完成真实稿迁移验证后，网页新任务固定进入 V2。运行时旧引擎开关已删除：无法证明结构或尚未人工确认时必须停住，不能回落到旧算法生成看似成功但六面错误的产物。杭州 Windows L1/L2 仍是合并部署门，失败时保留上一生产版本。

`0.15.0.0` 在不改变闸门的前提下，把 GLB 验证从轴向和毫米尺寸扩展到六个已确认面的贴图来源、方向与镜像；底面缺图或任一面绑定不一致都不得作为成功产物。

## 背景

旧打样链路只要发现“刀线/刀版”层，就从栅格或普通矢量线推断长宽高和六面。真实 AI 中结构线、转曲正文、工艺标注和重复路径可能位于同一 OCG；结果会出现错误裁切、红线进入贴图、文字丢失和尺寸看似合理但实际错误。继续增加颜色、间距或 bbox 阈值无法证明线条的包装语义。

## 决定

新增独立的 `workers/packaging/structure_v2` 深模块，以版本化 `PackagingStructure v1` 作为唯一结构事实源：

1. 输入适配器只把可验证的显式语义翻译为 IR。当前实现是结构 sidecar 与 Illustrator 语义导出；ISO 19593、CF2、DXF 等必须取得真实样本并完成独立适配器验证后再接入。
   Illustrator 语义导出只有一份 `export_structure.jsx`：macOS 由 AppleScript 调用，Windows 由 `Illustrator.Application` COM 的 `DoJavaScriptFile` 调用。平台桥只负责生命周期与启动，不复制结构算法。
2. IR 显式记录顶点、`cut/crease/perforation/glue/ignore` 边、面、折角、六面角色、artwork 变换和来源对象。
3. 使用 Shapely/GEOS 做吸附、线合并、polygonize 和 dangle/cut/invalid-ring 诊断。
4. 只有验证为 `accepted` 的 IR 才能生成 `ResolvedPackagingJob` 并调用现有 Blender；歧义结构进入人工确认，不再自动猜。
5. 旧 `dieline.py` 冻结，只保留给命令行诊断；Hono 对所有网页新任务写 `structure_engine=v2`，不再暴露运行时旧引擎开关。V2 不能解析时返回人工确认或不支持，绝不静默回退。
6. 对没有对象级语义的历史 AI，服务端先识别刀线层，Illustrator 只提取该层内“描边且无填充”的路径作为不可信候选。矩形网络会生成六面提案并叠加真实 artwork，必须由管理员逐面选择和确认旋转；确认后删除未选候选，再进入与显式语义相同的严格解析和六面贴图验证。

## 依据

- ISO 19593-1 定义包装 PDF 中切割、压痕、折叠、上胶和尺寸等处理步骤元数据。
- Esko 的结构设计/3D 文档把 cut、crease、fold angle 与 artwork 分离。
- Adobe Illustrator scripting 能读取路径属性，但不能凭 PathItem 本身证明包装领域语义。
- Shapely/GEOS 已提供 `snap`、`line_merge` 和 `polygonize_full` 及拓扑错误输出。
- FOLD 图模型证明 vertices/edges/faces/assignment/fold-angle 的抽象可复用；因规范仍是 rough draft，本项目不直接采用 `.fold` 作为生产合同。

## 边界

- Hono `:8787`、打样队列、Blender/PPT/GLB/白底输出合同保持不变。
- 不新增 Python HTTP、数据库、端口或第二套 3D 流水线。
- 无显式对象语义的旧 AI 只能生成待人工确认的刀线层候选；没有可靠刀线层、单位或闭合六面时进入 `review_required` / `unsupported`。
- 私有稿件、人工真值和金标输出留在 Git 外。
- Mac L0 不替代杭州 Illustrator/Blender L1/L2。
- GLB 必须同时通过轴向、毫米尺寸和 front/right/back/left/top/bottom 六面贴图绑定验证；不能用「模型能打开」替代六面完整性。
- PR 只在同仓分支触发杭州 self-hosted 冒烟：先等本机 Illustrator 队列空闲，再用 COM `DoJavaScriptFile` 执行一次临时 JSX；不改 `D:\beian`、不重启 `:8787`、不接触稿件。完整 L2 仍需真实黄金样本。
- 私有语料仍需持续补齐人工真值；这决定可自动接受的覆盖率，不再决定是否回退旧引擎。未覆盖样本必须失败关闭。

## 后果

新增格式只需实现适配器，不再修改核心拓扑。网页双路径和临时设置闸门已经移除；旧实现只保留为离线诊断基线。自动率可能下降；错误自动接受必须为零。Phase 0 持续扩充覆盖率，Windows 门验证运行环境，二者都不能用降低拓扑或六面贴图断言来绕过。
