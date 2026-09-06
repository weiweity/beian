# RF-03A 存储核心交付记录

> 下文为 RF-03A.2 历史交付，不是第 05/08 批本轮执行结果。历史测试计数、工具缺失和未发布状态保留原义；当前 ship 范围、专用原子写及质量基线处理见 `packaging-quality-rf03-acceptance.md` 顶部。当前代码仍未接 jobs/HTTP/UI，质量仍 unwired；模块内部类型收口不删除功能，后续真实消费者可再公开所需类型。

STATUS: **DONE_WITH_CONCERNS**

只完成 RF-03A 存储核心 + RF-03A.1 / RF-03A.2 已授权返修（P1-1 保持；P1-2 补独占 staging/清单与 hardlink 外部写入）。尚未接线、未验证完整崩溃恢复 / Windows 耐久性 / 生产。不提交、不推送、不 PR、不部署。本记录不代替只读台账 `packaging-quality-rf03-acceptance.md`。

## RF-03A.2 返修

Codex 复验 P1-1 独立通过。P1-2 仍漏清单写入：预置 `.staging-g0-legacy-original-11111111/generation.json` 为外部哨兵 symlink，注入固定 `randomBytes` 后 `writeFileSync` 跟随链接覆盖外部字节，之后才 `path_escape`/`symlink` 失败。独立探针当时为 `manifestRejected:true, externalUnchanged:false`。

同范围修复：拒绝复用既存 staging（普通目录 / dangling symlink / hardlink 清单）；清单/cursor 在路径校验后 `O_CREAT|O_EXCL` 独占新建；index/cursor 若 `nlink !== 1` 禁止追加/覆盖。未改只读台账，未改 `/tmp/rf03a-independent*.ts`。

### 写入点审计

| 写入 | 前置校验 | 失败语义 |
|---|---|---|
| `ensurePhysicalDir(genDir)` | 祖先与目标 `lstat`，拒绝 symlink；只复用已存在的普通目录 | `symlink_dir` / `not_dir` |
| staging / outputs `mkdirExclusive` | 目标必须不存在（含普通目录、symlink、dangling） | `staging_exists` / `staging_outputs_exists` |
| 复制 `copyFileExclusive` | 目标缺席 + `COPYFILE_EXCL`；结果必须普通文件且 `nlink===1`，inode 异于源 | `dest_exists` / `hardlink` |
| 清单 `writeFileExclusive` | 校验后 `O_EXCL` 新建，禁止覆盖任何既存目标 | `manifest_exists` |
| index `appendFileExclusive` | 缺则独占新建；已存在须普通文件 `nlink===1`，`O_NOFOLLOW` + `fstat` 再追加 | `hardlink` / `symlink` |
| cursor `writeFileExclusive` / 读取 | 缺则独占新建；已存在须 `nlink===1`，禁止 hardlink 外部写入 | `cursor_exists` / `hardlink` |
| `fsyncFile` | `lstat` 普通文件且 `nlink===1`，`O_NOFOLLOW` 打开后再 `fstat` | `fsync_target` / `hardlink` |
| `renameSync` ready | 目标目录 `lstat` 必须缺席 | `duplicate_ready` |
| `recoverOrphans` | 清单校验失败才记 skipped；index 写入错误向外抛，不再吞成 skipped | 与 append 相同 |

### P1-2 回归（RF-03A.2 增补）

保留 RF-03A.1 的 genDir/index/cursor symlink 树/字节不变测试。新增 `refuses reused staging and exclusive-create writes so the outside tree and bytes stay frozen`：

- 预置 staging + `generation.json` → 外部哨兵 symlink，注入 `Buffer.alloc(n, 0x11)`：导入失败；外部树（含 symlink 目标）与字节全等；哨兵仍为 `UNCHANGED`；staging 内链接未替换；无 ready、无 `job.json`。
- staging 为指向外部缺失目录的 dangling symlink：失败且外部不出现该目录。
- 既存普通 staging（含 marker）：拒绝复用；marker 不变；未写入 `generation.json`；随后不注入 randomBytes 的导入成功，旧 staging 仍不动。
- 预置 staging 内 `generation.json` hardlink 到外部哨兵：失败，外部字节与 `nlink` 不变。
- rename 后孤儿 + `index.jsonl` hardlink 到外部：`recoverOrphans` / `upgrade` 失败，外部 index 字节不变。
- 两代之后 `.cursor-key` hardlink 到外部：`listHistory({limit:1})` 失败，外部 cursor 字节不变。

