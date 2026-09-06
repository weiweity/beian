# RF-03C1 Codex 独立验收

## 第 06 批发布切片（2026-09-06）

本文件下文保存 2026-09-05 的 C1/C1.1/C1.2 历史验收，不是本批测试或发布凭证。本批仅交付 Python 隔离候选模块、现有 pipeline 的必要复用接口与回归测试；第 02 批合同和 profile 依赖由 main 继承，不重复提交。

当前 CLI 支持请求文件或 stdin，读取上限 64 KiB；运行时进程超时、Node 桥、jobs 接线和实际质量门仍属于后续批次。`upgrade` 明确拒绝，`quality.status=unwired`、`production_ready=false` 保持。未执行真实 Blender、Windows 路径验收或真实稿 L2，不开放打样业务。下文“未提交/不 ship”仅描述历史阶段，不覆盖本批另行授权的 PR/合并发布流程。

本批独立审查复现并修复了最后一次源哈希校验与 Blender 读取之间的竞态：候选现会独占复制六面到私有 `candidate/assets`，复制流与落盘副本均核对期望哈希，再由同一 RF-02 合同验证候选资产根。执行快照不再引用可变源贴图；源在启动瞬间变化也不会改变本次候选字节。候选与资产目录以 `0700` 创建，普通副本而非硬链接；Windows 实际权限与路径保证仍须单独验证。复制失败仅留下本次私有候选，不写 ready/current、不改源或历史成片。

本批完整 `npm test` 实测退出 0：server 518、UI 339、Python 879 passed / 5 skipped（Python 283.48 s）。候选专项从 34 增至 61 项，新增 27 项，最终 61 passed；启动时源变更回归实际 RED → GREEN。类型检查、UI build、quality tests 47 项与 quality 59 条既有基线通过。初次全量因新工作树 UI 构建尚未完成而触发既有 SPA 503，构建完成后完整重跑通过；未修改产品代码或断言来掩盖该失败。以上是本轮合成/本地验证，不是历史 193/529 或真实 Blender/L2。

## 当前结论：C1 本地合同切片通过（2026-09-05）

Codex 已完成 C1.2 接手修复与独立复验。跨单 ready 祖先保护、必需产物基础解码及已验证 nonce 回传均已闭环。本结论仅覆盖 Python 隔离候选底座，不代表 RF-03、真实画质或生产验收完成。

| 本轮最终验证 | 结果 | 证据 |
|---|---|---|
| generation + pipeline_v2 + render_contract pytest | 193 passed，退出 0，107.77 s | `/tmp/rf03c12-codex-final-pytest.log` |
| 另跑 ready / nonce 边界 pytest | 9 passed、22 deselected，退出 0 | `/tmp/rf03c12-codex-boundary.log`；是上述测试的子集，不累计计数 |
| 服务端回归 | 529 passed，退出 0 | `/tmp/rf03c12-codex-server.log` |
| 服务端 typecheck | 退出 0 | `npm run typecheck -w beian-server` |
| 独立正反探针、旧谓词回归反证 | 退出 0 | 下文两个独立脚本；受控 subprocess，不运行 Blender |

Python 有 5 项 SWIG DeprecationWarning，没有测试失败。当前工作树保留所有既有未提交内容；未 commit/push/PR/merge/deploy。Grok 已取消、心跳保持暂停，本轮不再委派。

**后续仍未完成：** C2 Node 异步桥与进程预算、实际质量门、真实 Blender smoke、Windows/真实稿验证及 RF-04 页面。`quality.status=unwired`、`production_ready=false` 保持不变；不写 ready/current，不切默认 F。以下首轮和 C1.1 的未通过结论是历史记录，已由本节的限定验收结论替代。

## Codex 接手 C1.2（2026-09-05）

用户要求不再调用 Grok，改由 Codex 直接收尾。`run-mtoeucnx-uxaoes` 已取消，运行记录为 cancelled、pid/agentPid 为空，原进程已退出；不是 Grok 完成报告。心跳已暂停，禁止自动重新委派。

