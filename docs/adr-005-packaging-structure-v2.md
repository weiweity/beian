# ADR-005：用语义结构 IR 取代包装刀线几何猜测

日期：2026-08-27

## 状态

已决定；`0.14.0.0` 引入 V2 能力，后续版本完成真实稿迁移验证后，网页新任务固定进入 V2。运行时旧引擎开关已删除：无法证明结构或尚未人工确认时必须停住，不能回落到旧算法生成看似成功但六面错误的产物。合入后的杭州 L1 身份冒烟仍是发布门，失败时保留上一生产版本；真实稿 Illustrator → Blender、六面贴图和人工金标属于独立 L2 业务验收，不把 Mac L0 或身份冒烟写成真实生产验收。

`0.15.0.0` 在不改变闸门的前提下，把 GLB 验证从轴向和毫米尺寸扩展到六个已确认面的贴图来源、方向与镜像；底面缺图或任一面绑定不一致都不得作为成功产物。

V2.2 把旧稿迁移从“六个完整矩形 + 全局阈值”的案例模型升级为有预算的确定性结构求解：Illustrator 曲线先适配为可审计折线；所有几何进入同一毫米坐标系；按连通分量隔离结构与标注；候选由四面盒身环和上下封口组件组成；公共 API 只发布经过最终确认引擎预演成功的锚点。封口组件不再用一个主盖片代理整套物理结构，而是显式携带每个折片、连接盒身、覆盖范围与层序；标准相向对开摇盖因此由组合覆盖证明，而不是靠降低单片阈值。它不按纸色、印刷色、普通图层名或文件名猜外盒，也不增加第二套 3D 流水线。

## 背景

旧打样链路只要发现“刀线/刀版”层，就从栅格或普通矢量线推断长宽高和六面。真实 AI 中结构线、转曲正文、工艺标注和重复路径可能位于同一 OCG；结果会出现错误裁切、红线进入贴图、文字丢失和尺寸看似合理但实际错误。继续增加颜色、间距或 bbox 阈值无法证明线条的包装语义。

## 决定

新增独立的 `workers/packaging/structure_v2` 深模块，以版本化 `PackagingStructure v1` 作为唯一结构事实源：

1. 输入适配器只把可验证的显式语义翻译为 IR。当前实现是结构 sidecar 与 Illustrator 语义导出；ISO 19593、CF2、DXF 等必须取得真实样本并完成独立适配器验证后再接入。
   Illustrator 语义导出只有一份 `export_structure.jsx`：macOS 由 AppleScript 调用；Windows 的 LocalSystem worker 通过 UTF-8 命名管道请求登录桌面的 PowerShell Agent，Agent 再调用现有 `cscript` / `run_export.vbs`，由 VBS `GetObject` 连接同一交互会话中的 Illustrator 并执行 JSX。平台桥只负责会话、生命周期、超时与错误合同，不复制结构算法。导出贴图时，唯一 JSX 只在未保存的工作副本中临时解锁目标对象及其父组/图层，隐藏结构语义路径后输出 artwork；`CompoundPathItem`、裁切 `GroupItem`、`SymbolItem` 等宿主属性逐节点隔离读取，单个节点不支持锁属性时仍继续处理其余祖先。回滚按相反顺序尝试恢复全部可见性与实际改过的锁，最后统一报告失败；关闭文档时不保存，任何无法证明完整恢复的路径都失败关闭。
