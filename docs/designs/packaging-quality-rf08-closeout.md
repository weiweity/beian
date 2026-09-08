# RF-08 交付与历史证据记录

整理日期：2026-09-08；以下交付与验证发生于 2026-09-07。状态：**已合入 `origin/main` `cbed35f4ad33c4b30c9e46b0c5ffa3d68ee82d11` / `0.21.42.0`；Code / 普通 L0 已验证；杭州公网 VERSION 已上线；未改生产默认**。范围：按实际相机与正反两张 shot 的 2×2 Jacobian 反推六面切图像素，超过 maximum ppm 或 32MP 时 `render_texture_budget_exceeded` 返回 required/allowed，禁止静默 clamp。原分支 `codex/rf08-projection-sampling`（2026-09-08 清理，提交历史仍可由 PR 追溯），基线已发布 RF-07 `88321a90a8ab61803c66b28e04b25f46e64cb29d` / `0.21.41.0`。人工验收、RF-11 Blender 合同冒烟（计划）、真实稿 L2/UAT、生产 registry 与正式 baseline 均未改变。

## 发布证据（2026-09-07 独立复核）

以下是 2026-09-07 在以 merge SHA 为基线的隔离工作区完成的独立复核。该工作树已于 2026-09-08 归档清理；本次文档整理只迁回已核实证据，未重跑产品测试或操作杭州。历史 health 样本不代表持续在线监控。

