# 本地告警工具（F02）

判断 `beian-server-8787`、`cloudflared` 和 HTTP health 的本地候选规则：去抖、重复抑制、脱敏草稿。核心与回放入口不探测生产、不发送消息；只读探测与本地投递模块见下文。杭州计划任务由 `scripts/windows/install-monitor.ps1` 在本机注册，不由发版脚本自动安装，也不改 `/api/health`。

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

## 第二阶段模块

- [只读探测适配器](probes/README.md)：固定服务查询与显式 HTTP URL，输出核心可消费的 sample；仅本地 mock 验证，Windows/真实网络待验。
- [本地投递模块](delivery/README.md)：事件持久入队、有限重试与结果不明处理。默认无 transport，接口支持同步/Promise transport、截止时间与 AbortSignal；超时或取消后迟到成功不覆盖状态。独立飞书 bot 须显式注入，默认 `allowRealSend=false`。
- [独立配置装载](config/README.md)：只从显式文件路径读取已有模块支持的非敏感策略；不寻找产品 settings、不扫描环境变量或密钥、不启动托管。
- [本地循环协调器](runner/README.md)：核心与 pending 同次落盘，重启后重复交接由投递层去重；持锁后重读状态，有界停止期间保留所有权。
- `local-flow.test.mjs` 与 runner 集成测试验证合成串联、异步超时、重启去重及默认不发送；不是 Windows/断电耐久验收。
- 完整局部测试命令见 [TESTING](../../TESTING.md)。

## 明确未做

- 不以停 `beian-server-8787` / cloudflared 做真实掉线或恢复验收
- 端到端 exactly-once、断电耐久性
- 生产 health 路由变更
- WinSW / cloudflared 安装（监控任务不替代它们）

杭州 `beian-monitor-local` 的安装、`--once` 与测试消息见 [howto-local-monitoring.md](../../docs/howto-local-monitoring.md) 和 [TODOS.md](../../TODOS.md) F02。独立 bot 默认不允许 spawn；不读产品 `FEISHU_*`。

整合补充：草稿事实按类型和有限枚举保留；target 只允许 public/loopback，不保留完整 URL、查询参数、用户信息或嵌套对象。