2. IR 显式记录顶点、`cut/crease/perforation/glue/ignore` 边、面、折角、六面角色、artwork 变换和来源对象。
3. 使用 Shapely/GEOS 做吸附、线合并、polygonize 和 dangle/cut/invalid-ring 诊断。
4. 只有验证为 `accepted` 的 IR 才能生成 `ResolvedPackagingJob` 并调用现有 Blender；歧义结构进入人工确认，不再自动猜。
5. 旧 `dieline.py` 冻结，只保留给命令行诊断；Hono 对所有网页新任务写 `structure_engine=v2`，不再暴露运行时旧引擎开关。V2 不能解析时返回人工确认或不支持，绝不静默回退。
6. 对没有对象级语义的历史 AI，服务端先识别刀线层，Illustrator 只提取该层内“描边且无填充”的路径作为不可信线稿。直线保持原端点；三次贝塞尔曲线由唯一的 ES3 helper 自适应细分，并把容差、原路径引用、段数和 `bezier_flatten` repair 写入 `source.geometry`。Mac AppleScript 与 Windows Agent 都在执行前把这份固定 helper 内联到运行 JSX，避免相对 include、当前目录和系统代码页产生平台分叉。超过单段、单路径或全稿预算时失败关闭。
7. 输入适配器只输出一个 `artboard-top-left` 毫米坐标系；吸附、提案、人工确认、贴图变换和最终尺寸都消费同一 basis。毫米结果按统一精度归一，避免整体旋转、Illustrator 浮点噪声或重复描边让“识别时可选、提交时失效”。候选身份由提案合同版本、源稿哈希、basis 和候选几何生成的稳定 `proposal_id`，再与当前 `structure_hash` 双重绑定，不再使用可被重排复用的序号；合同升级后旧页面提交会明确失效，而不是套用新语义。
8. 拓扑先用 Shapely `STRtree` 按容差把原始描边分成空间连通分量，再只在各分量内部吸附、节点化和寻找候选；不能先对整张稿 `unary_union` / `polygonize`。大量尺寸标注、签字框、表格和内衬因此不会先耗尽全稿拓扑上限。硬上限、候选分量上限与全局工作预算仍然保留，任何预算耗尽都以 `structure_limit_exceeded` 失败关闭。它是资源安全边界，不是用“放大连通分量数量”掩盖结构问题。
9. 候选模型是“四个连续盒身面 + 上下两个封口组件”。盒身候选必须四边都有来源线，内部尺寸线、标注线或正文描边不会把物理盒面切成两个；缺一条外边的三边框只能作为封口候选，不能进入盒身环。完整闭合且尺寸接近 footprint 的单片盖板仍优先。对 FEFCO 0201/RSC 一类相向对开摇盖，两个成员必须连接到相对盒身面，每片覆盖 45%–55%，覆盖率总和位于 94%–102%，且在成盒 footprint 上的几何并集至少为 94%；超过工艺缝范围的重叠因为缺少可信叠放顺序而失败关闭。单个短防尘翼、插舌、正交侧翼或由交叉标注线构造的开放盒身仍会被拒。确认后每个成员按自己的共享折线独立确定方向和仿射变换；原始 PDF 未绘制区域与物理未覆盖区域的 Alpha 都保留为 0，不得拉伸或填成白色。Blender 以二值 Alpha Mask 覆盖在显式 `render.substrate_rgba` 纸板核心之上，最终 GLB 必须复核六面 `MASK`、RGBA 来源、Core 绑定和基材颜色。未知基材明确默认白卡 `[1,1,1,1]`；牛皮纸或深色纸板必须由渲染配置显式给值，不能从印刷颜色猜测。成盒 `width/depth/height` 只由四个盒身面求解。若同稿同时存在外盒与白色内衬，只有各自结构完整时才分别成为候选并按成盒体积排序，管理员选择整套盒型，系统仍不读取颜色作判断。
10. 每个候选在返回页面前，使用与最终确认完全相同的决策引擎枚举四个盒身面和 0/90/180/270° 阅读方向。只有能唯一推导 front/right/back/left/top/bottom、折叠关系和六面 artwork transform 的锚点才进入 `valid_anchors`；页面禁用其余组合。确认时再次校验当前源稿、structure hash、basis 与锚点，防止旧页面提交已失效序号。
11. HTTP 合同把语义失败与网络失败分开：格式错误仍是 400；源稿或候选版本过期是 409；当前结构在形式上有效但不能成盒是 422。页面捕获确认失败并在原位显示可执行说明，不再留下未处理 Promise，也不把 400/409/422 说成网络中断。重复提交沿用同一确认锁和幂等恢复合同。

### 人工确认合同

- 人只提供一个最小语义锚点：`proposal_id + front_face_id + quarter_turns`，不再逐面填写六个角色。
- 公共锚点只引用后端生成的完整盒型：稳定 `proposal_id` 绑定当前源稿、坐标 basis 和候选几何，独立 `structure_hash` 再绑定当前结构版本；原始矩形候选、路径编号和本机路径不进入公共 API。
- 四个盒身面按展开图连通顺序形成环。正面确定后，右侧、反面、左侧可唯一推导；位于盒身横带相对侧、各自只连接一个盒身面的封口组件映射为顶部和底部。`box-net-proposal/3` 的每个 closure 显式携带 `primary_face_id + members[]`；所有物理成员都进入候选身份、确认和贴图合同。局部防尘翼不会仅靠人工点击升级成完整盒面。
- 同一来源适配器的尺寸策略贯穿完整盒型提案、锚点确认和最终解析；用户选择正面不会切换精度规则，也不会把封口让位改写成成盒尺寸。
- 锚点只能减少“哪一面是产品正面”这种业务歧义，不能覆盖结构歧义。完整网不唯一、相对面尺寸不一致、折叠图不连通或贴图方向不成立时仍停在待确认/不支持状态。
- 旧任务若只有零散 `face_proposal` 而没有完整 `net_proposals`，前端拒绝沿用旧逐面表单，要求补齐结构语义并重新识别。
- 批准后的 sidecar 用 `packaging-artwork-assemblies/1` 保存 top/bottom 物理成员及层序；`resolved-packaging-job/3` 为每个角色输出 `artwork_layers[]`，每层独立携带 `artwork_transform`、`artwork_coverage_bounds_mm` 和 `z_index`。候选合同为 `box-net-proposal/3`，缓存合同为 `packaging-structure-cache/6`，流程版本为 `1.4.0`。旧 `/2`、`/5` 待确认记录必须重新识别，不能被静默升级或绕过新版验证。

