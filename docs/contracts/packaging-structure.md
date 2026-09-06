# 打样结构与 Illustrator 合同

本文件保存原 AGENTS 的对应工程合同，仅在涉及本主题时读取。产品行为不构成执行作业、发送消息或操作生产的授权。日期与验收状态是记录时快照，当前结论须绑定本次证据。路径除链接外均相对仓库根。

## 结构输入与确认

打样 V2 只认显式 `PackagingStructure`：Illustrator 对象备注/对象名/图层名精确 `packaging:cut` / `packaging:crease` 等，或与源稿哈希绑定的 sidecar；显式语义或后续由已登录账号确认并绑定源稿的候选输入，才由同一 ES3 helper 有界细分，统一到一个毫米坐标系并按连通分量隔离标注噪声。没有对象语义的旧 AI 先盘点绑定源稿的纯描边候选层；只有管理员能提交详情返回的 1–16 个候选 ID，Hono 重新校验管理员身份、`confirm_structure`、当前源稿和候选成员后生成源稿绑定清单并重跑，旧 `/1` 清单必须重新识别。非管理员详情省略 `structure_input`。

## 候选预览预算

旧稿涂亮把刀线候选与烫雅银等填色工艺板分成两套预览预算（各 5000 路径 / 20000 点）；Illustrator 先盘点描边层，预算满了不再读 `PathPoints`，第二遍只扫第一遍剩下的项。未知或重复涂亮层和坏掉的工艺板单独跳过，不得把整份刀线预览清掉；超大或非法几何才关掉整份预览，管理员选层入口仍在。不得把两套预算合成一份。所选线稿仍须通过完整盒身环和上下封口验证，不能直接进入 Blender。

## 拓扑与成盒验证

Shapely 拓扑只向已登录账号暴露完整“盒身环 + 封口组件”候选，多方案时用真实展开图视觉翻页；唯一可确认正面时服务端自动出图，多面时已登录账号只点品名面；阅读方向由最终预检的几何建议自动带入；外盒/内衬按成盒体积排序，不能读颜色。每个公开锚点必须先经最终确认引擎预检；候选身份由绑定源稿、basis 与几何的稳定 ID，加上独立的当前结构 hash 双重约束；409 表示候选过期，422 表示语义上不能成盒。尺寸精度由适配器统一提供给提案、确认和最终解析；盒身决定成盒尺寸，顶底封口让位只做闭合校验，盒盖方向由唯一共享折线推导。不得把零散矩形交给用户，也不能按颜色、普通图层名、间距、bbox 或模板自动猜。桌面待选正面必须在一屏同时放下预览、选项、原位错误与主动作；提交失败可原位重试，不叠第二层确认框。旧 `dieline.py` 冻结为回滚基线，默认发布须有 Phase 0 + Windows 门通过的证据；后文“网页已固定走 V2”是实现状态，不替代该门禁，也不要求补回已删除开关。GLB 必须验证 front/right/back/left/top/bottom 六面贴图来源、方向和镜像，不只核尺寸。

## 打样与 Illustrator 补充合同

杭州打样平面出图走 pymupdf（对照同一 `.venv`），不要让人装 qlmanage。macOS Quick Look 只在 pymupdf 失败时兜底。打样结构以 `docs/adr-005-packaging-structure-v2.md` 为准：显式语义/有界曲线适配 → 单一毫米坐标 IR → 连通分量优先拓扑 → 必要时完整盒身环+封口组件及正面锚点确认 → 自动推导其余五面 → 现有 Blender。尺寸策略由输入适配器统一决定，盒身决定成盒尺寸，封口让位只校验闭合，盒盖方向从唯一共享折线推导；标准对开摇盖必须保留两个物理成员并按几何并集验证，未覆盖区用 Alpha Mask 露出显式纸板基底，不得填白或改用半透明纸盒。无语义或不安全结构不得进入 Blender，不得回退颜色/bbox/模板猜测。工厂旧稿全单恰好一层「刀版」或「刀线」时，第一次导出就带上该层（填色切线也算，击凹/烫金等仍是工艺板）；印刷层先精确「印刷」，否则才用唯一非刀版/工艺顶层。拼合「图层 1」、内包/标贴标当前不支持，不要停成假待确认。膜袋只认词「膜袋」，花盒折不通且两块相近刀线才走袋片。印刷、表、标注永不进默认结构提案。唯一「上刀线」（或单层「刀线」/「刀版」）默认黑盒提交候选 ID，不是把图层名当成 cut/crease；失败对籽烨结案为打样失败，选层只给 admin。拓扑成功且只有一个可确认正面时服务端自动出图；多面时只点品名面。管理员可对已出图且只有一套公开盒型的单换正面，只重跑 Blender。膜袋标准见 `docs/pouch-v1-acceptance.md`（L0 已接线；无杭州金标不得宣称产品存在）。旧稿涂亮：刀线候选与填色工艺板分预算，坏层跳过不关整份预览；超大或非法几何才 fail-closed。不得把两套预算合成一份。

## Illustrator 宿主与禁止中断阶段

Illustrator 语义导出只维护一份 JSX、一份曲线 helper 和一份 `unattended_host.jsx`；macOS AppleScript 与 Windows VBScript/COM 只在运行前内联 helper 与宿主并承担平台启动桥职责，Windows 清单必须带开工板扫描到的 `Illustrator.exe`。盘点前 hide 顶层、`enterOutlineView` 只按一次 menu `"preview"` 并用 `getViewMode` 认 Outline/轮廓，zoom 0.0625。`restoreUnattendedArtwork` 在存 PDF 前执行，任一原可见顶层仍隐藏则抛 `Cannot fully restore artwork layers`，失败走已有印刷层恢复映射，不要说成语义标记问题。关稿 `prepareUnattendedClose` 再 hide+outline+zoom 0.03125。盘点 `eachInventoryPathItem` 走 `layer.pageItems` 并展开 GroupItem/CompoundPathItem；跳过 表/标注/Dimensions/尺寸；每层 remainder 上限 512；空的隐藏集合不要把 fallback 从 `document.pathItems` 闩走。完工信号是本代 `illustrator_result.json`，不是墙钟 Kill；`opening` / `inventory` / `saving_*` / `writing_result` / `closing` 期间禁止 Kill cscript。外层天花 1260 秒。心跳 busy 时新打样单排队，不是 412，也不是围栏。`illustrator-fault.json` 的 `faulted` 只在进程重启后仍有不明文档或 Illustrator 无法再启动时落下。

## V2 实现状态与验收门

网页新打样已固定走 V2，不再有 `PACKAGING_STRUCTURE_V2_ENABLED` 运行时开关；Phase 0 私有真值和杭州 Windows L1/L2 未绿前，不能把代码完成或身份冒烟写成真实生产验收。26H21A 仍是 land 后杭州人工金标，未跑不得宣称控制面已换。PR 不得在杭州生产 self-hosted runner 执行；Windows L1 由可信 `main` 发版在 transaction fence 内验证 COM→JSX，不替代真实稿 L2。GLB 除轴向和毫米尺寸外，还必须验证六个已确认面的纹理来源、方向与镜像，底面空贴图不得通过。
