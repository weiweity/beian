# R04 可重复资源采证工具

本目录把 2026-09-08 的压测采证协议收成可重复 CLI。它测量调用方显式指定的命令、记录身份/干扰/采样，**不是**产品质量评测器。默认合成套件和 exclusive 计划模式不启动 Blender、浏览器或 Illustrator；measure-command 会执行所提供的命令，原生负载须另有授权。

本轮只跑轻量合成子进程。正式独占测量由主 agent 后续串行安排。

## 不是什么

- 不冻结内存/磁盘/超时预算，不改产品限制
- 不重写 R01 队列或 Q05 生命周期
- 采样峰值不是绝对峰值；树 RSS 相加可能重复计共享页
- `32MP`（`MAX_FACE_PIXELS`）是单图像素上限，不是进程内存预算
- 0 条 foreign 告警 ≠ 机器独占
- Mac 上只回收本工具 `start_new_session` 创建的进程组；**不是** Windows Job Object 验证
- 不按进程名 `pkill` / `killall`

## 测量协议（复用 2026-09-08）

- `ps -axo pid=,ppid=,rss=,pcpu=,comm=`，约 200ms 一轮
- 进程树 RSS、输出目录逻辑/分配字节、命令退出码
- foreign：树外 Blender，或 CPU>50 的 python/node/chrome/illustrator；可选 `command` 文本识别其它 harness
- 排队/运行时间只在 workload 写出 `timing.json` 时记为 observed，否则 `unavailable`
- 空闲内存、磁盘只从 `statvfs` / `SC_AVPHYS_PAGES` 等真实事实读取；读不到就 `unavailable`，不用总内存冒充 headroom。这些是系统空闲量，不是作业预留量；当前不采集产品预留事实。

## 有效预算

同时满足才可能 `budget_valid=true`：身份完整、预检无渲染/压测负载、运行中无干扰、独占、产品 workload。缺一不可。合成模式永远不能产出有效预算。

身份缺失或预检有干扰时，`--formal-budget` 拒绝测量并仍写出报告，退出码 2（身份）或 3（干扰）。跑完仍无效则退出 4。

## 命令

仓库根：

```bash
python3 scripts/resource-stress/cli.py identity --repo .
python3 scripts/resource-stress/cli.py preflight --process-snapshot-json /tmp/ps.json
python3 scripts/resource-stress/cli.py matrix
python3 scripts/resource-stress/cli.py run --repo "$REPO" --out "$OUT" --mode synthetic-local
python3 scripts/resource-stress/cli.py run --repo "$REPO" --out "$OUT" --mode exclusive
python3 scripts/resource-stress/cli.py measure-command --repo "$REPO" --out "$OUT" --name demo -- \
  python3 scripts/resource-stress/synthetic_child.py --mode success --out "$OUT/demo"
```

`--out` 必须在仓库外。`--mode exclusive` 只持久化后续独占命令计划，不执行产品负载。

## 后续独占运行（主 agent 串行，本轮不执行）

把 `{repo}` `{out}` `{python}` `{probe}` 换成独占窗口的工作树、证据目录、venv python，以及 2026-09-08 探针副本。先 `--formal-budget` 预检，有干扰就停。

覆盖映射见 `cli.py matrix`。对应 R04 项：

| R04 | 场景 id | 本轮 |
|---|---|---|
| 极端长宽比 | tall, wide | 未跑，命令已映射 |
| 最大像素 | near-cap, exact-cap-paper, over-cap | 未跑；32MP ≠ RSS |
| 双上传 | dual-upload | 未跑 |
| busy | illustrator-busy | 产品 L0 模拟，非原生 |
| 串行 | blender-serial | 未跑，禁止本轮启动 Blender |
| 调灯 | relight | 产品 L0 模拟，非 GPU |
| drain | queue-drain | 未跑 |
| 失败/取消 | fail-cancel, failure-after-front | harness 合成已验；产品探针未跑 |

示例：

```bash
python3 scripts/resource-stress/cli.py measure-command \
  --repo "$REPO" --out "$OUT" --name near-cap --formal-budget --workload-kind product -- \
  "$PY" "$PROBE/face_probe.py" "$REPO" "$OUT/near-cap" near-cap
```

## 测试

不依赖精确 RSS 或严格墙钟：

```bash
python3 scripts/resource-stress/test_harness.py -v
```

合成 suite 覆盖成功 / 失败 / 取消 / 父进程 SIGTERM 收尾。只管理本工具创建的进程组。

整合补充：空运行、失败/取消或没有采样的运行一律不能标为有效预算。测量命令首进程退出后仍清理本工具创建的进程组（含忽略 SIGTERM 的组内后代）；主动逃离该进程组的后代、采样器被 SIGKILL 和 Windows Job Object 仍不在此证明范围。

单命令失败会保留原始退出码，并以非零 CLI 状态退出；信号退出映射为 128 + 信号编号。采样故障记录 measurement_errors，使预算无效。name 必须是单一路径分量，已存在的同名测量目录拒绝复用，避免覆盖原始证据。