## 依据

- ISO 19593-1 定义包装 PDF 中切割、压痕、折叠、上胶和尺寸等处理步骤元数据。
- Esko 的结构设计/3D 文档把 cut、crease、fold angle 与 artwork 分离。
- Adobe Illustrator scripting 的 `PathPoint` 同时提供 anchor、leftDirection 和 rightDirection；曲线必须读取控制柄，不能把相邻 anchor 直接当直线。
- Shapely/GEOS 的 `polygonize_full` 会分别返回 polygon、cut edge、dangle 和 invalid ring；`snap` 只在容差内移动顶点。因此本项目把曲线适配、同源近点归一与拓扑诊断分开，而不是用一次无界“自动补线”掩盖断口。
- Shapely `STRtree` 是只读空间索引；当前 V2.1 用它在任何全局 GEOS 节点化之前隔离原始描边分量，并限制空间邻接数量。索引只缩小搜索范围，不决定 cut / crease 语义，也不改变最终盒型判断。
- Shapely 的 `shared_paths` / 拓扑关系以真实共享边表达几何邻接；盒盖方向因此从共享折线派生，而不是从相邻多边形 bbox 或中心距猜测。
- FOLD 图模型证明 vertices/edges/faces/assignment/fold-angle 的抽象可复用；因规范仍是 rough draft，本项目不直接采用 `.fold` 作为生产合同。
- Esko Studio Toolkit 与 ArtiosCAD 都先检查完整刀线/压痕形成的面，再让操作者选一个 base panel，其他面围绕该面折叠；若面不完整或不能选中目标面，应回头修结构，而不是逐个手填面角色。
- Esko 的官方折盒教程要求先把线明确赋为 Cut 或 Crease，再检查双线等刀模错误、选择一个 Base Panel 并按每条 crease 的折角成盒；ArtiosCAD 官方样式目录也把主插舌、侧翼/防尘翼和折线作为同一封口结构展示。它们共同支持“语义边 + 面邻接 + 封口组件”的模型，并不支持用屏幕颜色直接决定刀线语义。
- EngView 3D Presenter 把包装表示为面及其折叠序列，并提供 Set Base Panel；这独立验证了“完整结构图 + 单一基准面”比“把所有矩形暴露给用户”更接近成熟包装 CAD 的交互边界。
- Microsoft 明确说明 Windows 服务运行在 Session 0，带 GUI 的程序应拆成登录用户侧进程，并通过命名管道等 IPC 与服务通信；命名管道默认 ACL 还会给 Everyone 与匿名账户读权限，因此本项目显式只授权 LocalSystem 与当前登录管理员。
- Windows Task Scheduler 的 `InteractiveToken` 只在用户已登录的现成交互会话运行，符合“注销即不可打样、绝不静默降级到 Session 0”的失败语义。
- Adobe 官方说明 Illustrator 支持 Visual Basic、AppleScript 与 JavaScript/ExtendScript。本项目据此保留一份 JSX，把 Windows VBS 和 macOS AppleScript 限定为平台启动桥，而不是两套结构识别实现。
- FEFCO 把 02 系列定义为带顶底摇盖、通过这些摇盖闭合的开槽箱；0201/RSC 的物理闭合来自相向摇盖组合，不应要求任意单片独立覆盖整面。
- Khronos glTF 2.0 把 `MASK` 定义为全不透明/全透明的覆盖遮罩，而 `BLEND` 面向半透明材质且存在排序实现差异；Blender 官方导出文档同样建议可用时优先 Alpha Clip/Mask。因此本项目让未印刷区显示纸板核心，不把纸盒本体做成半透明表面。
- Illustrator 脚本对象模型分别声明 `CompoundPathItem`、`GroupItem`、`SymbolItem` 的 `parent`、`layer`、`locked` 与 `hidden` 属性；真实宿主仍可能在代理对象或关闭中的文档上抛异常，所以属性访问和回滚必须逐节点隔离，而不是假设普通 JavaScript 对象。