只读复跑 `/tmp/rf03a-independent-acceptance.ts`（未改探针）：`manifest-symlink` 现为 `manifestRejected:true, externalUnchanged:true`。P1-1 历史 changed/missing 仍 `visible:true, activates:true`。原探针 `HISTORY_AFTER_ASSET_CHANGE` 仍返回 g0；`OUTSIDE_AFTER_REJECT=[]`。

## RF-03A.1 返修

按验收台账最新目标映射逐项闭环。未改只读台账，未改 `/tmp/rf03a-independent-probe.ts`。

### P1-1 历史输出与重渲源新鲜度分开

**实现：** `loadVerifiedManifest()` 只核 ready 目录内输出、清单字段和清单内记录的六面 SHA（用于内容指纹）。不再把当前共享 `assets/panel_*.png` 当作历史有效性条件。`legacy_relight` / `upgrade` 在任何 staging 写入前走 `assertRerenderSourceFresh()`：当前六面缺失或与源代绑定 SHA 不一致则拒绝，cause 为 `rerender_source_missing` / `rerender_source_unfresh_<face>`。篡改 ready 输出仍走 `hash_mismatch_*`。

**回归：** `keeps history, summary and activation after shared faces change or vanish, but rejects stale-source rerender`

- 改写 `panel_front` 后：`listHistory` 仍 1 条、`publicSummary` 可用、`prepareActivationPatch`（observed=g0 与 virtual）可用；`upgrade` 拒绝且 ready 目录仍只有 g0。
- 删除 `panel_front` 后：同上（源缺失对照）。
- 恢复六面后篡改 ready `white_a`：`publicSummary` / `prepareActivationPatch` 拒绝，`listHistory` 跳过该代；`upgrade` 仍拒绝（输出损坏对照）。

### P1-2 任何 mkdir/index/cursor 写入前拒绝 symlink 越界

**实现：** 不再对 `.render-generations` 做 recursive mkdir。按词法分量 `lstat` 祖先与目标：已存在的分量若是 symlink 立即失败。`ensurePhysicalDir` 只在确认当前分量为普通目录后逐级创建。`readIndexFile` 先 `lstat` 父目录；`ensureCursorKey` / `appendIndex` / `sealGeneration` 在写入前检查 genDir、index、cursor。

**回归：** `rejects genDir/index/cursor/staging symlink escape before any write and leaves the outside tree unchanged`

- 将 `.render-generations` 链到含 SENTINEL / nested / 伪 g0 的独立外部目录：`importG0` / `recoverOrphans` / `listHistory` / `publicSummary` 均 `render_generation_invalid`；外部树与字节与调用前快照全等；外部 `readdir` 无 `.staging-*`；job 侧仍是 symlink，无 `job.json`。
- 去掉 symlink 后普通物理路径导入成功。
- 导入后把 `index.jsonl` 换成指向外部的 symlink：列表与 upgrade 失败，外部快照不变。
- 恢复 index 并成功 upgrade 后，把 `.cursor-key` 换成指向外部的 symlink：`listHistory({limit:1})` 失败，外部快照不变。

只读复跑原探针（未改探针）：`HISTORY_AFTER_ASSET_CHANGE` 返回 g0；`SUMMARY_OK`；orphan 两轮幂等；`SYMLINK_ERROR=symlink_dir`；`OUTSIDE_AFTER_REJECT=[]`。

## 做了什么

在当前 `codex/3d-rfe02-lighting-evidence` 工作树新增代际文件存储模块。调用者传入可信 job 根（测试用 mkdtemp），模块隐藏 `.render-generations`、staging、manifest、index、cursor key。

设计选择维持交接指令：存储层不写 `job.json`，只返回 `current_render_generation_id` + `files` 的待提交 patch。比较调用者传入的 expected/observed 不是 CAS；调用者必须在同一 job 锁内重读 current 再准备/提交。

质量验证是强制回调。无验证器或验证失败不得 ready。本切片不接线深度质量评测，`quality_status` 只允许 `unwired`（ready）或在验证失败时拒绝；不写 `pass`。

## 实际文件

新增（白名单内）：

- `apps/web/server/src/renderGenerations.ts`
- `apps/web/server/src/renderGenerations.test.ts`
- `docs/designs/packaging-quality-rf03a-result.md`（本记录）

