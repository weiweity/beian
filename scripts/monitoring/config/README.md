# 独立监控配置装载（F02 第一切片）

把已有告警 / runner / 投递模块支持的**非敏感策略**从一份显式 JSON 读出来，交给现有构造接口。本目录不探测、不发送、不启动托管循环。

## 合同口径

- 调用方必须给出**绝对路径**。不寻找产品 `settings.json` / `settings.secrets.json`，不扫描环境变量、相邻密钥文件或 `WB_DATA_DIR`。
- 只装载现有模块已经认识的策略：去抖阈值、采样周期、探测超时、投递超时与重试上限。不在本切片新增 URL、渠道、接收人或 transport。
- 复用 `normalizeConfig` / `normalizeRunnerConfig` / `normalizeDeliveryConfig` 与各模块默认值，不另写一套范围规则。
- 缺文件、无效 JSON、错误类型、非法范围、未知字段、禁止字段一律失败关闭。显式坏配置不会改成默认后继续跑。
- 配置不能打开真实 transport、生产自动运行，也不能注入任意命令或模块。
- 错误信息只带字段路径和原因码，不回显文件正文或密钥值。仓库内示例只有合成数字，没有接收人、token 或生产地址。

## 允许的字段

顶层：

- `schema`（必须是 `beian-monitor-config-v1`）
- `production_default`（若出现必须是 `false`）
- `local_candidate`（布尔）
- `alert` / `runner` / `delivery`（对象；缺省则用对应模块默认值）
- `_comment`（顶层及三个策略对象均可选字符串，不进入构造配置）

- `alert`：`fail_threshold`、`recover_threshold`、`unknown_breaks_streak`、`seen_ids_limit`、`sources`
- `runner`：`interval_ms`、`first_delay_ms`、`probe_timeout_ms`
- `delivery`：`max_attempts`、`backoff_ms`、`timeout_ms`

`alert.sources` 省略时使用既有默认来源；显式提供时必须是非空的合法来源数组，`[]` 会被拒绝，不会回退为全部默认来源。

阈值写在 `alert`，由装载结果同时填进 `runner`，以便 `createLocalMonitor({ config: loaded.runner })` 使用现有接口。不要在 `runner` 里重复写阈值，也不要写 URL / `stateDir` / `transport`。

## 用法

以下为位于本目录的调用脚本片段；`samples` / `sampler` 使用合成输入，`statePath` / `stateDir` 由调用方提供本地绝对路径。

```js
import { loadMonitoringConfig } from "./load-config.mjs";
import { replaySamples } from "../alert-core.mjs";
import { createDeliveryQueue } from "../delivery/delivery-core.mjs";
import { createLocalMonitor } from "../runner/runner-core.mjs";

const loaded = loadMonitoringConfig("/absolute/path/to/local.json");
replaySamples(samples, { config: loaded.alert });
createDeliveryQueue({ statePath, config: loaded.delivery }); // 省略 transport 则不发送
createLocalMonitor({
  stateDir,
  config: loaded.runner,
  sampler,
  createQueue: (options) => createDeliveryQueue({ ...options, config: loaded.delivery }),
}); // 不调用 start 就不会托管
```

`loaded.alert` / `loaded.runner` / `loaded.delivery` 是分别归一化的策略。runner 不会自动应用 `loaded.delivery`；上例通过既有 `createQueue` 注入，并保留 runner 传入的状态路径、clock 和 transport。

装载失败抛出 `MonitoringConfigError`，可读 `code` / `field`（也在 `details` 中）定位原因；成功结果中的 `notify`、`production_send`、`production_default` 固定为 `false`。

仓库内合成示例：

```bash
node --test scripts/monitoring/load-config.test.mjs
```

`local.example.json` 可被上述测试装载；它不是生产默认，也不含探测 URL。

## 明确未做

- 自动发现配置文件、环境变量优先级或产品飞书设置
- 用配置激活真实 transport / 公网或环回 URL / Windows 托管
- 修改 alert-core、probes、delivery、runner 的运行时默认值或重试语义
- 计划任务、WinSW、现场 Get-Service、真实消息
