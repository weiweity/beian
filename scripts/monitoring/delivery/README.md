# 本地告警投递（F02 第二阶段）

渠道无关的待发送记录：只读消费 `alert-core` 已生成的事件和脱敏草稿，用注入的 `transport.send` 做有限投递。本目录不判断告警、不探测生产、不选择飞书或其他真实渠道，也不读取产品通知开关或密钥。

默认 **没有** transport。没有注入 `send` 时可以入队，但 `tick()` 不会发送。

## 稳定身份

投递主键是告警核心已经写好的 `event.id`（`type:source:sampled_at`），再加上 `type` / `source` / `at` / `incident_id`。不要另造 ID，也不要为接线去改 `alert-core.mjs`。

故障和恢复是两条事件：同来源先后入队会留下两条记录，互不吞掉。同一 `event.id` 重复入队不会新增待发项。

## 状态

| 状态 | 含义 | 是否终态 | 自动再发 |
|---|---|---|---|
| `queued` | 已持久化，尚未开始第一次发送 | 否 | `tick` 到期后发 |
| `sending` | 已写下“即将发送”；进程内发送中 | 否（只应短暂存在） | 重启后变为 `unknown` |
| `retry_wait` | **确认失败**且可重试，等待退避 | 否 | 到期后发 |
| `confirmed` | transport 确认送达 | 是 | 否 |
| `failed` | **确认失败**且次数耗尽或不可重试 | 是 | 否 |
| `unknown` | 可能已送达但确认丢失 | 是 | 否（见下） |
| `cancelled` | 在 `send` 发出前取消 | 是 | 否 |

每条记录的 `max_attempts` 在入队时固定，重启后仍沿用该值；新的默认上限只影响新入队记录。

确认失败（`failed` / `retry_wait`）来自 transport 返回 `{ outcome: "failed", retryable }`。结果不明（`unknown`）来自超时、`send` 抛错、发送标记已写下但结果没能落盘、重启时仍为 `sending`、或取消发生在 `send` 已发出之后。

`unknown` **不会自动重试**，避免把“可能已送达”再发一次。`retryUnknown(eventId)` 是显式操作，仍使用同一条记录，但 **可能在 transport 侧重复送达**。这不是 exactly-once。

同来源按事件时间 `at`、再按入队序号排序。未完成的前一条（`queued` / `retry_wait` / `sending`）会挡住后一条，避免重试把故障/恢复顺序颠倒。不同来源互不阻塞。

## 失败窗口

单写者：同目录临时文件 + `rename`（复用 `alert-core` 的 `atomicWriteFile`）。rename/fsync 失败会保留旧文件，**不会** copyFile 覆盖，也**不会**把坏文件当成空队列后重发。

| 窗口 | 磁盘 | 行为 |
|---|---|---|
| 入队写入失败 | 旧文件 | 内存回滚，不入队 |
| 写下 `sending` 之前失败 | 仍为 `queued` / `retry_wait` | 不调用 `send` |
| 已写下 `sending`，`send` 前崩溃 | `sending` | 重启 → `unknown` |
| `send` 已调用，结果写入失败 | `sending` | 内存记 `unknown`；重启从磁盘恢复为 `unknown`，不自动再发 |
| 状态文件坏损 / 声称 exactly-once | 原文件不动 | 构造队列抛错，拒绝操作 |

本地 JSON 原子写 **不是** 断电耐久性证明，也不是 Windows 实机 `File.Replace` 验收。

## 最小 API

```js
import { replaySamples } from "../alert-core.mjs";
import { createDeliveryQueue, createFakeClock } from "./delivery-core.mjs";
import { createFakeTransport } from "./fake-transport.mjs";

const replay = replaySamples(samples, { config });
const queue = createDeliveryQueue({
  statePath: "/tmp/beian-delivery.json", // 必须是绝对路径
  clock: createFakeClock(),              // 可注入；默认 Date.now
  transport: createFakeTransport(),      // 省略则不发送
  config: { max_attempts: 3, backoff_ms: 1000, timeout_ms: 5000 },
});
queue.enqueueFromReplay(replay);
queue.tick();
queue.cancel(eventId);
queue.retryUnknown(eventId); // 可能重复送达
queue.snapshot();
```

可运行示例（fake transport，临时目录）：

```bash
node scripts/monitoring/delivery/example.mjs
```

`transport.send(payload, ctx)` 必须同步返回：

- `{ outcome: "confirmed" }`
- `{ outcome: "failed", retryable: true|false, code }`
- `{ outcome: "unknown", code }` 或 `{ outcome: "timeout" }`

`payload` 只有脱敏字段：`event_id` / `type` / `source` / `at` / `incident_id` / `title` / `body`。持久记录不保存凭据或原始响应。transport 的 code 只接受本地有限词表，其他值降为对应 outcome；对象和任意诊断文本不会原样落盘。超时由 transport 合作遵守 `ctx.deadline_at`；同步 `send` 卡住时本模块无法强杀。

主循环应定期调用 `tick()`。本模块不 sleep、不注册计划任务。

## 测试

本目录测试（不打网络、不读密钥）：

```bash
node --test scripts/monitoring/delivery/*.test.mjs
```

原有告警核心测试仍是：

```bash
node --test scripts/monitoring/*.test.mjs
```

后者不会自动包含本子目录。阈值、退避、超时默认只是本地候选，`production_default=false`。

## 明确未做

- 真实消息、飞书 webhook、产品 `notify.ts` / `FEISHU_*`
- 接收人与渠道配置、Windows 探测与部署
- 数据库、通用队列框架、新依赖
- 端到端 exactly-once、断电耐久、杭州/Windows 实机验收
- 修改 `alert-core.mjs`、`replay.mjs` 或父目录 README

根 knip 已登记 example 与本目录测试。
