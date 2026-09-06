# RF-03 独立验收台账

## 第 05/08 批发布边界（2026-09-06）

本批按后续授权独立 ship：代际存储核心及 `mockupAtomicWrite.ts` 专用原子写模块，不接 jobs/HTTP/UI、不改变当前展示。下文 Grok 委派、返修计数、源码哈希及“未授权发布”均为历史记录，不作为本轮测试或当前授权证据；本轮由 Codex 执行，不重启历史委派。

专用原子写只接受受信词法根内的 `job.json`，校验祖先/目标并同目录独占临时文件、fsync、rename；rename 失败保持旧文件，不用 copy/unlink 覆盖兜底。当前无生产调用，不等于 pointer CAS 或 Windows 断电耐久性通过。代际存储本身仍不写 `job.json`。

本轮保留质量基线，提前导出但无当前外部消费者的常量/类型收为模块内部；第 08 批真实调用需要的类型届时才导出。PNG 检查仍是容器/头字段/CRC 边界，不是像素解码、六面语义或画质门；外部质量验证仍 `unwired`。真实 Blender、Windows 存储耐久性和真实稿 L2 不在本轮通过声明内。

PNG 容器修正按 [W3C PNG 第三版](https://www.w3.org/TR/png-3/#11IHDR)：接受灰度类型 0 与总数据非空的连续 IDAT（允许其中有零长分片）；验证色型/位深组合、编码方法、调色板和关键块顺序，不执行图像数据解压。合法灰度误拒及多项非法头/顺序误收均有本轮红绿回归。

本轮独立审查还复现 `verifier: ""` 先落 ready/index 再失败并卡住 g0 重试；现用相同 `parseManifest` 在写清单前完整校验。回归确认失败无 ready/index，纠正回调可成功重试。专项 35→55（新增 20）；全量 server 518、UI 339、Python 817 passed / 5 skipped，typecheck/UI build 及质量 47 tests 通过，质量基线仍为 59 条。测试有既有临时目录 exit listener、localStorage 与 SWIG 警告，未隐藏或改基线。独立计划审计 17 DONE / 1 CHANGED，无剩余 PARTIAL；行为覆盖 27/30（90%，非行覆盖），Windows 耐久性与实际崩溃演练仍缺证。

## 本次授权和拆分

用户授权本地实施，大量代码由 Grok 编写、Codex 验收。沿用独立分支；不提交/推送/PR/部署、不切默认 F，不操作真实任务。

RF-03A 先交存储核心（指令见 `packaging-quality-rf03a-grok.md`），后续才接 jobs.ts 单写者、路由权限/队列和当前代读取。核心单测不能替代整链路验收。

## 委派前事实

- 当前服务端全量测试：463 passed，退出码 0。
- `collectOutputs()` 跳过隐藏目录，因此 generation 产物不能靠旧扫描自动上架；必须有明确 current + files 提交。
- `fileOf()` 对产品文件沿用已列出的绝对路径；读字面仍查共享 assets。历史图片可查看与历史源资产可以继续重渲是不同条件。
- `saveMockup()` 调用 `tasks.ts replaceFile()`。后者 rename 失败的 Windows 回退使用 copyFileSync 覆盖目标，不能证明旧/新 job.json 原子可见性。这是 RF-03 后续 pointer 接线必须解决和测试的缺口；当前不改全局任务存储函数，避免影响审稿作业。

## Codex 必做检查（未执行项不打勾）

- [x] 与白名单比较实际差异，确认既有 F/UI/Python 工作未被修改。
- [x] 独立运行新测试、服务端全量、typecheck 和 diff 检查。
- [x] 自己构造至少一个 manifest 篡改和一个 rename 后孤儿场景，不只复用实现者的 happy path。
- [x] 校验缺必需输出、无质量验证器、错 hash 都不能固化；回调验证不被写成实际 PNG/六面质量验收。
- [x] 检查 ready 不可改写、旧 root 不变、没有自动删除历史、失败不生成当前指针写入。
- [x] 检查 index 损坏尾行后的追加与两轮恢复幂等；分页跨 job/cursor 篡改失败。
- [x] 核对路径边界、symlink/hardlink/大小写别名，以及磁盘余量估算不是常量假通过。
- [x] 将存储核心、队列/HTTP 接线、Windows 原子性/耐久性、真实稿验收分别报告。

## 首轮独立验收：未通过

Grok run `run-mto3a58f-zmwjlv`，exit 0，自报 DONE_WITH_CONCERNS。Codex 复跑 server tests：478 passed；server typecheck 和 diff 检查通过。独立复现脚本 `/tmp/rf03a-independent-probe.ts`（只用临时合成文件），确认清单 hash 篡改被拒绝、rename 后 orphan 两轮恢复幂等，但发现两项阻断：

1. **P1：读历史错误依赖当前六面资产。** `loadVerifiedManifest()` 调 `readFaces()` 并比较当前 assets hash，因此改写共享 panel_front 后，`listHistory()` 返回空，`publicSummary()` 报 `face_hash_front`。ADR 明确贴图变化后旧代仍可查看，只禁止用旧源继续重渲。必须分开历史输出完整性与重渲源新鲜度校验。
2. **P1：拒绝 symlink 前发生越界写入。** 在合成 job 下将 `.render-generations` 指向独立临时外部目录，调用导入最终报 `path_escape`，但外部目录已经出现 `.staging-g0-legacy-original-*`。原因是递归 mkdir 在目标祖先验证之前执行。必须在任何 mkdir/index/cursor 写入前验证目标及祖先，不仅在复制文件前校验。

两项都需回归覆盖。没有修实现、没有重启 Grok、没有接队列或产品路由。RF-03A 不通过，等待返修决定；不进入 RF-03B。Windows 原子 pointer 写入仍为后续独立门。

## RF-03A.1 已授权返修目标

用户已授权两项逐一闭环，由 Grok 返修，Codex 复验。原“等待返修决定”为历史状态。

| 编号 | 实现要求 | Grok 回归要求 | Codex 独立验收 | 当前 |
|---|---|---|---|---|
| P1-1 | 历史输出验证不依赖当前 assets；重渲源单独检查六面新鲜度 | 修改/缺失共享面后历史列表、摘要、激活仍可用；旧源重渲明确拒绝；篡改 ready 输出仍拒绝 | 复跑独立探针并补“源缺失 vs 输出损坏”对照 | 独立验收通过 |
| P1-2 | 所有写入前检查目录祖先和目标，拒绝符号链接逃逸 | genDir、staging、outputs、index、cursor 相关链接/别名失败且外部目录树与字节不变；普通物理路径成功 | 在独立临时外部目录设置哨兵，检查失败前后完整快照 | A.2 独立验收通过 |

返修白名单沿用 `renderGenerations.ts`、`renderGenerations.test.ts`、`packaging-quality-rf03a-result.md`。本台账由 Codex 更新，Grok 只读。不重写模块、不改产品接线。Grok 需对两项分别报告测试证据，再跑 focused、server 全量和 typecheck。参考只读独立复现 `/tmp/rf03a-independent-probe.ts`，不得篡改探针来获得通过。修复同范围新问题已获授权；发布及生产不属于本目标。

## RF-03A.1 独立复验与 RF-03A.2 返修

run `run-mto4nmiw-3u124h` 已结束。Codex 复跑 server 480 passed、typecheck/diff 通过。375 个文件哈希与返修开始快照比较，仅三项白名单文件变化，无文件删除。

- P1-1：独立脚本确认共享 assets 改变和整个 assets 缺失时，历史列表和激活 patch 仍成功。代码将新代固化前的新鲜度检查独立为 assertRerenderSourceFresh；原 ready 内容校验保留。
- P1-2：genDir/index/cursor 探针通过，外部树不变。但**清单写入仍漏校验**：预置 `.staging-g0-legacy-original-11111111/generation.json` 为外部哨兵的 symlink，注入固定 randomBytes 后导入，最终虽失败，外部哨兵已经被 JSON 覆盖。独立探针 `/tmp/rf03a-independent-acceptance.ts` 输出 `manifestRejected:true, externalUnchanged:false`。当前 writeFileSync(manifestPath) 没有目标预检，也复用了现存 staging。

RF-03A.2 在原白名单内继续修复：拒绝复用既存 staging（含普通目录、dangling symlink、hardlink 清单）；清单创建采用校验后独占新建，不能覆盖任何既存目标。逐一审计 copy/manifest/index/cursor/fsync/rename 的路径前置校验；index/cursor 如 hardlink 指向外部文件也不能通过追加/覆盖改变外部内容。增加对应“目录树及字节完全不变”的回归，不只断言 throws。保留 P1-1 全部测试。只读独立探针禁止修改；不扩大产品接线。完成后 Codex 再独立复验，不用 480 绿灯掩盖缺口。

## RF-03A.2 最终独立验收：本目标通过

Grok 实现 run `run-mto5b8e0-g4e81d`；Codex 独立复跑并审查，不以 Grok 自报作为通过依据。

最终源码 SHA-256：

- renderGenerations.ts：`81b5c7344157d5f7fd82d3fa45803b68fd02d44ee03f799b63bfae6322bfda58`
- renderGenerations.test.ts：`fb392d805958a30136d56b6a276206ece3744fdb85f562c5b13f9c20c81cf9a8`

验证结果：

- 专项 18 passed（`/tmp/rf03a2-focused.log`）；server 全量 481 passed（`/tmp/rf03a2-server-tests.log`）；server typecheck、git diff --check 退出码 0。
- 原独立探针 `/tmp/rf03a-independent-probe.ts`：manifest hash 篡改拒绝、共享面改变仍可读、两轮 orphan 恢复幂等、genDir symlink 拒绝且外部目录为空。
- 扩展探针 `/tmp/rf03a-independent-acceptance.ts`：共享面改变/整个 assets 缺失时，列表与激活 patch 成功；两者旧源重渲均拒绝且任务目录快照不变；ready 输出损坏时历史摘要与重渲均拒绝。此扩展由 Codex 编写，Grok 未修改。
- 外部哨兵：genDir/index/cursor symlink、既存 staging 内 manifest symlink、manifest/index/cursor hardlink 全部失败，外部完整目录树与字节不变。Grok 专项另覆盖 dangling staging 和普通 staging 复用拒绝，以及实际分页触发 cursor 与 orphan 触发 index 写入路径。
- 实现检查：staging/outputs 独占创建；manifest/cursor 使用 O_EXCL 新建及可用的 O_NOFOLLOW；index 追加前检查祖先、普通文件和 nlink，打开后 fstat 再验；存储模块不写 job.json、不删 ready。属于静态预置链接和受控失败点验证，不宣称抵御具有同机任意写权限攻击者的所有并发文件系统竞态。
- 375 文件哈希快照核对：两轮 Grok 仅改变三项白名单；Codex 自行更新本台账，其余已有 F/UI/Python 内容未变化，无删除。
- 扩展探针大量临时目录触发 testTemp 的 exit listener 数量警告；所有断言通过，临时目录由测试自身退出清理。不是产品运行内存结论。

关闭的是“RF-03A 两个 P1 返修及独立验收”目标，不是整个 RF-03。仍未接 jobs/HTTP/UI、未实现真正 pointer CAS/Windows 原子替换、未验证 Windows/断电/真实稿，quality 仍 unwired；未提交/推送/PR/部署、未切默认 F、未运行 Blender。quality 的未接线出口问题保持显式后续项，不改基线假装 ship 通过。
