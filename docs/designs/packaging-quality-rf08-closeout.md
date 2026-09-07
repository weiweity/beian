# RF-08 本地交付记录

日期：2026-09-07。状态：**Code / 普通 L0 已验证；本分支已记 VERSION `0.21.42.0`，尚未合入 `origin/main`；未改生产默认**。范围：按实际相机与正反两张 shot 的 2×2 Jacobian 反推六面切图像素，超过 maximum ppm 或 32MP 时 `render_texture_budget_exceeded` 返回 required/allowed，禁止静默 clamp。分支 `codex/rf08-projection-sampling`，基线已发布 RF-07 `88321a90a8ab61803c66b28e04b25f46e64cb29d` / `0.21.41.0`。人工验收、杭州 L1、真实稿 L2/UAT、生产 registry 与正式 baseline 均未改变。

## 实现与兼容

- 投影计算在 `workers/packaging/camera_frame.py`，与 `render_job.apply_camera_fit` / `look_at(-Z, Y)` 同一套 millimetre 相机：dimension-fit 或 legacy-pinned ortho、Blender 最长边 `ortho_scale`、六面 UV 与 `render_geometry._source_point` 对齐后再绕 Z 转 shot。
- 每面：最大奇异值 = `projected_max_ppm`，最小奇异值 = `projected_min_ppm`；同一面取两张 shot 的最大需求。`untruncated_target_ppm = max(minimum_ppm, projected_max * oversample_ratio)`。超过 `maximum_face_pixels_per_mm` 或单面 32MP 时失败，不把需求压到上限。
- `oversample_ratio` 只写在诊断 profile（候选 1.5），不散落魔法常量。现有 1–64 px/mm 与 32MP 上限未放宽。
- 新策略 `projection-jacobian-v1` 只登记在 `workers/packaging/profiles/experiments/rf08-projection-sampling.v1.json` 的 `packshot-projection-sampling-v1`。生产 `render-profiles.v1.json`、`compat-legacy-v0` hash、Standard、registry 默认均未改。入口：`load_experimental_projection_registry` / `render_plan_for_experimental_projection_job`。
- `artwork.py` 对投影策略按每面目标一次矢量栅格 + 一次 affine；预算失败在 `get_pixmap` 前；写入 `.face-staging-*`，成功才替换到输出目录；提交失败经 `.face-backup-*` 恢复上一套完整六面并删除暂存，不留下新旧混合面板。
- 采样身份进入 spec `per_face_target_pixels_per_mm` 与 `render_contract_hash` / fingerprint。相机或主输出尺寸变化会改变目标与 cache。`blender_result.json` 增加 engine / Blender 版本 / samples / pixel filter / view transform / master 分辨率 / face_sampling。

## 旧/新采样（47.5×47.5×177.5 mm，3000×3600，oversample 1.5）

| | 旧 `minimum-floor-v1` | 新 `projection-jacobian-v1` |
|---|---|---|
| 每面目标 ppm | 20.0 | 22.369511 |
| front 像素 | 950×3550（3 372 500） | 1063×3971（4 221 173） |
| 六面合计像素 | 15 295 000 | 19 144 630 |
| front 投影 | 未计算 | min 11.728011 / max 14.913007 |
| 合同 hash | 生产 compat 身份不变 | `sha256:952344ea39f28e33436050363ae2676fcd29beed5d7d8f70f1bc03e82276b371` |

预算拒绝示例：10×10×10 mm 盒在同一 3000×3600 dimension-fit 下 `required_pixels_per_mm=67.5`、`allowed_pixels_per_mm=64.0`，`render_texture_budget_exceeded`；500 mm 立方在 20 ppm 下限下 100 MP > 32 MP，同样失败并带 required/allowed 像素。

## 验证

红测（实现前）：`test_packaging_projection_sampling.py` 8 failed / 12 passed / 1 deselected。缺口是合同入口、切面 staging 与预算接线，不是 Jacobian 公式本身。

| 验证 | 实际结果 | 证据 |
|---|---|---|
| 聚焦普通测试 | `test_packaging_projection_sampling` + artwork + contract + 相关 pipeline/generation：163 passed / 1 deselected | 本工作区 pytest |
| 显式 native 相机对齐 | Blender 5.2.0 LTS；location / ortho_scale / 相机基与 Python `look_at` 一致；1 passed | `--run-native` 相机探针 |
| 显式 native 合成出图 | 两张 3000×3600 RGBA + GLB；`blender_result` 写入 strategy/master/view_transform；约 9.4 s；1 passed | `--run-native` `test_native_blender_records_projection_sampling_and_output_metrics` |
| 完整 L0 | `npm run verify -- full` exit 0；test:quality 59 pass；quality PASS（59 基线）；typecheck/UI build exit 0；`npm test` 1212 passed / 9 skipped / 10 deselected；source_stable=true | `/Users/hutou/Documents/Codex/audits/beian-rf08-projection-sampling-20260907/beian-verify-cq0qrR/receipt.json` |

旧 RF-07 渲染结果不作为本轮通过证据。合成盒不是真实稿；3D 仍用于看形，`read_*` 仍是验字事实源。没有人工证据，不宣称真实稿字体清晰度或生产画质已验收。

## 未验证 / 仍阻塞

- 杭州 Windows Blender L1、真实稿 L2、刘籽烨 UAT
- 生产 registry 注册、正式 baseline、把投影策略设为产品默认
- RF-09 浏览器 card→full、RF-10 质量平台、RF-11 Windows 发版烟测
- 本分支已记 VERSION `0.21.42.0` 与 CHANGELOG；尚未开 PR、合入 `origin/main` 或部署
