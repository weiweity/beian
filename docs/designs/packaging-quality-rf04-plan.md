# RF-04：打样出图版本与操作入口方案

状态：**A/B/C/D 已实现，进入独立分支收尾；生产新代执行未开放**。原方案形成于 2026-09-06，基于 `main e1c2d679`（0.21.35.0）与本地 RF-03 runtime 增量；当前候选基于 RF-03 `3b98552`，版本 `0.21.37.0`。本文保留实施前冻结的工程合同、A/B/C/D 切片与验收矩阵；下文“未实施 / 拟增 / PLAN ONLY”描述的是方案形成时快照。当前 API/UI、测试与限制以 [RF-04 本地交付记录](packaging-quality-rf04-closeout.md) 为准；不启用生产适配器，不批准新版视觉基线。

主合同：[ADR-007 §15](../adr-007-packaging-render-fidelity.md#15-兼容输出代际与回滚)。当前基础设施证据：[RF-03C2](packaging-quality-rf03c2-acceptance.md)；本轮增量与未完成项：[RF-03 runtime 收口](packaging-quality-rf03-runtime-closeout.md)。界面遵守 [DESIGN.md](../../DESIGN.md)，不另建第三张台、不新增 HTTP 端口。

## 1. 要交什么

在同一张已出图的打样单内提供「出图版本」「按旧版重新出图」「升级新版」「使用此版本」。重新出图时仍能看、下载当前成片；失败保留当前图；历史切回只改当前指针，不重跑 Blender。

不做：自动升级历史单、删除历史代、修改默认 F/视觉 profile、重做几何/材质/棚光、替代真实稿验收、把网页调灯变成排队动作。RF-04 本轮只写此方案，下面的 API、能力字段和界面均未实施。

## 2. 已有代码与前置缺口

| 事项 | 当前事实 | RF-04 使用方式 |
|---|---|---|
| 代际存储 | `renderGenerations.ts` 已有 g0、staging→ready、hash 绑定、历史游标、恢复与激活 patch | 复用，不造第二个存储层 |
| 调度/最终提交 | `jobs.ts` 已有 enqueue/activate、单任务互斥、全局 Blender 槽、16 条持久幂等事实 | 所有写入只经 jobs；HTTP 不直接改 job.json |
| 公开摘要 | 已有 `render_mutation`、current ID、has-history；历史完整列表不塞进任务列表 | 增量增加受权限/运行门约束的能力摘要 |
| 真实候选 | 已有实际 GLB/full/card/源 PNG 网格门、真实资源生命周期与绑定封存副本的 `runtime_verified` 凭证；普通本地 registry 在临时数据根完成无 jobs test hook 的合成全链 | 只证明本轮产物合同与资源执行；不等于视觉 baseline、原 PDF 清晰度、RF-08 或生产授权 |
| Windows | 原生 Job Object 启动/捕获/取消/恢复代码及本地模型测试存在；主桥新建门仍在 spawn 前拒绝 Windows | 原生 opt-in 测试待 Windows 执行；不回退 taskkill，不用 Mac 模型结果开启门 |
| upgrade | Python 明确拒绝 `upgrade_unwired` | 功能可以有禁用说明，不能做假升级或使用旧 profile 冒充 |
| HTTP/UI | 三个代际接口未接线；旧 `/relight` 仍是现有实现 | 按切片迁移，不以本方案宣称已完成 |

能力要按动作拆开：历史读取不依赖 Blender；已封存历史代的激活不依赖新渲染器，但仍需身份、完整性、互斥与 CAS；创建新代必须满足对应 mode 的执行门。不能用一个 `ready=true` 放行全部按钮。

RF-03 的本地 runtime 合同与资源路径已有实际验证；正常 registry 默认关闭，只允许显式临时数据根的本地评审注册，仓库内没有生产启用开关。RF-04 可先实现纯只读与禁用状态；生产写入口仍须另行获得授权及平台证据。正式视觉 baseline/L2/UAT 是另层证据，不能由 `runtime_verified` 推导。

## 3. 权限与公共响应

- 团队 `read`：查看打样单、分页历史及允许公开的成片；不因此获得写权限。
- 写动作：HTTP 校验 `create`，再由 jobs 重新校验本人或 admin。`confirm_structure` 不等于重新渲染/激活授权；viewer 不能借结构确认权限启动新代。
- 客户端只能提交公开 ID、动作、请求号、有限灯光值。禁止传路径、profile、合同、输出文件名、actor、质量结果。
- GET 不创建 g0、不执行恢复、不写索引、不启动作业；虚拟 legacy ID 只用于原图身份，不是假装已存在的历史代。

拟在详情增加 `render_generation_capabilities`，每项为 `{allowed, reason?}`：`history`、`activate`、`legacy_relight`、`upgrade`。reason 是短稳定枚举，如 `permission_denied`、`runtime_quality_unwired`、`process_containment_unavailable`、`upgrade_unwired`、`source_changed`、`mutation_busy`、`idempotency_capacity`。列表不返回平台路径/探测详情，不做大文件 hash 扫描。

capability 是界面提示，不是持久授权凭证；POST 必须按最新登录身份、源资产、当前代及运行状态重新验证。能力允许也可能因提交时状态变化而失败。

## 4. 三个接口与文件读一致性

### 4.1 分页历史

`GET /api/mockups/:id/render-generations?cursor=<opaque>&limit=20`

复用 store 的 `{items, next_cursor}`；直接复用 `RENDER_GENERATION_HISTORY_DEFAULT_LIMIT=20`、`RENDER_GENERATION_HISTORY_MAX_LIMIT=50`。每行只含 generation ID、mode、profile、时间、操作者展示名、quality status、current。隐藏无效/未完成代；完整历史不嵌入 `publicMockupSummary()`。游标有界且绑定该任务，坏游标返回稳定错误，不解释为路径。`runtime_verified` 显示为“产物校验完成”，不得显示“画质验收通过”；g0 的 `unwired` 是原图存档未补验，不把它显示成损坏。

对未 materialize 的旧单，详情返回服务端计算的虚拟 current ID；历史为空也不触发导入。不得由前端拼 `g0` 名称。

### 4.2 创建候选

`POST /api/mockups/:id/render-generations`

```json
{
  "client_request_id": "一次点击生成并保持到结算的请求号",
  "mode": "legacy_relight",
  "source_generation_id": "详情返回的当前代 ID",
  "expected_current_generation_id": "详情返回的当前代 ID",
  "studio_adjustment": {"product_light": 1, "background_light": 1}
}
```

使用 jobs 现有 enqueue 合同，返回 `202` 与现有 mutation 摘要、current ID、has-history、主单状态。HTTP 不等待 Blender；主单继续 `done`，mutation 独立为 queued/running/succeeded/failed。创建以当前代为 source，不能直接拿任意历史代重渲；先显式激活，再重新获取详情后操作。

请求号沿用现有 8–128 位字母/数字/下划线/连字符规则。提交前在本页会话保存 request ID 和规范化 payload；网络不确定时复用同号同内容。内容变化必须新号。已有幂等命中先重放原事实，不因当前代后来变化产生第二单；相同 ID 异 payload 拒绝。同单账本到 16 条后拒绝新号，不驱逐旧事实、不自动清理、不无限重试；页面解释“本单暂不能继续生成新版本，历史仍可查看”。

`upgrade` 使用相同接口，但当前 `upgrade_unwired`，不得先成功入队再宣称升级已启用。实施时在服务端 admission 加入 mode-specific gate；恢复到旧/无 adapter 代码的已排请求仍按现有恢复合同安全失败。

### 4.3 激活历史

`POST /api/mockups/:id/render-generations/:generation_id/activate`

请求只含 `expected_current_generation_id`。复用 `activateRenderGeneration`，返回更新后的公开详情。激活仅允许服务端已验证的 ready ID，不接受 `latest`、数组下标或目录。与候选最终提交用同一 job lock；queued/running/仍残留 worker ownership 时返回 busy，不以主单 done 绕过。

激活不新增 Blender 作业、不复制大文件、不更改 generation manifest。响应丢失时先重新读详情：若目标已是当前代，显示已切换；否则要求用户基于最新 current 再操作，不自动改 CAS 重放。

### 4.4 防止跨代混图（A 必须实施的合同）

仅前端 generation token 不能防止同一 current URL 在两个请求之间切代。沿用 `/api/mockups/:id/files/:key` 路由，拟增只读查询 `generation_id=<公开ID>`；服务端验证 ID 属于该单的有效 ready 代后解析该代 key，禁止把查询值拼成路径。未传时继续按 current 解析，兼容旧页面。

同次三图、card/full、ground/set、GLB、灯箱和下载全部绑定同一代 ID。虚拟 legacy ID 只在当前 root 身份未变时可读，过期返回 409 并刷新详情。该查询也不触发 g0 导入。旧代损坏不得静默拿新代某张图补齐，否则会出现产品/阴影/下载混代。

**旧单额外约束**：现有 `virtualLegacyCurrentId()` 只绑定两张 full + GLB，不能独自证明 optional card/ground/set 的代际。A 将虚拟身份升级为 `legacy-current-v2-<sha256>`，摘要覆盖全部存在的 generation output keys、各自 SHA/bytes 及缺项集合；六面读字 `read_*` 不冒充历史成片资源。旧版虚拟 ID 仅作为过期输入返回 409，不继续接受其写入；已有排队请求若因此过期，安全失败且保留原图，不迁写 request 来绕过 CAS。真实 ready ID 不变。

只在单份详情/代绑定读取时建立这个有界快照，不在任务列表逐单扫大文件。服务端读取文件时核对绑定的 key、普通文件身份和 SHA，持有已核对的文件描述符开始流式响应；不在校验后重新按路径打开。原位写入口在 B 全部迁移/禁止；在此之前运行中的旧 relight/换正面不得签发可混用的 root 快照。纯 GET 不复制、不建 g0、不补图。A 的回归必须包含“只替换 ground/card，而 full/GLB 不变”的反例。

继续遵守 ETag 与 `private, no-cache`；`download=1` 才附件、`private, no-store`。下载从当前页面绑定代取 full，不下 card；不新增 PDF 下载。

## 5. 旧入口迁移与回滚

当前 `/api/mockups/:id/relight` 尚未迁移。RF-04 接写动作时将它转换到同一 enqueue，停止原位覆盖。旧客户端没请求号时，只按当前 source + 规范化灯光值复用仍在途 mutation；不能生成随机号导致双击重复，也不能永久吞掉日后用户明确的新请求。

兼容算法放在同一 job lock 内：先验证新鲜身份/权限和 canonical adjustment；若已有 queued/running 且 mode/source/adjustment 全同，重放其既存请求号；不同则 409 busy。无在途记录才分配一个服务端请求号，并与 queued 同次落盘。**这只保证旧客户端在途去重，不保证终态后的无请求号重试恰好一次**。更新后的 UI 必须始终带稳定 `client_request_id`；旧调用端不得在网络不确定或已终态后自动重试。兼容窗口结束是否改为强制请求号见 §11，不能暗自承诺更强幂等。

`/relight` 原响应与 `202` mutation 语义不同，必须同一切片更新前端调用及回归。禁用能力时不得悄悄掉回旧原位重渲。网页 CSS/合成器「调灯」「换背景」继续当场生效，不自动调用旧或新 POST。

回滚可以关闭新写入口，保留当前/历史只读。job.files 与 current pointer 同一次提交的兼容镜像不改；在真实旧代码只读回滚演练通过前不清 root 副本。任何 ready/g0 都不自动删除，orphan 只恢复索引、不自动激活。恢复/释放槽仍以 owned process 的实际退出证据为准。

## 6. 界面方案

沿用同一白底深字打样单。页头增加弱入口「出图版本」打开紧凑列表，每行尽量一行：时间、动作、当前标识、使用按钮；不加四张状态卡或新侧栏台签。普通用户只看操作所需文字，profile/hash/底层阶段不摊开。

- 当前图继续保持三列、grounded 5:6、card→full、下方印刷面读字；历史入口不能挤坏第一屏。
- 新代运行：三图上方一条真实状态，“正在按旧版重新出图 · 当前图片仍可用”。读服务端中文阶段，不编造百分比/ETA，不用 WaitCard 覆盖已完成图。
- 成功：收到新 current 后使旧异步请求失效，清理旧纹理/Bitmap/对象 URL，再按新代加载。所有依赖通过同一代 token 防止旧 full 或 ground 回写。
- 失败：当前图与下载不动，状态条说明“本次未完成，当前图片未变”；无第二层确认框。若进程退出未确认，不提供会绕过围栏的重试按钮。
- 409 stale：保留画面和用户灯光值，提示“当前版本已变化，请查看后再操作”；主动刷新详情，不自动重新提交。
- 权限不足隐藏写动作；执行门未齐则在版本面板给禁用原因，不放一个永远点击失败的主按钮。历史查看仍可用。
- 「使用此版本」改变团队共享的 current，不是个人预览。列表相邻文字说明影响；不做 hover 自动激活、不因翻页切 current。
- 纯页面调灯/背景不生成历史。若明确点重新出图，才把当时有限灯光值快照交给服务器。

窄屏版本列表纵排，按钮 ≥40px、正文默认 16px、辅助 ≥13px；品牌紫 `#805898`。支持键盘、可见焦点和 reduced-motion。不新增设计库或全局状态库。

## 7. 错误与可观测性

| 情况 | 响应/处理 | 不得发生 |
|---|---|---|
| 未登录 / 无写权限 | 401 / 403，现有身份流程 | 仅按显示名提权 |
| 当前代变化 | `render_generation_stale` / 409 | 自动替换 expected-current 后重试 |
| 同单在途或退出未确认 | `render_generation_busy` / 409 | done 主单绕过占用 |
| runtime/平台/模式缺失 | 保留现有 unavailable/unsupported，拟加稳定 reason | 用 unwired 冒充通过、回退原位写 |
| 参数非法 / 同号异内容 | 沿用 jobs 的 400 / 409 | 匹配中文字符串决定行为 |
| 文件/质量验证失败 | 现有失败摘要，当前不变 | ready 后未验证就切 current |
| 幂等满员 | 现有 invalid/409，拟加 `idempotency_capacity` reason | 驱逐记录或偷偷清数据 |
| 历史缺失/损坏 | 只读错误，不能激活 | 借另一代文件拼出“完整历史” |

现有 jobs 的 invalid 有 400/409，不统一改写成 ADR 的建议 422；本切片先冻结具体 HTTP 合同，再实施。日志沿用 problem/cause/fix；公开摘要不带磁盘路径、PID、execution token、source SHA 或原始 worker stderr。UI 消费稳定 code/reason，不能匹配上述中文。

## 8. 实施顺序

A/B/C/D 的唯一交付矩阵见 §10；§3–7 与 §9 是该矩阵引用的详细合同，HTTP 状态以 §9.3 的固定结果为准。

顺序 A→B→C→D；每片先失败测试再实现。B 可用受控 adapter 验证 HTTP 合同，但必须继续显示生产禁用，不能依赖 `setJobsTestHooks` 实现生产注册。A/C 的纯只读与禁用 UI 可不等新版画质，但禁止借此宣称整个 RF-04 已开放。

关键 E2E：旧单首次生成→运行中下载旧代→成功切新代→历史切回无 Blender；第二 tab 用旧 current 提交得 409；响应丢失同号重放；失败保留旧图；card/full/ground 在切代/卸载后不回写；viewer 只读；关闭执行门后历史仍可看。合成 E2E 只证明交互合同，不证明真实 PNG/GLB 画质。

## 9. 工程决策与实现入口

本方案采用：per-action capability、同路由 generation 查询、旧单全资源虚拟身份、保留 16 条有界创建幂等、不扩大 viewer 写权限、upgrade 暂禁用。它们是待实施合同，不是已经修改的产品行为。

剩余前置工作按 [RF-03 收口台账](packaging-quality-rf03-runtime-closeout.md) 逐项关闭；生产注册、Windows 实机验证、基线批准、真实稿 L2/UAT、提交/ship/部署各保留自身授权与证据门。不要为了让 RF-04 按钮变绿而删掉这些门。

实现集中在既有深模块：`renderGenerations.ts` 管历史/身份/文件解析，`jobs.ts` 管 admission、幂等、队列、CAS 和唯一写者，现有 mockup HTTP 路由仅作权限/参数适配，`MockupPage.tsx`/`mockupStudio.ts` 消费绑定代资源。不得另造存储、队列、全局状态库或 HTTP 服务。按目录现有规则补纯函数测试；UI 浏览器测试覆盖异步请求、渲染与下载的代际。

### 9.1 能力判定顺序

| 动作 | 必要条件 | 明确不依赖 |
|---|---|---|
| history | 已登录、团队 read、目标单存在 | Blender、源 PNG 仍可重渲、生产写注册 |
| activate | create + owner/admin、目标 ready 完整、无同单 mutation/未退出 worker、current CAS、审计容量 | 新 Blender 是否在线、当前源面是否仍相同 |
| legacy_relight | create + owner/admin、source=current、RF-02 源/六面新鲜、该 mode 的 runtime/资源/平台/注册门、空闲或可排队、请求账本容量 | 视觉升级、新 profile、RF-08 |
| upgrade | 上述创建条件 + 已实施且允许的新版 mode/profile | 不能用 legacy_relight 的可用性替代；当前固定禁用 |

能力原因按 permission → mutation/ownership → mode/registration/platform → source → capacity 输出一个主原因；POST 不信任 GET 的 allowed。全局 Blender 正忙通常可以 queued，**同单**正在变更或退出未确认才是 busy；不得把二者混为 409。

### 9.2 激活审计与索引一致性

ADR-007 要求 `activated` 事件，但现有 index 只有 ready/recovered。B 补齐，不能把当前版本列表当成完整切换审计：

1. 在提交新 current 的同一次 job.json 原子替换内，写一个有界 `render_last_activation` 待记账事实（事件 ID、旧/新代、动作、时间、操作者内部 ID）。保留的始终只有最后一条，不把历史塞入 job.json。
2. 提交后 jobs 按事件 ID 幂等追加 activated 索引事件；current 事实仍只读 job.json。若追加失败，current 已提交，不能报“未切换”或回滚到旧图；记录 audit pending，并在 boot/下一次写 admission 前补记。
3. 未补齐前不覆盖最后一条待记账事实，不放行下一次切代；GET 不修复、不写入。激活当前代为无副作用 no-op，不追加事件。
4. A/B 同步将索引读取/追加限制为最多 8 MiB；超限只关闭新的写动作，仍保留已能确认的 current 文件读取，不自动截断或删除历史。activation 事件不重复增加历史版本行；分页仍从 ready/recovered 得到版本集合。

### 9.3 HTTP 固定结果

现有认证 401/权限 403 保持现有响应格式。代际接口统一返回 `{code, reason, message}` 的短错误对象；B 为 jobs/store 增加受控 reason，不通过匹配中文反推。正常创建 202；激活 200；历史 200；合法但不存在的单/代 404；非法 schema/字段/游标 400；CAS、同单 busy、同号异 payload、容量或审计 pending 409；未开放 mode/runtime/平台/注册 412。保留现有顶层 `render_generation_invalid` / `render_generation_stale` / `render_generation_busy` / `render_generation_unavailable`，不将所有错误改成 422。

固定 reason 至少包括：`payload_invalid`、`cursor_invalid`、`generation_missing`、`current_changed`、`mutation_busy`、`ownership_unconfirmed`、`request_id_conflict`、`idempotency_capacity`、`history_capacity`、`audit_pending`、`runtime_quality_unwired`、`production_registration_disabled`、`process_containment_unavailable`、`upgrade_unwired`、`source_changed`、`generation_corrupt`。corrupt 对 GET/activate 返回 409，不能偷偷略过目标并换成别代。公开 message 不含路径、PID、token 或原始 stderr。

## 10. A/B/C/D 交付与测试矩阵

| 切片 | 必须交付 | 负向/竞态验收 | 退出条件 |
|---|---|---|---|
| A：只读合同 | 分页历史、四动作 capability、代绑定文件读取、旧单 v2 全资源身份、有界索引 | GET 前后磁盘树相同；viewer/跨单/非法游标；只换 card/ground 旧 ID 409；ready 不完整不混图；列表不扫全图；旧 ID 排队安全失败 | HTTP/store 完整相关测试、类型/质量门；写入口仍不存在或禁用 |
| B：写事务 | 三动作适配、旧 relight 收口、稳定 reason、创建幂等、CAS、activated 待记账/恢复 | 同号同 payload 重放、异 payload 409；第 17 个新号拒绝且旧号仍重放；双 tab 仅一方提交；复制/质量/超时/取消保留旧图；已提交但审计追加失败不假报回滚；unknown worker 不释放槽 | jobs/HTTP 完整回归；普通 local registry 全链；未获授权的生产注册继续 false |
| C：界面 | 单行版本明细、运行状态、会话 request ID、同代 resource map/token、资源清理与 full 下载 | 前一代 full/ground/GLB 晚到不覆盖；card 失败回退同代 full；切代中下载仍按页面代；刷新/离页恢复同请求；409 不自动换 CAS 重投；viewer 无写按钮；键盘/窄屏 | UI 纯函数 + 合成浏览器 E2E；不改白底三列/5:6、灯光/背景既有语义 |
| D：回归/交付 | 只读旧代码回滚演练、完整测试台账、API/操作文档 | 新 store 能读旧 unwired/g0；旧代码对新 `runtime_verified` 可能拒绝 history，但 current `job.files` 镜像必须实测可读/下载；不能原位重渲已管理代；保留所有 root/g0/ready | 本地 L0 结案；原生 Windows、L2、UAT、生产发布分列，不用 mock 代替 |

RF-04 只消费 RF-03 产物门；不改 F、纸材、棚光、几何、采样 profile 或重采样策略。A/B/C/D 完成均不是启用生产按钮的授权。只有独立生产注册/Windows 门具备证据并获授权，才能开放相应写动作；只读能力不受该开放与否牵连。

## 11. 单列的产品取舍（本方案给默认值，不代用户批准）

- **版本切换的影响范围**：建议保持团队共享 current，按现有 owner/admin 管理边界；不是个人预览。若希望任意团队读者也能切换，属于扩权，须另行决定。按现有权限实施 A/禁用态不需要等待该扩权决定。
- **16 条创建容量**：建议本期保留，满员关闭新建但历史查看/合法激活仍可用；不加自动删除或付费扩容。扩大容量或允许清理必须另做数据保留决定。
- **旧无请求号 relight 的兼容窗口**：建议同次部署更新官方 UI，并仅为旧调用保留在途去重；何时彻底拒绝无请求号请求由负责人决定。终态后的旧客户端自动重试不能承诺幂等。
- **升级新版**：建议本期展示明确禁用原因，不隐藏成“已经升级”。何时提供新版 profile 与批准 baseline 属于 RF-05+ 及独立发布/验收，不在 RF-04 写入口实施中顺带开启。

以上选择需要改变默认范围时再集中确认；它们不阻止交付本 PLAN ONLY，也不构成现在实施 RF-04 UI、开放业务、清数据或发布的授权。
