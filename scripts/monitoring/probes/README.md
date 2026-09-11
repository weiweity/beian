# 本地只读探测适配器（F02 第二阶段）

把 `beian-server-8787`、`cloudflared` 的 Windows 服务观察，以及**明确配置**的环回/公网 HTTP health，收成现有 `alert-core` 可接受的 `facts` / `sample`。本目录不分类、不去抖、不发事件；那些能力仍只在 `../alert-core.mjs`。

本轮仅做本地 mock 验证，未探测生产或发送消息，未注册计划任务或 Windows 服务，也不改 `/api/health`。本模块提供单次采样，本地循环由 [runner](../runner/README.md) 负责。

## 合同口径

- 两个 Windows 服务名冻结为 `beian-server-8787` 与 `cloudflared`。查询走参数数组 + `-File get-services.ps1`，不接受任意 shell 命令，不 Start/Stop/Restart。
- HTTP 仅 GET。`--loopback-url` / `--public-url` 都是可选且无默认值；不读 `.env`、settings 或 `WB_DATA_DIR`，源码不含公网产品地址。
- 环回请求不带转发头 / Authorization / Cookie / 发版令牌，以便服务端 `isDirectLoopbackHealth` 成立。
- 非 200 HTTP 状态不等正文读完即保留；200 正文流按 65536 字节上限读取，超限取消读流并报告 `body_too_large`。采样完成释放取消监听，已取消请求不启动服务查询。
- 公网 HTTP 失败只写入 `http_health.public`，**不能**据此改写两个服务事实。
- `observed` 在进入核心前映射到 `running` / `stopped` / `paused` / `missing` / `unknown` / `start_pending` 等词表。Get-Service 的 `StartPending` 不会原样交给核心。
- 命令非零退出（即使 stdout 是完整 JSON）、超时、取消、权限拒绝、缺可执行文件：`sample_ok=false`，不把服务写成 `stopped`/`missing`。服务不存在才是 `observed=missing`。
- 公开 facts 只有 `kind`、`sample_ok`、`observed`、`target`、`http_status`、`body_ok`、`parse_ok`、`version`。原始 URL、凭据、响应正文、命令 stderr 不进入 facts。
- 错误原因放在 sidecar `reasons`，使用有限枚举。Mac 上注入 mock 或默认 `platform_claim=not_windows` **不是** Windows 实机通过。

## 单次入口

```bash
node scripts/monitoring/probes/cli.mjs --help
node scripts/monitoring/probes/cli.mjs
node scripts/monitoring/probes/cli.mjs --loopback-url http://127.0.0.1:8787/api/health
node scripts/monitoring/probes/cli.mjs --loopback-url http://127.0.0.1:8787/api/health --public-url https://example.test/api/health
```

stdout 是可交给 `replaySamples` / `createAlertEngine.ingest` 的 sample JSON（`sampled_at` + `facts`，可选 `id` / `reasons`）。采样完成退出 0；健康判断留给核心。用法错误退出 2。

库入口：`createProbe({ now, httpGet, exec, platform }).collectSample({ loopbackUrl, publicUrl, timeoutMs, id, sequence, signal })`。

## 测试

与仓库 `scripts/quality` 相同，使用 `node:test`。默认不打外网、不启停服务、不启动 Blender/Illustrator、不发送消息：

```bash
node --test scripts/monitoring/probes/*.test.mjs
```

原有核心回放仍为：

```bash
node --test scripts/monitoring/*.test.mjs
```

两条都要跑；后者不会自动发现本目录测试（`*.test.mjs` 不含子目录）。

## 明确未做

- 杭州 Windows 实机 `Get-Service` 验收（Mac 模拟 PowerShell JSON 不能写成实机通过）
- 飞书或其他通知渠道
- 计划任务、WinSW、cloudflared 安装
- 生产 health 路由变更
- 本模块内的常驻调度器、状态文件与 exactly-once；本地持久交接见 [runner](../runner/README.md)，不代表生产部署

## 质量入口

根 knip 已登记单次 CLI 与本目录测试；`get-services.ps1` 不是 JS 入口。
