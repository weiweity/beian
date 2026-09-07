# RF-07 本地交付记录

日期：2026-09-07。状态：**已合入 `origin/main` `88321a90` / `0.21.41.0`；未改生产默认，人工选择未批准**。分支 `codex/rf07-integration`，基线已发布 RF-06 `d2657f0331bba147c12e44d2d5c24c60eb9da42a` / `0.21.40.0`。Grok 接管完整 `/ship`。下文为该次交付切片；公网 health 对齐 VERSION 的发布证据见当时 land-and-deploy，不等于 L2/UAT。

## 交付与兼容

- 独立诊断 profile `packshot-studio-explicit-v1` / `normalized-three-area-explicit-v1`：声明三灯位置、软箱边长、参考能量、fill 比 0.35、key 降仰角 15°、world strength 0.62、world color、无 HDRI 和 180 mm 参考最长边。位置与软箱边长按比例缩放，能量按比例平方；正反 shot 保持相机空间灯位。
- 材质沿用 RF-06 白卡 none，纸芯不贴法线。未改 RF-06 材质 registry、生产 registry、F profile、Standard 默认或正式 baseline。非白 world_color 会写入真实 Background 节点并读回。VERSION / CHANGELOG 为 `0.21.41.0`，已合入 `origin/main` `88321a90`。
- 受控 Standard / Khronos PBR Neutral / AgX 对照固定几何、UV、材质、纹理、灯、相机、曝光、look、分辨率、samples 和帧。EEVEE 无可用采样 seed 时明确记录原因，存在的 cycles.seed 另行读取。
- 渲染前写声明与 SHA256；匿名图只用 A/B/C，映射单独保存。每作业最多 300 秒，整轮最多 1800 秒，剩余时长限制下一作业预算。
- 没有批准的 P0 阈值与私有真实稿盲评：`awaiting_human_approval`、`winner=null`，保持 Standard。色差、暗阶和斜面细线缺少校准 ROI，报告 unavailable，不用整图均值冒充测量。
- 已发布 RF-06 的 GLB 法线 UV accessor 存在性 / VEC2 / 数量 / 有限值校验、required extension 门和 13 项 ship 覆盖测试保持。RF-07 显式棚光计划仍走该产物门，无效 UV 不得放行。

## 迁入范围

相对旧 RF-06 已验证基线的 11 项增量迁入当前 `main`：

- 新文件：诊断 registry、实验声明、对照驱动/Blender 包装、RF-07 测试与本记录。
- 共享文件语义合并：`render_contract.py`、`render_job.py`、TODOS、ADR-007、文档索引与 packaging README。当前 main 上两份共享产品源码与旧 RF-06 基线字节相同，因此采用已验证 RF-07 增量，而不是用旧 RF-07 工作区覆盖 RF-06 发布修复。
- 迁入时保留不覆盖：已发布 `glb_verify.py`、`test_rf06_ship_coverage.py`、RF-06 收口文档、生产 registry。随后 `/ship` 写入 VERSION `0.21.41.0`、CHANGELOG 与 package 锁文件，仍未合入 `origin/main`。

本轮另增 `apps/web/backend/tests/test_rf07_rf06_compat.py`，覆盖 RF-07 studio 计划与已落地 UV/required-extension 门的组合。矩阵报告中的 `glb_verify_sha256` 为落地值 `564e51b401b35f962f4919a9c2ce908d6be414395fb9233f4e0b51725cf254c2`，不是旧 RF-06 快照。

## 验证

证据相对 `/Users/hutou/Documents/Codex/audits/beian-rf07-integration-20260907/`。下列为本工作区本轮实测，不用旧 RF-07 快照冒充。

| 验证 | 实际结果 | 证据 |
|---|---|---|
| 完整普通 Python | 1174 passed / 9 skipped / 8 deselected，exit 0；源码前后身份一致 | `python/beian-verify-ULvlsH/receipt.json` |
| 质量工具测试与 quality | 59 tests；PASS，59 项既有基线（knip 57, vulture 2）；源码前后身份一致 | `quality/beian-verify-LQ0HyV/receipt.json` |
| RF07 相关 + 显式 native + RF06 兼容 | 106 passed，exit 0；Blender 5.2.0 LTS；含变换读回、固定场景篡改、RF06 实际 GLB 导出与 UV 门 | `native/receipt.json`、`native/output.log` |
| 最终四盒三变换矩阵 | 12 作业完成；24 张 3000×3600 RGBA；12 GLB / 12 Blend；`ok=true`、`complete=true`、`winner=null`、保持 Standard；源码前后 SHA256 一致 | `matrix-run/receipt.json`、`matrix/report.json`、`matrix-disk-audit.json`、`matrix-source-inventory.json` |

矩阵 complete 表示受控对照成立，不代表候选获胜或纸感、色彩达标。决策为 `awaiting_human_approval`。未写 RF-00 正式 baseline，未改生产行为。

本轮无 UI 行为改动，对照 CLI 不经网页；未跑完整 L0 `npm test`、typecheck 或 E2E。验证之后只更新本文证据表，未再改产品/测试源码，故不重跑渲染。

## Git 与剩余门槛

RF-06 已发布：`d2657f0` / `0.21.40.0`。RF-07 已发布：`88321a90` / `0.21.41.0`。旧 RF-07 验证快照仅作增量来源：`/Users/hutou/Documents/Codex/audits/beian-rf06-rf07-20260907/rf07-verified-snapshot/manifest.json`。杭州 Windows Blender L1、真实稿 L2、UAT、生产注册、正式 baseline 与色彩赢家仍未批准。