未改：指令原文、只读验收台账、独立探针、质量基线、依赖清单、jobs / mockup / routes / UI / Python、默认 profile、VERSION。现有 dirty / untracked 文件只读保留。

## 测试

命令与结果（RF-03A.2 返修后）：

| 命令 | 退出码 | 计数 |
|---|---|---|
| `cd apps/web/server && npx tsx --test src/renderGenerations.test.ts` | 0 | 18 pass / 0 fail |
| `cd apps/web/server && npm test` | 0 | 481 pass / 0 fail（含上述 18） |
| `cd apps/web/server && npx tsc --noEmit` | 0 | 通过 |
| `git diff --check`（白名单；文件仍为 untracked） | 0 | 无行尾空白 |

测试用小型合成 PNG/GLB，不依赖真实 `DATA_DIR`、网络、Blender、Illustrator。覆盖：导入与固化/读取/激活 patch；root 可见文件全字节不变；新代与旧代隔离；字段/hash/文件/资产/质量失败；路径逃逸/symlink/inode 别名；重复固化；注入磁盘 guard；复制中、manifest 写后、rename 前、rename 后索引前 failpoint；orphan 恢复两次；截断末行后追加；分页与伪造/跨 job cursor；共享面修改/缺失后历史仍可读但旧源重渲拒绝；ready 输出损坏仍拒绝；genDir/index/cursor symlink 在写入前失败且外部树不变；拒绝复用既存 staging；清单/index/cursor 独占新建或 `nlink===1`，外部树与字节完全不变。

## 已知限制（不是完成）

- **未接线。** `jobs.ts` / `mockup.ts` / HTTP / UI 都未调用本模块。返回的 patch 不会自己变成当前展示。
- **不是 CAS。** expected/observed 只做调用者声明核对。队列互斥、`render_generation_busy`、HTTP 幂等留给后续接线。
- **质量未接线。** 报告固定 `quality_wired: false`、`外部质量验证尚未接线`。合成 PNG 走 IHDR/IDAT/IEND/CRC，GLB 走 2.0 头与 JSON/BIN chunk；这不是六面语义/几何验证，也不是 RF-10 质量门。
- **可选 ground/set：** 缺则省略；在场但格式坏则记入 `optional_omitted` 且不进入 ready。不静默混入坏文件。
- **磁盘 guard：** 估算 = 源字节 + 256KiB；要求 = 估算×2 + 64MiB。测试注入标明 `source=injected`，成功路径标明 `source=statfs`。两者都不是杭州生产盘余量。
- **fsync：** 已对复制文件、manifest、index 做文件 fsync；目录 fsync 尽力而为，Windows 可能 `unsupported`。rename 原子可见性 ≠ 断电耐久性。未跑 Windows，未做断电取证。
- **恢复：** orphan ready 只补 `recovered` 索引，不激活、不删除。失败 staging 可留作诊断，不做跨目录递归清理。未做真实进程崩溃/整机断电演练。
- **quality / knip：** 完整 `npm run quality` 因本机缺少 `apps/web/backend/.venv` 报 `FAIL_TOOLING`（`TOOL_MISSING`），按指令未安装依赖。针对 server workspace 的 knip 已看到未接线出口，主要包括：`RENDER_GENERATION_SCHEMA`、`RENDER_GENERATION_INDEX_SCHEMA`、`RENDER_GENERATION_DISK_SAFETY_MULTIPLIER`、`RENDER_GENERATION_MAX_FILE_BYTES`、`RENDER_GENERATION_DURABILITY_NOTE`，以及一批仅供后续接线的类型。未扩大基线，未造假调用。

## 建议下一刀

RF-03 仍未完成。本刀停在 RF-03A.2；不进入 RF-03B，除非 Codex 独立验收 P1-1 / P1-2（含清单 symlink 与 hardlink 外部字节）通过。通过后下一刀应只在 `jobs.ts` 同一把 job 锁里消费本模块：

1. 启动时 `recoverOrphans()`，只补索引。
2. 首次 mutation 前导入 g0；锁内重读 `current_render_generation_id`，再 `sealGeneration` / `prepareActivationPatch`。
3. 一次 `replaceFile` 写入 pointer 与派生 `files`（保留 ppt/sheet/read 等非代际 key）。
4. 同单 mutation 互斥（`render_generation_busy`）仍走现有全局 Blender 槽；本模块继续不写 job.json。

HTTP 历史/创建/激活（T5 / RF-04）和默认 profile 切换都不属于下一刀，除非用户另授。