接手时 `_candidate_touches_ready` 已修改为检查候选的全部词法/真实祖先，不再以 source job 范围限制 ready 标记。Codex 复现确认跨单拦截生效，保留该改动并补四个参数化回归：跨单直接/多层后代拒绝、正常外部/单内候选成功。拒绝断言覆盖其它单的文件字节与完整目录名单不变。

Grok 取消前遗留一个正常候选测试未创建父目录；首轮测试 1 failed/192 passed，根因是夹具不满足现有非递归独占创建合同。Codex 仅补父目录，不放宽产品保护；针对性重跑 5 passed。最终相关全量重跑另列，不以该失败轮充当通过。

`/tmp/rf03c12-regression-red-check.py` 在内存恢复旧的源范围谓词后，新跨单回归报 DID NOT RAISE，证明能抓住原漏洞；不修改产品源码。`/tmp/rf03c11-independent-acceptance.py` 当前合法出图/nonce匹配/源不变、非法GLB拒绝、源单和跨单ready后代拒绝均通过。

既有文件相对 `rf03c1_before_hashes` 只有 pipeline.py 与 test_packaging_pipeline_v2.py 变化，均在 C1 白名单；RF03B TS、UI、registry 原字节保留。当前服务端回归 529 passed、typecheck/diff通过；本轮未新增产品路由、真实渲染或生产操作。

## C1.1 复验及 C1.2 跨单 ready 缺口

独立188 pytest通过（`/tmp/rf03c11-independent-pytest.log`，退出0、5项既有SWIG警告）；529 server（`/tmp/rf03c11-server.log`）、typecheck/diff通过。旧首轮会话56968早已完成181 passed，不需重复poll。

独立 `/tmp/rf03c11-independent-acceptance.py` 正例 rendered/nonce匹配/源不变，9字节坏GLB拒绝，源单ready后代拒绝且名单/字节不变，均通过。但扩展另一单的 `another-job/.render-generations/g1-ready/generation.json` 祖先用例仍输出 `OTHER_READY_DESCENDANT_ACCEPTED prepared`。已派C1.2修候选任意祖先已有ready标记都拒绝（不能限定属于source job）；沿候选路径有界查，不遍历全数据根。C1尚未整体通过。

相对 `rf03c1_before_hashes` 已有文件变化仅 pipeline.py 和 test_packaging_pipeline_v2.py，均在白名单，RF03B TS保持原字节。

## 首轮：未通过（2026-09-05）

Grok run-mtoconcv-vctxiq completed / DONE_WITH_CONCERNS，不等于验收通过。

独立 `/tmp/rf03c1-independent-probe.py` 使用真实 RF-02 合成源和受控 subprocess，输出：

- `INVALID_GLB_ACCEPTED True rendered 9`：GLB 被替换为 not-a-glb，仍返回 ok/rendered 并列入必需输出证据。quality unwired 不免除基本可解码检查。
- `READY_DESCENDANT_PREPARED prepared`：源 `.render-generations/g1-existing-ready/generation.json` 已存在，在其下创建 `.candidate-in-ready` 被放行。只检查候选末段 g 前缀不足以保护 ready 后代。
- `NONCE_EVIDENCE None`：run_blender_job 内部确有 nonce 校验，但外层结果丢失已验证的 nonce，不能绑定后续执行证据。

探针初次因合成 fixture 父目录未创建失败；补齐独立脚本夹具后上述结果退出 0。未操作真实 Blender/进程/任务。

已启动独立 181 项相关 pytest（会话 56968），尚未取得最终退出；不能以 Grok 自报 181 替代。

返修限定原白名单：完整拒绝 ready 目录或其任意后代作为候选；必需 GLB/PNG/card 基础结构可解码，坏 optional 拒绝交付且 warning；传回已验证执行 nonce，不改变质量 unwired/production_ready=false。不扩真实 quality 门或产品接线。
