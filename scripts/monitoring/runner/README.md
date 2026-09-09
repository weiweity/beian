# 本地监控循环协调器（F02 调度切片）

把只读探测、告警核心和本地投递串成可测试的常驻循环：采样 → 核心判断 → 持久交接 → `enqueueFromReplay` → `await queue.tick()`。

本目录不判断告警、不实现投递、不探测生产、不发送消息。默认无 transport、无环回/公网 URL。时间、定时器、采样器和队列都可注入。

## 合同口径

- 共享接口保持可用：`createDeliveryQueue({ statePath, transport?, ... })`，`enqueueFromReplay(replay)` 仍是同步持久入队；成功返回前投递层已落盘。
- 一律 `await queue.tick()`，兼容同步与 Promise 实现。
- 不读取、不修改 delivery 私有状态文件，不依赖其内部字段。
- 保留核心 `event.id`（`type:source:sampled_at`）和 replay 事件格式。重复交接由该 id 在投递层去重。
- 默认 fixture/fake。不读密钥，不选飞书，不注册计划任务或 WinSW。

## 持久交接协议

协调器自己的状态在 `{stateDir}/runner.json`，与 delivery 文件分开。有事件时采用 outbox：

1. **采样**（可取消）。采样失败或被 stop 取消：不 ingest，核心不推进。
2. **核心 ingest 只发生在内存**。
3. **交接落盘**：一次原子写 `{ core: 下一状态, pending: { events, drafts } }`。这是核心推进的唯一提交点。写失败保留旧文件，内存回滚。
4. **入队**：`queue.enqueueFromReplay({ events, drafts })`。
5. **确认交接**：再一次原子写，把 `pending.events` 清空。
6. **`await queue.tick()`** 推进投递。tick 失败不影响已确认或仍待交接的事件身份。

无事件的周期把核心计数与空 pending 一次写完，然后 tick。

重启时若 `pending.events` 非空：先按原事件再交接，再 tick，不重放该次采样。

### 崩溃窗口

| 窗口 | 磁盘 | 恢复 |
|---|---|---|
| W1 交接写盘前 | 旧 runner 状态；核心未推进 | 条件仍在则可再次采样。同一 `sampled_at` 会得到同一 `event.id` |
| W2 交接已写、尚未入队 | `pending` 持有完整事件；核心已推进 | 重启只交接 pending，不采样 |
| W3 已入队、尚未确认交接 | `pending` 仍在；投递层已有该 `event.id` | 再交接；投递层按 id 去重后确认清空 pending |
| W4 交接写入失败 | 旧文件不动 | 不推进核心，不丢已落盘事实 |
| W5 确认写入失败 | pending 仍在；投递可能已有记录 | 同 W3 |
| 坏状态 / `exactly_once: true` / 禁止字段 | 原文件不动 | 构造协调器抛错，**不会**清空后继续 |

这不是 exactly-once，也不是断电耐久或 Windows `File.Replace` 证明。进程崩溃模拟 ≠ 断电。

## 采样与停止

- 同时只跑一个采样周期。周期未结束时再次 `runCycle` / 定时器触发返回 `skipped: "overlap"`，不启动新采样。
- 下一轮定时器只在本轮结束后安排，避免重叠。
- `stop({ timeoutMs: 1000 })`：立刻不再安排新采样；若正在采样则 abort；若采样已返回则把当前交接做完；当前周期失败时保留磁盘 pending，不在 stop 里清空。等待超限返回 `status: "stopping", lock_held: true`，旧操作结束后才释放锁；不响应取消的操作不能被误报已停止，也不能让新实例接管。
- 默认 `interval_ms=30000`，`first_delay_ms=0`，只是本地候选，`production_default=false`。

## 单实例

同一 `stateDir` 用 `{stateDir}/runner.lock`。重复 start 抛 `RunnerLockError`，不会静默并写。锁内 pid 仍存活则拒绝；pid 已死才允许接管并恢复 pending。锁文件本身坏损也拒绝，不删除后继续。接管过程由独占 `runner.lock.acquire` 串行保护；进程若在接管中崩溃留下该文件，后续启动会拒绝，需确认无活动拥有者后另行恢复，不自动删除。获取主锁后重新读取 runner 状态，避免构造实例时的旧快照覆盖新事实。

## 最小 API

```js
import { createFakeTransport } from "../delivery/fake-transport.mjs";
import {
  createFakeClock,
  createFixtureSampler,
  createLocalMonitor,
  createManualScheduler,
} from "./runner-core.mjs";

const runner = createLocalMonitor({
  stateDir,                 // 绝对路径
  clock: createFakeClock(),
  scheduler: createManualScheduler(),
  sampler: createFixtureSampler(samples),
  transport: createFakeTransport(), // 省略则只入队不发送
  config: { fail_threshold: 1, interval_ms: 1000 },
});
await runner.start({ schedule: false });
await runner.runCycle();
await runner.stop();
```

可运行示例：

```bash
node scripts/monitoring/runner/example.mjs
```

## 测试

不打网络、不读密钥、不发真实消息：

```bash
node --test scripts/monitoring/runner/*.test.mjs
```

原有核心 / 探测 / 投递测试仍是各自 glob；父级 `scripts/monitoring/*.test.mjs` **不会**自动包含本目录。

## 明确未做

- 飞书或其他真实渠道、接收人配置
- Windows 计划任务 / WinSW / 杭州实机探测
- 修改 `alert-core`、`replay`、`probes`、`delivery` 或现有共享测试
- 端到端 exactly-once、断电耐久、生产默认

## 测试入口

已由主工作树整合 knip / TESTING：

- `knip.json` workspace `"."` 的 `entry` 增加：
  - `scripts/monitoring/runner/example.mjs!`
  - `scripts/monitoring/runner/*.test.mjs`
- TESTING 本地运维命令把 `scripts/monitoring/runner/*.test.mjs` 加进 F02 glob
- 父 `scripts/monitoring/README.md` 增加本目录链接

不要改 dead-code baseline、TODOS、VERSION 或 package 文件。