| 项 | 结果 | 证据 |
|---|---|---|
| PR | [#94](https://github.com/weiweity/beian/pull/94) `MERGED` squash，`mergedAt` 2026-09-07T07:32:04Z | `gh pr view 94` |
| feature HEAD | `10a03b51643a4e5ac198530d1d994929474b4cbc`；原分支已于 2026-09-08 清理 | PR commits（无需保留原分支） |
| merge SHA | `cbed35f4ad33c4b30c9e46b0c5ffa3d68ee82d11` | PR `mergeCommit`；当时工作区 `git rev-parse HEAD` |
| GitHub-hosted CI | `quality` + `windows-powershell-contract` 均 pass；`quality` run `34094885526` SUCCESS，head `10a03b5`，约 12m23s | `gh pr checks 94` |
| hangzhou-release | run [34095937539](https://github.com/weiweity/beian/actions/runs/34095937539) SUCCESS；event `push`；`headSha` 等于 merge SHA；created 07:32:07Z，completed 07:34:08Z | `gh run view 34095937539` |
| 公网 health | HTTP 200，`{"ok":true,"version":"0.21.42.0","runtime":"typescript",...}` | 查询时刻 **2026-09-07T09:30:30Z**（UTC），`https://www.jianghua.site/api/health`。这是 RF-08 的历史版本样本；后续 RF-09 发布见对应交付记录 |
| VERSION 对齐 | 当时仓库 `VERSION`、Hono `const VERSION`、公网 health 为 `0.21.42.0`；package 为三段版本 `0.21.42` | 当时工作区文件 + health JSON |
| 生产默认 | 生产 `render-profiles.v1.json` 仍为 `minimum-floor-v1`；投影策略只在诊断 `packshot-projection-sampling-v1` | 该提交的 registry 文件 |

杭州 **VERSION 上线**只证明发版事务把 `0.21.42.0` 放到了公网 health。它不是 ADR-007 §14.3 规划的 RF-11 Blender 合同冒烟，也不是 L2/UAT。原工作树内的 land 报告已随分支清理保存在 Git 外 `beian-branch-cleanup-20260908/beian-rf08-projection-sampling/preserved-files.tar.gz`。Git 外评审材料见 `/Users/hutou/Documents/Codex/audits/beian-rf08-p1-evidence/`（不进仓）。

## 实现与兼容

- 投影计算在 `workers/packaging/camera_frame.py`，与 `render_job.apply_camera_fit` / `look_at(-Z, Y)` 同一套 millimetre 相机：dimension-fit 或 legacy-pinned ortho、Blender 最长边 `ortho_scale`、六面 UV 与 `render_geometry._source_point` 对齐后再绕 Z 转 shot。
- 每面：最大奇异值 = `projected_max_ppm`，最小奇异值 = `projected_min_ppm`；同一面取两张 shot 的最大需求。`untruncated_target_ppm = max(minimum_ppm, projected_max * oversample_ratio)`。超过 `maximum_face_pixels_per_mm` 或单面 32MP 时失败，不把需求压到上限。
- `oversample_ratio` 只写在诊断 profile（候选 1.5），不散落魔法常量。现有 1–64 px/mm 与 32MP 上限未放宽。
- 新策略 `projection-jacobian-v1` 只登记在 `workers/packaging/profiles/experiments/rf08-projection-sampling.v1.json` 的 `packshot-projection-sampling-v1`。生产 `render-profiles.v1.json`、`compat-legacy-v0` hash、Standard、registry 默认均未改。入口：`load_experimental_projection_registry` / `render_plan_for_experimental_projection_job`。
- `artwork.py` 对投影策略按每面目标一次矢量栅格 + 一次 affine；预算失败在 `get_pixmap` 前；写入 `.face-staging-*`，成功才替换到输出目录；提交失败经 `.face-backup-*` 恢复上一套完整六面并删除暂存，不留下新旧混合面板。
- 采样身份进入 spec `per_face_target_pixels_per_mm` 与 `render_contract_hash` / fingerprint。相机或主输出尺寸变化会改变目标与 cache。`blender_result.json` 增加 engine / Blender 版本 / samples / pixel filter / view transform / master 分辨率 / face_sampling。

## 历史合同计算示例（47.5×47.5×177.5 mm，3000×3600，oversample 1.5）

本表保留原合同示例数字：floor 的 20 ppm 是最低要求，projection 的 22.369511 ppm 是合同目标；按对应 ppm × 面尺寸逐轴向上取整得到下列像素，再汇总六面。它们是计算值，不是本轮 50×40×80 mm 合成对照的切面实测值，也不说明 floor 实际会固定输出 20 ppm。本轮实际约 55.56 / 49.64 ppm，见文末合成对照记录；两套实际纹理预算不同，不能据此推导画质改善或等效。

| | 旧 `minimum-floor-v1` | 新 `projection-jacobian-v1` |
|---|---|---|
| 下限 / 合同目标 ppm | 最低要求 20.0（非固定输出目标） | 合同目标 22.369511 |
| front 计算像素 | 按下限计算：950×3550（3 372 500） | 按合同目标计算：1063×3971（4 221 173） |
| 六面合计计算像素 | 15 295 000 | 19 144 630 |
| front 投影 | 未计算 | min 11.728011 / max 14.913007 |
| 合同 hash | 生产 compat 身份不变 | `sha256:952344ea39f28e33436050363ae2676fcd29beed5d7d8f70f1bc03e82276b371` |

预算拒绝示例：10×10×10 mm 盒在同一 3000×3600 dimension-fit 下 `required_pixels_per_mm=67.5`、`allowed_pixels_per_mm=64.0`，`render_texture_budget_exceeded`；500 mm 立方在 20 ppm 下限下 100 MP > 32 MP，同样失败并带 required/allowed 像素。

## 分阶段验证（历史回执）

红测（实现前）：`test_packaging_projection_sampling.py` 8 failed / 12 passed / 1 deselected。缺口是合同入口、切面 staging 与预算接线，不是 Jacobian 公式本身。

| 验证 | 实际结果 | 证据 |
|---|---|---|
| 聚焦普通测试 | `test_packaging_projection_sampling` + artwork + contract + 相关 pipeline/generation：163 passed / 1 deselected | 原实现工作区 pytest。**本次文档整理未重跑** |
| 显式 native 相机对齐 | Blender 5.2.0 LTS；location / ortho_scale / 相机基与 Python `look_at` 一致；1 passed | 原 `--run-native` 相机探针。**本次文档整理未重跑** |
| 显式 native 合成出图 | 两张 3000×3600 RGBA + GLB；`blender_result` 写入 strategy/master/view_transform；约 9.4 s；1 passed | 原 `--run-native` `test_native_blender_records_projection_sampling_and_output_metrics`。成片未持久化。**本次文档整理未重跑** |
| 完整 L0（实现中、工作区仍停在 RF-07 HEAD） | `npm run verify -- full` exit 0；test:quality 59 pass；quality PASS（59 基线）；typecheck/UI build exit 0；`npm test` 内 Python 集合 **1212** passed / 9 skipped / 10 deselected；`source_stable=true`；receipt `before.head=88321a90`（当时功能尚未提交） | 原回执已打开；原字节归档 `/Users/hutou/Documents/Codex/audits/beian-rf08-p1-evidence/archive/l0/impl-1212-cq0qrR/`（含 `receipt.json` 与 step 日志） |
| 完整 L0（PR HEAD / land 前复验） | 四步 exit 0；`beian@0.21.42`；`npm test` 内 Python 集合 **1220** passed / 9 skipped / 10 deselected；`source_stable=true`；`before.head=10a03b51643a4e5ac198530d1d994929474b4cbc` | 归档 `archive/l0/prhead-1220-tpkbrK/`。已独立核对 receipt 与 step-4.log；不是本次文档整理新跑的测试 |

旧 RF-07 渲染结果不作为本轮通过证据。合成盒不是真实稿；3D 仍用于看形，`read_*` 仍是验字事实源。没有人工证据，不宣称真实稿字体清晰度或生产画质已验收。

## 合成策略对照（历史观察）

RF-08 合成对照已在本机跑完（Git 外 `archive/rf08-compare/`），顾问复核后保留为采样策略对照，**不能据此批准新基线**。floor / projection contract hash 不同。floor 实际约 55.56 ppm（`max(20, 10000÷180)`，20 是下限不是固定输出）；projection 实际约 49.64 ppm。细线为 0.15 pt ≈ 0.0529 mm，不是 0.15 mm。`elapsed_s` 只计 Blender 子进程。六面像素 −20.15%、GLB 字节 −11.91% 仅为本样本记录。文字/细线只记观察。`winner=null`，保持 Standard。未改生产 registry，未 `--update-baseline`。该合成对照不用于证明 RF-09 或后续阶段验收。

RF-05/RF-00 原图与 L0 step 日志已按原字节归档到 Git 外 `beian-rf08-p1-evidence/archive/`。RF-07 纯色盒不能用来评价文字保留。本次文档整理未重跑聚焦 pytest、`--run-native` 或完整 L0；上表数字来自已归档回执，不是新增测试结果。

## 未验证 / 仍阻塞

- RF-11 Blender 合同冒烟（ADR-007 §14.3 计划）、真实稿 L2、刘籽烨 UAT。
- 生产 registry 注册、正式 baseline、把投影策略设为产品默认、RF-10 质量平台。
- RF-09 已发布，剩余实机和性能验证见 [RF-09 记录](packaging-quality-rf09-closeout.md)；当前未完成项只维护在 [TODOS.md](../../TODOS.md)。
