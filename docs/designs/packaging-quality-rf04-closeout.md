# RF-04 本地交付记录

2026-09-14 入口补记：下文是 2026-09-06 RF-04 的历史交付语境。“升级新版尚未接线”在普通产品入口仍成立；`0.28.0.0` 的 Q06.6 A 已在显式临时 runtime 装配固定候选，见 [runtime 收口补记](packaging-quality-rf03-runtime-closeout.md)。HTTP 仍不接收 profile，合法已有代的 history/activate 继续可用；这不开放生产创建或 Windows 主桥，也不改变下文历史测试数字与验收边界。

日期：2026-09-06。当前独立分支：`codex/rf04-render-versions-ship`，基于 RF-03 `3b98552` / `0.21.36.0`，本次版本 `0.21.37.0`。A/B/C/D 已实现；最终候选验证由本次 PR 单列，不以原工作树历史数字替代。生产新代执行仍未开放。

原开发工作树的历史基线为 `e1c2d6794c3ba5cc35da15a41bd738a8692a95b0` / `0.21.35.0`，叠加本地 RF-03 增量。授权来自本轮“开始下一步”，实现范围以 [RF-04 方案 §10](packaging-quality-rf04-plan.md#10-abcd-交付与测试矩阵) 为准。没有改 F、几何、纸材、棚光、视觉 profile 或批准基线；没有注册生产适配器、启动真实客户稿、运行真实 Blender、执行 Windows 验收或部署。此前 RF-03 的真实 Blender 合成证据不计作本轮 RF-04 新实测。

## 交付与操作

| 切片 | 已实现 | 核心保护 |
|---|---|---|
| A | 共享只读历史、逐动作 capability、`generation_id` 绑定文件、旧单全资源 SHA 身份 | GET 不写盘；full/card/ground/set/GLB 不跨代补齐；历史索引最多 8 MiB；已验证文件句柄直接流式响应 |
| B | 202 创建、CAS 激活、16 条持久幂等、activated 待记账及 boot/下次写补记、旧 relight 转同队列 | current 与待记账事实同次原子提交；提交后审计失败不假报回滚；未补记不再切代；禁止旧换正面/补面覆盖托管代 |
| C | 同页“出图版本”、紧凑历史行、真实独立状态、共享切换说明、窄屏与键盘支持 | 生成时保留当前三图；同代卡/全图/地面/GLB/下载；切代卸载旧资源；失败或 409 不自动改 CAS 重投 |
| D | 全量相关单测、合成浏览器、正常临时 registry 路径与旧代码只读回滚演练 | 生产禁用、原生 Windows、真实稿 L2、UAT、正式视觉 baseline 单列 |

在已出图打样单打开“出图版本”查看历史。具有 create 且为本人/admin 的账号可在能力允许时“使用此版本”，这会改变团队共享 current，不是个人预览，也不启动 Blender。普通 viewer/非所有者没有写按钮；运行门未齐显示禁用原因，历史仍能读取。“升级新版”始终显示尚未接线。现有调灯/背景仍为页面合成，不自动生成历史。

明确点击“按旧版重新出图”时，先把请求号、当前代和灯光快照写入会话存储。响应不确定时保留原请求；刷新/换页只恢复和读取，不自动 POST。“确认上次请求”复用同号同内容。409 后保留灯光并读取最新详情，不擅自重新提交。历史激活响应丢失则先读 current：已经是目标就显示已切换，否则留待用户重新操作。

创建账本满 16 条时拒绝新请求号，旧号仍可重放；历史和合法激活不因该账本满员关闭。8 MiB 历史索引满员/损坏则关闭有关写入，仍保留能验证的 current 文件读取；没有自动删历史或截断索引。新增游标使用进程只读密钥派生，GET 不创建 `.cursor-key`；旧持久密钥仍可读取。无持久密钥时服务重启会使旧翻页游标失效，重新打开历史即可，不影响 current。

## 本次审查收口

- 重新出图能力先核对有界计划、六面引用与当前代绑定；源缺失或变化返回 `source_changed`，历史查看与合法激活仍独立可用。GET 不启动验证子进程、不归档或修复数据。
- 创建结果与幂等重放复用统一公开 mutation 脱敏，磁盘原始失败证据保留。
- 已损坏的零字节旧单 optional card/ground/set 仍纳入虚拟身份；坏 key 读取继续失败，完整图仍可用。required 与 ready 校验不放宽，不宣称正常流水线会生成空文件。
- 补充请求体 4096/4097 字节、坏 JSON、存储失败不 POST、历史分页重试及迟到详情不回写的行为回归。

## HTTP 合同

认证沿用既有 401/403。客户端只提交公开 ID 和有限灯光值；不接收内部路径、profile、actor、合同、质量结果。

| 接口 | 请求/结果 |
|---|---|
| `GET /api/mockups/:id` | 增加 current ID、mutation 和 history/activate/legacy_relight/upgrade 四动作 capability；任务列表不扫描全部成片 |
| `GET /api/mockups/:id/render-generations?limit=20&cursor=…` | 分页只读历史，limit 为 1–50；非法游标 400；不导入 g0、不做恢复 |
| `GET /api/mockups/:id/files/:key?generation_id=…` | 只读指定 ready 代或仍有效的 `legacy-current-v2-<sha256>`；`read_*` 不伪装为历史成片；不带代参数兼容旧 current 读取 |
| `POST /api/mockups/:id/render-generations` | `client_request_id`、`mode`、`source_generation_id`、`expected_current_generation_id`、可选 `studio_adjustment`；成功 202 mutation |
| `POST /api/mockups/:id/render-generations/:generation_id/activate` | 仅 `expected_current_generation_id`；成功 200 最新公开详情 |
| `POST /api/mockups/:id/relight` | 旧端兼容转同一 enqueue，成功也为 202；仅在途同 source/灯光去重，终态后无请求号重试不保证恰好一次；不会回退旧原位覆盖 |

代际错误固定 `{code, reason, message}`：非法入参 400；缺失 404；CAS/busy/幂等冲突/容量/审计 pending/corrupt 为 409；未开放 runtime/平台/mode 为 412。未预期内部异常为 500，公开消息不泄露路径、PID、token 或原始 stderr。具体 reason 沿用方案 §9.3。

预览使用 SHA ETag 与 `private, no-cache`，匹配时 304；`download=1` 是附件、`private, no-store`，不能返回空 304 下载。已开始的下载绑定点击时那一代 full；不把 card 当原图。旧换正面和补面在新代 queued/running/退出未确认时拒绝；补面在途也阻止同单创建。托管后不允许这些旧入口原位写回。

## 本次独立分支验证

在本次候选源码上重新执行：服务端 **727 PASS、1 SKIP**，UI **342 PASS**，Python **976 PASS、7 SKIP、4 DESELECTED**；四项 deselect 均为真实客户稿测试。`npm run typecheck`（含 UI build）、`npm run test:quality`（47 PASS）、`npm run quality`（59 个既有 baseline）通过。

构建产物模式的 Chromium 回归 **25 PASS**：出图版本 8、旧打样单 16、灯箱 1。无监听端口、真实 API、客户稿或原生 Blender/Illustrator 调用。独立审查和 MiniMax 复核后的确认问题已修正；当前覆盖审计为 35/40 组路径（87.5%，非行覆盖率），余下 capability 全矩阵、审计坏事实、元数据竞态、资源回收与跨单导航组合仍未全覆盖。

## 原开发工作树验证（历史）

以下均为原开发工作树记录，不是本次独立分支重跑结果。TS fixtures/浏览器图像及受控子进程都是 synthetic，不证明包装画质、真实 PDF 清晰度、Windows 或业务验收。

| 验证 | 结果/范围 |
|---|---|
| 服务端 `npm run test -w beian-server` | 720 项：719 PASS、0 FAIL、1 SKIP；跳过的是非 Windows 上的 Windows 主桥拒绝测试，不报作实机通过 |
| UI `npm run test -w beian-ui` | 342 PASS、0 FAIL；含 card 415 回退、切代/卸载晚到响应、原图下载与请求恢复纯函数 |
| 服务端、UI、E2E TypeScript | PASS；浏览器套件 beforeAll 实际执行 UI `npm run build`，构建在临时目录 |
| `npm run quality` | PASS，59 个既有 baseline findings（knip 57、vulture 2）；没有新增质量门豁免 |
| `npm run quality:deep` | 仅 report-only，261 findings；此命令 exit 0 不表示零问题，也不替代上述 quality gate |
| 新版本 E2E + 旧打样单 + 旧灯箱 | Chromium 22 PASS（版本 5、旧打样单 16、灯箱 1）；首次生成、在途旧代下载、晚到 full/ground/GLB、历史切回、失败留图、丢响应同号重放、双 tab CAS、viewer/窄屏键盘和关闭执行门；旧单调灯通过实际 canvas 像素变化验证 |
| 正常 registry HTTP 全链 | `renderGenerationHttp.test.ts` 无 jobs hook：临时 canonical 数据根注册→受控 owned child→候选封存→current/history/file→切回。使用 synthetic CJS 协议子进程，不是 Python/Blender 画质测试 |
| 只读旧代码回滚 | 从基线 `git show` 读取实际旧 store 和旧 fileOf 依赖闭包；旧 store 可读 unwired/g0、拒绝新 runtime_verified；旧 fileOf 按新 `job.files` 镜像读取/流式下载白底、GLB、卡图；前后磁盘树不变 |

回滚演练只证明旧存储/文件读取闭包与兼容镜像，不等于完整旧服务器部署或 Windows 回滚。root、g0、ready 均保留，不对测试成功推导删除授权。

浏览器全部使用构建产物及网络拦截，无监听测试端口、无 Hono/真实 API 访问。5173 已由其他项目占用，未停止或复用该进程。旧打样单的 4 条断言仍读取 `<img>`/CSS 滤镜，与基线已经存在的 `LegacyLitCanvas` 不符；本轮对照基线后更新为可见 canvas、实际亮度变化及三栏断言，没有改动现有合成效果。代绑定文件还覆盖 HEAD 空响应、取消下载后再次读取与 ETag/附件行为；HEAD 在建流前释放验证句柄。取消测试先复现了 `autoClose:false` 配合手工 error/end 关闭导致的 EBADF，现由流在挂起读取结束后通过唯一 close 回调释放已验证句柄，取消回归通过。

## 未完成与下一阶段边界

- 原生 Windows Job Object、COM→JSX、真实稿 L2、人工 UAT、断电持久性及生产发布仍未通过本轮验收。
- 生产新代注册继续关闭；不能为了点亮按钮绕过 RF-03 平台门。正式批准 baseline 与 `upgrade`/RF-05+ 视觉改造不属于本轮。
- 原工作树的未提交内容完整保留；本次独立分支仅交 RF-04 及审查修复。提交与 PR 不代表合并、部署或业务开放。
- 下一实现阶段需按已批准路线单独推进 RF-05+；本次 `/ship` 仅包含已授权的提交、推送和 PR，不包含生产启用或实际画质验收。