交叉验证来源：[ISO 19593-1 processing steps](https://www.iso.org/obp/ui?_escaped_fragment_=iso%3Astd%3Aiso%3A19593%3A-1%3Adis%3Aed-2%3Av1%3Aen)、[FEFCO Code](https://www.fefco.org/technical-information/fefco-code)、[FEFCO RSC](https://www.fefco.org/node/656)、[Adobe PathPoint scripting](https://ai-scripting.docsforadobe.dev/jsobjref/PathPoint/)、[Adobe CompoundPathItem](https://ai-scripting.docsforadobe.dev/jsobjref/CompoundPathItem/)、[Adobe GroupItem](https://ai-scripting.docsforadobe.dev/jsobjref/GroupItem/)、[Adobe SymbolItem](https://ai-scripting.docsforadobe.dev/jsobjref/SymbolItem/)、[Adobe Paths and shapes](https://helpx.adobe.com/illustrator/using/artwork-essentials/paths-and-shapes.html)、[Shapely polygonize_full](https://shapely.readthedocs.io/en/2.0.6/reference/shapely.polygonize_full.html)、[Shapely snap](https://shapely.readthedocs.io/en/stable/reference/shapely.snap.html)、[Shapely STRtree](https://shapely.readthedocs.io/en/latest/strtree.html)、[Esko：Select the Base Panel](https://docs.esko.com/docs/en-us/studiotoolkitforboxes/12.1/userguide/en-us/common/stb/task/ta_select_the_base_panel.html)、[Esko：Folding a box](https://docs.esko.com/docs/en-us/studioadvanced/22.07/userguide/en-us/common/ste/task/ta_ste_tutorialARD.html)、[Esko ArtiosCAD Style Catalog](https://docs.esko.com/docs/en-us/artioscad/23.11/adminguide/pdf/StyleCatalogReference.pdf)、[Esko ArtiosCAD：Creating a new 3D workspace](https://docs.esko.com/docs/en-us/artioscad/14.1/userguide/en-us/common/ac/topic/UG5_Artios-3D_id873265U3D24.html)、[EngView：3D environment](https://downloads.engview.com/online_help/7.3/package_designer/en/ang/3D/td-work-env.htm)、[Khronos glTF 2.0](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)、[Blender glTF material export](https://docs.blender.org/manual/en/5.3/addons/scene_gltf2.html)、[Khronos glTF Validator](https://github.com/KhronosGroup/glTF-Validator)、[Microsoft Interactive Services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)、[Microsoft Named Pipe Security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)、[Microsoft InteractiveToken](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskfolder-registertaskdefinition)、[Adobe Illustrator scripts](https://helpx.adobe.com/illustrator/desktop/automate-visualize-data/automate-actions/install-and-run-scripts.html)。

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
- Git 只保存人工构造的脱敏结构回归矩阵，覆盖白色外盒+内衬、曲线闭合、任意整体旋转和大量标注分量；这些 L0 合同不能替代任何真实品牌稿的 L2 结论。
- Mac L0 不替代杭州 Illustrator/Blender L1/L2。
- GLB 必须同时通过轴向、毫米尺寸和 front/right/back/left/top/bottom 六面贴图绑定验证；不能用「模型能打开」替代六面完整性。
- 杭州 self-hosted runner 是生产执行边界，只接受 `main` push；PR 与可选择任意 ref 的 `workflow_dispatch` 均不得在其上执行代码。Mac L0 先验证协议和失败路径，合入后的不可变目标 SHA 由 `hangzhou-release` 在 transaction fence 内同步生产 InteractiveToken Agent，再通过管道 → VBS → 唯一 JSX 做 L1 身份冒烟；通过后才开放业务。冒烟不接触真实稿件，完整 L2 仍需人工核定的黄金样本。
- 一次性 0.19→0.20 离线自举只能重跑同一条失败的可信 `main` push，不能新建手工分发或从分支选择 SHA。此安全边界优先于合并前 Windows 冒烟；Windows 回归失败会触发发版事务回滚并保持业务关闭，不能让未合并代码先进入生产桌面。
- 私有语料仍需持续补齐人工真值；这决定可自动接受的覆盖率，不再决定是否回退旧引擎。未覆盖样本必须失败关闭。

## 后果

新增格式只需实现适配器，不再修改 Blender 或复制核心拓扑。网页双路径和临时设置闸门已经移除；旧实现只保留为离线诊断基线。更多真实盒型可通过“适配器 → 标准 IR → 有预算拓扑 → 同一确认引擎”扩展，而不是继续按任务 ID 增加阈值。自动率可能下降；错误自动接受必须为零。Phase 0 持续扩充覆盖率，Windows 门验证运行环境，二者都不能用降低拓扑或六面贴图断言来绕过。
