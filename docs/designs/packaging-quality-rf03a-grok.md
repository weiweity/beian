# RF-03A：代际文件存储核心（实施交接）

> 历史实施交接，保留原委派范围与合同。第 05/08 批当前由 Codex 独立 ship，另包含专用原子 JSON 写模块；现行发布授权与验证边界见 `packaging-quality-rf03-acceptance.md` 顶部。本文件不是再次调用 Grok、回到旧工作树或限制后续已授权发布的指令。

用户授权继续本地推进，大量代码交给 Grok，Codex 独立验收。本次只实现存储核心，不代表 RF-03 整体完成。不提交、不推送、不 PR、不部署、不切默认 profile、不运行 Blender、不接触真实任务或生产。

## 范围及职责

继续当前 `codex/3d-rfe02-lighting-evidence` 工作树。所有现存 dirty/untracked 文件是用户已有工作，只读保留。代码白名单仅新增 `apps/web/server/src/renderGenerations.ts`、`apps/web/server/src/renderGenerations.test.ts`；交付记录可新增 `docs/designs/packaging-quality-rf03a-result.md`。不得改本指令、质量基线、依赖清单、jobs/mockup/routes/UI/Python。确实需要扩展白名单时停止并说明，不绕开。

先完整阅读 AGENTS.md、ADR-007 第 15 节、第 16 节与 RF-03/T4 条目，阅读现有 mockup.ts 文件键/文件定位与 tasks.ts replaceFile 约定。CodeGraph 不可用，允许针对性源码读取，不建索引。宿主当前规则：普通实施不运行升级、遥测、自动 checkpoint、多模型流水线或发布；不读取凭据；不 git add -A。

设计比较：直接由存储模块改 job.json 会出现第二写者，拒绝；选择只生成经过校验的 pointer + files patch，由未来 jobs.ts 在同一 job 锁下原子保存。此刀仅建立该边界，不预先声称队列互斥或 HTTP 幂等已完成。

## 实现合同

1. 接受服务端显式传入的可信 job 根（测试用 mkdtemp），不要导入 config.ts 自动触碰 DATA_DIR。小而深的接口，隐藏 `.render-generations`、staging、manifest、index。无服务启动副作用。
2. 根据服务端 mode、合同身份和随机/单调代次生成 ID；拒绝外部路径式 ID。严格验证 manifest schema、字段类型、ID/目录一致、合同 SHA、六面 SHA 和唯一文件 key。输出保持既有 key 与 canonical absolute path 派生镜像；公开摘要不能含内部路径。
3. 旧 root 文件只复制到独立 staging，不移动/删除原文件、不使用可共享写入的 hardlink。检查 root/source/destination 的路径边界、symlink、大小写别名、重复 key/inode，失败关闭。绑定复制完成的字节 hash，不接受调用者自报 hash 作为校验结果。
4. staging 完整检查后才原子 rename 为 ready；manifest 与 ready 输出不得由 API 再覆盖。至少要求两张产品 PNG 和 GLB，绑定六面资产及合同。格式校验不要把八字节 PNG magic 当完整图片验证，也不要把 GLB magic 当六面校验通过。若复用实际深度质量验证需后续接线，设计强制的验证回调及绑定身份的结果合同：无验证器/验证失败不得 ready；报告明确外部验证尚未接线。不要伪造质量绿灯。对 optional ground/set 的失败要明确策略，不静默混入坏文件。
5. 只返回 current_render_generation_id 与 files 的待提交 patch；不保存 job.json，不改变当前展示。激活前重验 ready 的 manifest 和内容，expected current 不同返回 render_generation_stale。明确调用者必须在同 job 锁内重读 current 再准备/提交 patch，单纯比较调用者传入旧值不等于实现 CAS。
6. append-only index 有 ready/recovered 事件，generation manifest 为事实源。扫描恢复 orphan ready：逐代验证，只补索引、不激活、不删 ready。截断末行不得当有效记录，也不能让后续 append 永久不可读；恢复幂等，不重复无限增长。分页有固定默认/最大 limit，不透明 cursor 校验绑定 job/index，非法 cursor 拒绝，不泄漏路径。
7. 写入前磁盘余量 guard；明确容量估算与安全余量。用真实文件系统能力或显式依赖注入测试，不把测试 mock 说成实机余量。不得自动删除历史。失败 staging 可保留诊断，不做跨目录递归清理。
8. fsync 文件/目录的支持与 Windows 限制如实记录。rename 原子可见性不是断电耐久性的完整证明，未跑 Windows/断电不得声称完成。错误至少区分 invalid/stale/disk_guard，日志不含内容或凭据。

## 验收

使用小型完全合成文件。测试正常导入、固化/读取/激活 patch；current/root 全字节不变；新代与旧代隔离；字段/hash/文件/资产/质量校验失败；路径逃逸/symlink/alias；重复固化拒绝；磁盘 guard；复制中、manifest 写后、rename 前、rename 后索引前等失败点；orphan 恢复两次；损坏末行后追加；分页边界及伪造/跨 job cursor。测试不得依赖真实 DATA_DIR、网络、Blender、Illustrator。

运行 focused node:test、全部 server tests、server typecheck、git diff --check。quality 如因未接线的新出口报 unused，报告即可，不扩大基线、不造假调用；后续接线才消除。无需安装任何依赖。

结束提供 STATUS、实际文件列表、测试命令/退出码/计数、已知限制、建议下一刀。明确“只完成 RF-03A 存储核心；尚未接线、未验证完整崩溃恢复/Windows耐久性/生产”。Codex 随后独立验收。不能完成时报告真实失败，禁止自行扩大范围。
