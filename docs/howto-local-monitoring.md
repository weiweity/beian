# How to 运行本地监控合成回归

这份操作把告警判断、只读探测、投递、本地循环和配置装载分别验证，得到可复核的合成结果。它不会访问杭州、读取生产配置或发送真实消息。

## 前置条件

- 在仓库根目录执行命令。
- Node.js 已安装；项目的根测试和工具测试使用仓库现有依赖。
- 不要把真实 URL、密钥、真稿或生产状态文件传给这些命令。

## 步骤

1. 回放一个固定夹具，确认告警核心只在连续异常达到阈值后产生事件。

   ```bash
   node scripts/monitoring/replay.mjs \
     --input scripts/monitoring/fixtures/down.json \
     --text
   ```

   结构化事件写到 stdout，`--text` 产生的脱敏草稿写到 stderr。示例不会调用 transport。

2. 运行带 fake transport 的投递示例，确认事件先持久入队再得到模拟确认。

   ```bash
   node scripts/monitoring/delivery/example.mjs
   ```

   示例使用临时目录和 fake clock，并注入 fake transport；如果省略 transport，`tick()` 才会报告 `no_transport`。

3. 运行本地循环示例，确认采样、核心判断、pending 交接和投递按顺序完成。

   ```bash
   node scripts/monitoring/runner/example.mjs
   ```

   该示例注入 fixture sampler 与 fake transport。runner 默认没有探测 URL；常驻部署、计划任务和真实渠道不属于本步骤。

4. 查看单次探测入口的边界。Mac 上不注入 Windows executor 时，服务事实会标记为 `platform_not_windows`，这不是 Windows 实机通过。

   ```bash
   node scripts/monitoring/probes/cli.mjs --help
   node scripts/monitoring/probes/cli.mjs
   ```

   只有明确传入 `--loopback-url` 或 `--public-url` 才会发 HTTP GET。公网地址必须由调用者显式提供；不要把生产地址写进脚本或夹具。

5. 单独核对配置装载的合成回归。

   ```bash
   node --test scripts/monitoring/load-config.test.mjs
   ```

   测试使用仓库示例和临时合成 JSON，覆盖显式绝对路径、缺省策略及坏配置拒绝。装配用法见[配置参考](../scripts/monitoring/config/README.md#用法)：`loaded.runner` 传给 runner，`loaded.delivery` 经 `createQueue` 注入；装载本身不启动循环。显式 `alert.sources: []` 会被拒绝，省略该字段才使用既有默认来源。

6. 需要完整监控回归时，运行四个局部测试组；第一组已包含上面的配置装载回归，无需重复单跑。

   ```bash
   node --test scripts/monitoring/*.test.mjs
   node --test scripts/monitoring/probes/*.test.mjs
   node --test scripts/monitoring/delivery/*.test.mjs
   node --test scripts/monitoring/runner/*.test.mjs
   ```

## 验证

四组测试都应退出码为 0。测试使用 mock、fixture 和临时目录，不代表断电耐久、exactly-once，也不等于停 8787/cloudflared 的真实掉线验收。飞书 bot transport 的合成回归在 `scripts/monitoring/delivery/feishu-bot-transport.test.mjs`：注入假 exec，断言 argv 与结果映射，不访问网络。杭州任务是否在跑、是否允许真实发送，以 [TODOS.md](../TODOS.md) F02 为准。

## 杭州计划任务（需在杭州本机执行）

杭州生产机已注册 `beian-monitor-local`（见 TODOS F02）。需要重装或换 identity 时，在杭州管理员 PowerShell（已提升）执行。本页不远程安装，也不停 `beian-server-8787` / cloudflared，不改 Illustrator。

1. 在 `C:\supply\data\monitor-identity.json` 写入仓库外身份（模板见 `scripts/monitoring/host.identity.example.json`）。不要用 PowerShell 5.1 的 `Set-Content -Encoding utf8`（会写 BOM，Node `JSON.parse` 会立刻退出码 2）。用无 BOM 的 UTF-8：

   ```powershell
   New-Item -ItemType Directory -Force -Path C:\supply\data | Out-Null
   $identity = @"
   {
     "schema": "beian-monitor-identity-v1",
     "receiveId": "ou_replaceme0001",
     "allowRealSend": false
   }
   "@
   $utf8 = New-Object System.Text.UTF8Encoding $false
   [System.IO.File]::WriteAllText("C:\supply\data\monitor-identity.json", $identity.Trim() + "`n", $utf8)
   ```

   `allowRealSend` 为 true 时必须有绝对 `cliPath`（lark-cli）或独立的 `appId`/`appSecret`，不要复制产品 `settings.json`。
2. 安装任务：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\windows\install-monitor.ps1
   ```

   任务名固定 `beian-monitor-local`，SYSTEM、开机启动、Hidden、IgnoreNew。探测环回 `http://127.0.0.1:8787/api/health` 与公网 `https://www.jianghua.site/api/health`。安装器会去掉 identity 文件的 UTF-8/UTF-16 BOM。
3. 卸载：`install-monitor.ps1 -Uninstall`。发版脚本不会自动安装该任务。

   任务 `Ready` 且 `LastTaskResult` 为 2：先看 `C:\supply\data\runtime\monitor\host-error.json`，再在前台跑 `host.mjs --once` 看 stderr。`NextRunTime` 为空是因为触发器只有 AtStartup，不是失败标志。

## 故障排查

- 看到 `platform_not_windows`：这是 Mac 默认行为。使用注入的 executor 运行测试，或在获准的 Windows 隔离环境做实机验证；不要把 Mac 输出改写成 Windows 结论。
- 看到 `no_transport`：runner/delivery 没有发送器是默认安全状态。检查是否只是想做合成回归，不要为排错读取产品通知密钥。
- 看到 `runner already running`：`host.mjs --once` 拒绝共享已在跑的计划任务 state。只停 `beian-monitor-local` / `host.mjs`，不停 8787 或 cloudflared。
- 看到 `appSecret must be explicit`：identity 里的 `appSecret` 过短或未写入。PowerShell 5.1 的 `Read-Host -AsSecureString` 若整段粘贴脚本，可能把下一行当成密钥。
- 状态文件解析失败：模块会拒绝坏文件且不会静默清空。删除或替换状态文件属于运维决定，不在此步骤自动执行。
- Promise 投递超时：结果会变成 `unknown`，迟到的确认不能覆盖它；同来源后续事件会等待原 Promise settle，以保持顺序。

## 相关资料

- [本地监控设计说明](explanation-local-monitoring.md)
- [监控脚本参考](../scripts/monitoring/README.md)
- [配置装载参考](../scripts/monitoring/config/README.md)
- [投递模块参考](../scripts/monitoring/delivery/README.md)
- [runner 参考](../scripts/monitoring/runner/README.md)
- [测试与验证](../TESTING.md)
