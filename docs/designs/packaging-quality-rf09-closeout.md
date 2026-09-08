# RF-09 浏览器预览与下载交付记录

记录日期：2026-09-08。适用交付：`0.21.43.0` / `d5763aca8fbdaacc80ca731a298c84a7fa2c4525`。本页整理 2026-09-07 的实现、合并与发布证据；不代表新的测试或生产操作。

## 行为与范围

- 产品、地面和布景各层从 card 独立升级到 full；布景慢或失败时保留可用画面。失败、resize、切代与卸载有合成回归。
- 灯箱按实际可用图层显示，product/ground full 不等待 set full；布景 full 失败保留已显示的 set card。
- 下载冻结点击时的代际、背景和灯光；灯箱下载按灯箱画面选择。已显示 set 但 set full 未就绪时提示重试，不放大 card 或改用 ground。切代/离页后已启动的下载继续完成。
- 生产 registry、默认采样、Standard、正式 baseline 与真实画质批准均未改变。3D 用于看形，印刷面 `read_*` 仍是验字事实源。

## 合并与发布证据（2026-09-07）

| 项目 | 证据 |
|---|---|
| PR | [#95](https://github.com/weiweity/beian/pull/95)，最终 HEAD `942ab2cdc9dd59f896cc00528cf9626b3592adaa` |
| 合并 | 2026-09-07T15:46:47Z，squash，merge SHA `d5763aca8fbdaacc80ca731a298c84a7fa2c4525` |
| 本地验证 | 完整 L0、类型/UI build、test:quality、quality 及 27 项合成 E2E；独立复核修正灯箱空 set 的下载冻结问题。具体阶段证据见 ADR-007 §12.4–12.5、§Implementation Tasks T10 与 PR |
| 最终 HEAD CI | PR 的 quality 与 windows-powershell-contract 均通过；GitHub-hosted CI 不替代杭州验证 |
| 可信发布 | [hangzhou-release 34140031582](https://github.com/weiweity/beian/actions/runs/34140031582)，main push，headSha 等于 merge SHA；hangzhou-windows / self-hosted、hangzhou；15:46:53Z–15:47:43Z 成功 |
| 现有发布身份冒烟 | Illustrator 30.5.1 / Session 1，build 等于完整 merge SHA；SMOKE ok：version=0.21.43.0、sha=d5763ac、logo=200 |
| 公网版本样本 | 发布完成超过 20 秒后，2026-09-07 15:50Z 左右，health 返回 ok=true、version=0.21.43.0；匿名 Illustrator 仅显示 visibility=authenticated。杭州 runner 来源、版本与当时 Mac 无 cloudflared 的检查一致 |

本地证据归档：`/Users/hutou/Documents/Codex/audits/beian-rf09-land-20260907/` 中的 `merged-pr.json`、`deploy-jobs.json`、`deploy.log`、`health-after.json`、`deploy-report.md` 和 `post-deploy.png`。源码分支和工作树已于 2026-09-08 清理，Git 历史、发布及测试记录另存于 Git 外 `beian-branch-cleanup-20260908/`，不依赖原工作树继续存在。

## 验证限制与后续

匿名浏览器到达飞书登录页，有实际内容；该页加载约 4.165 秒，并有两条 ERR_CONNECTION_CLOSED。它不是产品内部界面的性能或“零错误”证明。登录后的生产 UI、本机以外的真实性能、heap/帧预算、真实稿 L2/UAT 尚未验收。

上述现有发布身份冒烟不等于 RF-11 规划中的 spec→Blender→PNG/GLB→quality report 合同冒烟。版本已发布不等于纸感、字体清晰度、正式 baseline 或业务开放已批准。当前剩余项只维护在 [TODOS.md](../../TODOS.md)。
