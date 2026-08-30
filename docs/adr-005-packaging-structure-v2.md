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
   Illustrator 语义导出只有一份 `export_structure.jsx`：macOS 由 AppleScript 调用；Windows 的 LocalSystem worker 通过 UTF-8 命名管道请求登录桌面的 PowerShell Agent，Agent 再调用现有 `cscript` / `run_export.vbs`，由 VBS `GetObject` 连接同一交互会话中的 Illustrator 并执行 JSX。平台桥只负责会话、生命周期、超时与错误合同，不复制结构算法。
2. IR 显式记录顶点、`cut/crease/perforation/glue/ignore` 边、面、折角、六面角色、artwork 变换和来源对象。
3. 使用 Shapely/GEOS 做吸附、线合并、polygonize 和 dangle/cut/invalid-ring 诊断。
4. 只有验证为 `accepted` 的 IR 才能生成 `ResolvedPackagingJob` 并调用现有 Blender；歧义结构进入人工确认，不再自动猜。
5. 旧 `dieline.py` 冻结，只保留给命令行诊断；Hono 对所有网页新任务写 `structure_engine=v2`，不再暴露运行时旧引擎开关。V2 不能解析时返回人工确认或不支持，绝不静默回退。
6. 对没有对象级语义的历史 AI，服务端先识别刀线层，Illustrator 只提取该层内“描边且无填充”的路径作为不可信线稿。结构模块先枚举四个连续盒身面和两个相对封口面组成的完整六面盒型，过滤内嵌尺寸框、参考图和不完整矩形；页面不得把零散矩形直接交给用户猜。若有多个完整盒型，管理员先选择整套盒型，再只选择产品正面和 0/90/180/270° 阅读方向。其余 front/right/back/left/top/bottom 角色由连通顺序推导，并再次经过相对面尺寸、折叠图和六面贴图验证；无法形成完整盒型时失败关闭。

### 人工确认合同

- 人只提供一个最小语义锚点：`proposal_id + front_face_id + quarter_turns`，不再逐面填写六个角色。
- `proposal_id` 只引用后端生成且与当前源稿哈希绑定的完整盒型；原始矩形候选、路径编号和本机路径不进入公共 API。
- 四个盒身面按展开图连通顺序形成环。正面确定后，右侧、反面、左侧可唯一推导；两个位于盒身横带相对侧的封口面映射为顶部和底部。
- 锚点只能减少“哪一面是产品正面”这种业务歧义，不能覆盖结构歧义。完整网不唯一、相对面尺寸不一致、折叠图不连通或贴图方向不成立时仍停在待确认/不支持状态。
- 旧任务若只有零散 `face_proposal` 而没有完整 `net_proposals`，前端拒绝沿用旧逐面表单，要求补齐结构语义并重新识别。

## 依据

- ISO 19593-1 定义包装 PDF 中切割、压痕、折叠、上胶和尺寸等处理步骤元数据。
- Esko 的结构设计/3D 文档把 cut、crease、fold angle 与 artwork 分离。
- Adobe Illustrator scripting 能读取路径属性，但不能凭 PathItem 本身证明包装领域语义。
- Shapely/GEOS 已提供 `snap`、`line_merge` 和 `polygonize_full` 及拓扑错误输出。
- FOLD 图模型证明 vertices/edges/faces/assignment/fold-angle 的抽象可复用；因规范仍是 rough draft，本项目不直接采用 `.fold` 作为生产合同。
- Esko Studio Toolkit 与 ArtiosCAD 都先检查完整刀线/压痕形成的面，再让操作者选一个 base panel，其他面围绕该面折叠；若面不完整或不能选中目标面，应回头修结构，而不是逐个手填面角色。
- EngView 3D Presenter 把包装表示为面及其折叠序列，并提供 Set Base Panel；这独立验证了“完整结构图 + 单一基准面”比“把所有矩形暴露给用户”更接近成熟包装 CAD 的交互边界。
- Microsoft 明确说明 Windows 服务运行在 Session 0，带 GUI 的程序应拆成登录用户侧进程，并通过命名管道等 IPC 与服务通信；命名管道默认 ACL 还会给 Everyone 与匿名账户读权限，因此本项目显式只授权 LocalSystem 与当前登录管理员。
- Windows Task Scheduler 的 `InteractiveToken` 只在用户已登录的现成交互会话运行，符合“注销即不可打样、绝不静默降级到 Session 0”的失败语义。
- Adobe 官方说明 Illustrator 支持 Visual Basic、AppleScript 与 JavaScript/ExtendScript。本项目据此保留一份 JSX，把 Windows VBS 和 macOS AppleScript 限定为平台启动桥，而不是两套结构识别实现。

