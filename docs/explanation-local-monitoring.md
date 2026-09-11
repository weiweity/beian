# 本地监控为什么拆成四层

F02 的本地候选实现把采样、判断、投递和调度分开。这样公网失败不会被误报成某个 Windows 服务停止，发送结果不明时也不会为了“看起来成功”而自动重复发送；每一层都能用固定事实单独回归。

## 要解决的问题

服务观察、HTTP health 和消息投递的失败含义不同：PowerShell 超时说明“没有拿到服务事实”，HTTP 502 说明“拿到了公网错误响应”，transport 超时则说明“可能已经送达但确认丢失”。如果把它们压成一个布尔值，系统会把采样失败当停服，把公网故障当进程故障，或者在未知送达时重复通知。

## 处理路径

```text
Windows 服务 / 显式 HTTP URL
             │
             ▼
       probes（只读 facts）
             │  sample + reasons
             ▼
       alert-core（分类、去抖、恢复）
             │  event.id + 脱敏 draft
             ▼
       runner pending（核心与事件一次交接落盘）
             │
             ▼
       delivery（按来源排序、有限重试、结果不明）
             │
             ▼
       注入的 transport（当前只有 fake）
```

探测器不导入告警核心，也不发送消息。核心只消费已归一化的事实；投递器只消费核心事件和脱敏草稿；runner 只负责周期、锁和 pending 交接。当前 runner 默认没有探测 URL 和 transport。

## 为什么使用 pending 交接

runner 在一次原子写中保存“下一份核心状态 + 尚未入队的事件”，然后入队，再清空 pending。进程如果在中间退出，重启时只重交接 pending，不重新采样；投递层以核心已有的 `event.id` 去重。这个协议避免了最常见的“核心已前进但事件没入队”丢失窗口，同时承认它不是端到端 exactly-once。

## 取舍

- **未知结果不自动重试。** 这会牺牲部分可用性，但避免一个可能已送达的通知被再次发送。人工调用 `retryUnknown(eventId)` 仍可能重复送达。
- **同来源串行，不同来源并行。** 发送 Promise 未 settle 时同来源后续事件会等待；不同来源可以在同一 tick 并行，故障和恢复不会颠倒。
- **本地 JSON 原子写。** 它让状态文件在普通写入失败时保留旧版本，成本是不能宣称断电耐久或 Windows `File.Replace` 已验收。
- **默认关闭外部动作。** 没有默认公网 URL、通知渠道、计划任务或生产配置，代价是上线前仍需单独完成接收人、渠道、Windows 和现场验收。

## 没有采用的替代方式

- 不把公网 health 作为服务存活的代理，因为两者故障域不同。
- 不在 transport 内自行重试所有异常，因为调用方无法区分“确认失败”和“已发出但确认丢失”。
- 不把 runner 和 alert-core 合成一个常驻模块，因为这样会让采样、判断和持久交接难以分别回放。

## 相关资料

- [How to 运行本地监控合成回归](howto-local-monitoring.md)
- [监控脚本参考](../scripts/monitoring/README.md)
- [runner 持久交接参考](../scripts/monitoring/runner/README.md)
- [投递状态与 API 参考](../scripts/monitoring/delivery/README.md)
- [未完成事项](../TODOS.md)
