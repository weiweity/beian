# 本地告警核心（F02 第一阶段）

判断 `beian-server-8787`、`cloudflared` 和 HTTP health 的本地候选规则：去抖、重复抑制、脱敏草稿。本目录不探测生产、不发送消息、不注册计划任务或 Windows 服务，也不改 `/api/health`。

## 合同口径

- 环回 `GET /api/health`（无转发头）带实时队列；公网 / Named Tunnel 转发只给发版探活字段。见 `docs/contracts/release.md`、`scripts/windows/README.md`。
- 三个来源分开记录。公网 HTTP 失败或采样失败是 `http_health` 的异常/未知，**不能**据此断言某个进程已停。
- 分类：`ok`（采样成功且健康）、`bad`（采样成功且不健康）、`unknown`（采样失败、解析失败、过渡态或事实不全）。
- 连续 `bad` 达到 `fail_threshold` 产生一条故障；持续故障不刷屏。连续 `ok` 达到 `recover_threshold` 产生一条恢复。默认阈值只是本地候选。
- 启动未知、抖动、重复/乱序采样不会制造故障。本地状态文件不是端到端 exactly-once。

## 回放

```bash
node scripts/monitoring/replay.mjs --input scripts/monitoring/fixtures/down.json --text
node scripts/monitoring/replay.mjs --input scripts/monitoring/fixtures/recovery.json --write-state /tmp/beian-alert-state.json
node scripts/monitoring/replay.mjs --input scripts/monitoring/fixtures/sustained-down.json --state /tmp/beian-alert-state.json
```

stdout 是结构化 JSON（事件、草稿、最终状态）。`--text` 把脱敏草稿写到 stderr。`recipients` / `channel` 固定为未配置。

合成夹具：`healthy`、`down`、`sustained-down`、`jitter`、`recovery`、`startup-unknown`、`duplicate-out-of-order`、`public-http-fail`。

## 测试

与仓库 `scripts/quality` 相同，使用 `node:test`，不打网络、不依赖真实时间：

```bash
node --test scripts/monitoring/*.test.mjs
```

## 明确未做

- 真实 Windows `Get-Service` / 环回或公网探测
- 飞书或其他通知渠道
- 计划任务、WinSW、cloudflared 安装
- 生产 health 路由变更
- 端到端 exactly-once、断电耐久性、杭州实机验收

整合补充：草稿事实按类型和有限枚举保留；target 只允许 public/loopback，不保留完整 URL、查询参数、用户信息或嵌套对象。