交叉验证来源：[Esko：Select the Base Panel](https://docs.esko.com/docs/en-us/studiotoolkitforboxes/12.1/userguide/en-us/common/stb/task/ta_select_the_base_panel.html)、[Esko ArtiosCAD：Creating a new 3D workspace](https://docs.esko.com/docs/en-us/artioscad/14.1/userguide/en-us/common/ac/topic/UG5_Artios-3D_id873265U3D24.html)、[EngView：3D environment](https://downloads.engview.com/online_help/7.3/package_designer/en/ang/3D/td-work-env.htm)、[Microsoft Interactive Services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)、[Microsoft Named Pipe Security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)、[Microsoft InteractiveToken](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskfolder-registertaskdefinition)、[Adobe Illustrator scripts](https://helpx.adobe.com/illustrator/desktop/automate-visualize-data/automate-actions/install-and-run-scripts.html)。

## Windows 交互会话边界

1. `beian-server-8787` 与 self-hosted runner 保持 LocalSystem / Session 0；二者不得直接 `Start-Process Illustrator.exe`、`CreateObject("Illustrator.Application")` 或连接隐藏恢复稿。
2. 登录任务 `beian-illustrator-agent` 使用 `InteractiveToken` 在管理员现有 Session 1 启动。Agent 是单实例管道泵；只有它可按设置页已采用的绝对路径拉起同会话 Illustrator。
3. 管道协议固定为版本化 UTF-8 JSON；PS5/cscript 的中文系统代码页只封闭在 Agent 内部解码，不能越过管道污染 Python 错误合同。
4. 管道 ACL 只允许 LocalSystem 与当前登录管理员。请求只能选择固定 exporter、`probe`、`run` 或 `smoke`，不能提交任意脚本或命令。
5. Agent 写原子心跳，并绑定交互用户 SID、脚本 SHA-256、发布版本、checkout、管道名与 PID。Hono 在领取打样回执前检查协议、Session、身份、状态与新鲜度；Python 连接后还核对实际管道服务 PID。随后 Agent 在真正执行时按需启动并验证同会话可见窗口、可执行路径与文档列表。注销、Agent 离线、Session 0、身份不符或无可见窗口都失败关闭；不自动补拉隐藏实例。
6. 每个请求只有一条绝对期限，抢执行锁前后、预热、COM、JSX 和清理共用预算。拿锁后、进入 cscript/COM 前先写所有 Agent 实例共用的持久执行围栏；只有成功或已经证明清理完成的失败才能删除。Agent 中断、cscript 退出未确认或文档无法证明已清空时围栏保留、心跳保持 `faulted`，其他实例即使取得文件锁也拒绝继续。围栏只能由交互管理员在确认 Agent、Illustrator、AIRobin、cscript/wscript 都已退出后，以显式 `-ClearFaultFence` 重装动作清除，自动发版和普通重启不能代替人工确认。
7. VBS 只 `GetObject`，运行前列出文档名并拒绝未知已开稿；运行后只关闭本次源稿的精确路径，不关闭用户稿件。`cscript` 有硬超时，超时只杀本次子进程。

## 边界

- Hono `:8787`、打样队列、Blender/PPT/GLB/白底输出合同保持不变。
- 不新增 Python HTTP、数据库、端口或第二套 3D 流水线。
- 无显式对象语义的旧 AI 只能生成待人工确认的刀线层候选；没有可靠刀线层、单位或闭合六面时进入 `review_required` / `unsupported`。
- 私有稿件、人工真值和金标输出留在 Git 外。
- Mac L0 不替代杭州 Illustrator/Blender L1/L2。
- GLB 必须同时通过轴向、毫米尺寸和 front/right/back/left/top/bottom 六面贴图绑定验证；不能用「模型能打开」替代六面完整性。
- 杭州 self-hosted runner 是生产执行边界，只接受 `main` push；PR 与可选择任意 ref 的 `workflow_dispatch` 均不得在其上执行代码。Mac L0 先验证协议和失败路径，合入后的不可变目标 SHA 由 `hangzhou-release` 在 transaction fence 内同步生产 InteractiveToken Agent，再通过管道 → VBS → 唯一 JSX 做 L1 身份冒烟；通过后才开放业务。冒烟不接触真实稿件，完整 L2 仍需人工核定的黄金样本。
- 一次性 0.19→0.20 离线自举只能重跑同一条失败的可信 `main` push，不能新建手工分发或从分支选择 SHA。此安全边界优先于合并前 Windows 冒烟；Windows 回归失败会触发发版事务回滚并保持业务关闭，不能让未合并代码先进入生产桌面。
- 私有语料仍需持续补齐人工真值；这决定可自动接受的覆盖率，不再决定是否回退旧引擎。未覆盖样本必须失败关闭。

## 后果

新增格式只需实现适配器，不再修改核心拓扑。网页双路径和临时设置闸门已经移除；旧实现只保留为离线诊断基线。自动率可能下降；错误自动接受必须为零。Phase 0 持续扩充覆盖率，Windows 门验证运行环境，二者都不能用降低拓扑或六面贴图断言来绕过。
