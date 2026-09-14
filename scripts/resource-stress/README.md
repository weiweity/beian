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

合成套件的 `behavior_passed` 单独判定：成功/排队须退出 0，预期失败须退出 7，取消须有实际取消和退出记录；所有场景都须有采样且没有 launch/sampler error。不符立即停组、退出 4，保留已产出的 metrics，不自动重试。**预期失败/取消的行为通过不等于预算有效**。工具源码也纳入身份，单轮前后身份变化会使 CLI 非零退出。

身份中的 `files` 来自 `--repo` 指定的被测产品树，`harness.directory/files` 则记录实际执行工具的目录及源码哈希；跨工作树调用不会拿目标树里的工具副本冒充执行工具。两组身份均参与前后与跨轮比较。

`run --repeat N`（1–100）仅用于非正式合成套件，输出根必须尚不存在，原子新建；每轮保留 `roundN/report.json` 和原始 metrics，失败后不开始后续轮。`aggregate.json` 记录各轮退出码、身份、报告/metrics 哈希，并只对成功轮按场景输出墙钟与树 RSS 的 min/median/max，失败轮不混入统计；没有 P95/P99、GPU 或正式预算含义。部分完成时 `behavior_passed=false`。`exclusive` 仍只输出计划。

## 命令

仓库根：

```bash
python3 scripts/resource-stress/cli.py identity --repo .
python3 scripts/resource-stress/cli.py preflight --process-snapshot-json /tmp/ps.json
python3 scripts/resource-stress/cli.py matrix
python3 scripts/resource-stress/cli.py plan --repo "$REPO" --out "$OUT"
python3 scripts/resource-stress/cli.py run --repo "$REPO" --out "$OUT" --mode synthetic-local
python3 -B scripts/resource-stress/cli.py run --repo "$REPO" --out "$NEW_OUT" --repeat 3
python3 scripts/resource-stress/cli.py run --repo "$REPO" --out "$OUT" --mode exclusive
python3 scripts/resource-stress/cli.py measure-command --repo "$REPO" --out "$OUT" --name demo -- \
  python3 scripts/resource-stress/synthetic_child.py --mode success --out "$OUT/demo"
```

`--out` 必须在仓库外。`--mode exclusive` 只持久化后续独占命令计划，不执行产品负载。`plan` 可用 `--python` / `--node` / `--npm` / `--tsx` / `--blender` 给出显式工具路径；相对路径按调用时工作目录绝对化，不跟随 venv 符号链接。`--scene ID` 只解析一个场景；`--strict` 在任一场景 refused 时退出 2。

## 后续独占运行（主 agent 串行，本轮不执行）

把 `{repo}` `{out}` `{python}` `{node}` `{tsx}` `{blender}` 换成独占窗口的工作树、证据目录和显式解释器。五个业务探针已在 `scripts/resource-stress/probes/`。`plan` 解析 argv，不执行。Blender 必须用 `--blender` 或环境变量 `BEIAN_BLENDER` 给出绝对可执行文件，禁止猜 `/Applications` 或因已安装而启动。先 `--formal-budget` 预检，有干扰就停。

覆盖映射见 `cli.py matrix`。对应 R04 项：

| R04 | 场景 id | 本轮 |
|---|---|---|
| 基线切面 | normal | 未跑，命令已映射 |
| 极端长宽比 | tall, wide | 未跑，命令已映射 |
| 最大像素 | near-cap, exact-cap-paper, over-cap | 未跑；32MP ≠ RSS |
| 双上传 | dual-upload | 未跑 |
| busy | illustrator-busy | 产品 L0（`jobs.test.ts`）模拟，非原生 |
| 串行 | blender-serial | 未跑，禁止本轮启动 Blender |
| 调灯 | relight | 产品 L0（`mockupStudio.test.ts`）模拟，非 GPU |
| drain | queue-drain | 未跑 |
| 失败/取消 | fail-cancel, failure-after-front | harness 合成已验；产品探针未跑 |

示例：

```bash
python3 scripts/resource-stress/cli.py measure-command \
  --repo "$REPO" --out "$OUT" --name near-cap --formal-budget --workload-kind product -- \
  "$PY" -B "$REPO/scripts/resource-stress/probes/face_probe.py" "$REPO" "$OUT/near-cap" near-cap
```

`over-cap` / `failure-after-front` 命中预期错误时探针 **exit 0**。必须核对 `result.json` 的 `case`、`expected_error` 与 `staging_left`；场景 id 不符（例如普通尺寸结果当成 near-cap）、错误类别不符、缺结果或清理失败不能判行为通过。预期拒绝、模拟上传/队列、Q05 观察和 L0 模拟不得变成有效预算。下层若声称 `budget_valid=true`，保留原始 metrics/result，失败关闭，不改写原件。32MP 是像素上限；budget-probe 的 32MiB 是历史入参，都不是当前产品默认内存预算（磁盘 4096MiB / 内存 8192MiB）。

## Q05 长期复用入口（另需确认采样窗口）

`q05_rounds.sh` / `q05_receipt.py` 从仓库外 2026-09-13 准备包收编，旧三轮原件不修改、不补盖新版本。预构建仍只能用 UI 的 `buildQ05ArtifactInto`，本工具不构建、不盖章、不删除产物，不替代该入口的校验。

批准窗口后，操作者提供以下显式路径（此示例本身不授权采样）：

```bash
Q05_WINDOW_CONFIRMED=1 \
Q05_WT="$REPO" Q05_PREBUILT="$PREBUILT" Q05_ROUNDS_PARENT="$NEW_OUT" \
sh scripts/resource-stress/q05_rounds.sh
```

- `Q05_WT`、`Q05_PREBUILT`、`Q05_ROUNDS_PARENT` 必须为绝对路径；输出不能在任何已登记 worktree 或预构建目录内。输出根和每轮目录均排他新建，拒绝续写旧轮。不要手工设置标记来冒充操作者确认；标记不是资源锁或独占证明。
- 默认三轮；`Q05_ROUND_COUNT` 可显式设为 1–100。默认单轮命令是 `q05_command.sh`：外层 measure-command 包两条既有 Playwright 长用例。`Q05_ROUND_CMD_FILE` 仅用于明确选择的替代命令/合成桩；只执行保存到当轮的命令副本。
- 开跑前检查干净工作树、HEAD、构建输入/锁与 sidecar/磁盘 manifest；前后及跨轮核对身份和工具字节。Python 的构建输入选择对应 `q05Artifact.ts`；该 SSOT 改动时必须同步检查本工具，不能只更新一侧。锁文件身份不证明 node_modules 实装树。
- 回执 schema v2 的 `gate.passed` 控制退出码；缺失/损坏、身份不符、11 阶段/6 样本数量不符、RSS 采样失败或夹带构建均不放行。非零即停、不重试；命令退出码与回执退出码分别保留。已有回执绝不覆盖。此门检查身份、存在性和计数，不是性能阈值评测器。
- cache 探针不可用（包括合法离页）仍记 `not_assessed`，不是自动证明释放。用例 A 自身无身份字段，仍只能由外层回执归属。命令墙钟/树 RSS 与用例内 CDP heap/rAF 分开，不是浏览器/GPU 精确峰值。
- 退出码：2 参数/未确认/输出边界；3 目录已存在；4 测量命令失败；5 预检/回执门失败。失败轮保留诊断；异常导致回执无法生成时，`receipt.err` 与 `receipt.exitcode` 为失败证据，不能宣称回执完整。
- 两条用例的 timeout 不是整条 shell 的硬超时；本工具没有新增总超时或跨平台杀树保证。Windows 原生仍未支持/验收。

五个业务探针已收编到仓库内。`measure.py` / `write_report.py` 由现有 `protocol.py`、`cli.py`、`evidence.py` 替代，不复制第二套采样器。`plan` 把 argv 解析与依赖评估分开记录：`argv_resolved` 表示占位符已填完。切面探针用所选 Python 做 `importlib.util.find_spec('pymupdf')` 轻量检查（不 import 产品、不启动 Blender）；缺 pymupdf 时这些场景 `ok=false` / `refused`。Node 场景缺 node/tsx、npm 场景缺 npm、`blender-serial` 缺显式 Blender 时同样 refused；`blender-serial` 不要求 pymupdf。`dependencies_assessed` 只覆盖这些门，不声称全部运行时依赖已验证。无法支持或本切片未授权的场景明确拒绝，不虚构全部可运行。`synthetic-local` 与 `--repeat` 仍只跑轻量合成子进程，不因矩阵接线启动产品负载。`measure-command` 在产品矩阵路径上核对运行前后产品与执行工具身份；漂移失败关闭，不回写原件。

| 历史文件 | 处置 |
|---|---|
| face_probe.py | 迁入 `probes/face_probe.py` |
| render_probe.py | 迁入 `probes/render_probe.py` |
| upload-probe.mjs | 迁入 `probes/upload-probe.mjs` |
| queue-probe.mjs | 迁入 `probes/queue-probe.mjs` |
| budget-probe.mjs | 迁入 `probes/budget-probe.mjs` |
| measure.py | 由 `protocol.py` / `cli.py` 替代 |
| write_report.py | 由 `protocol.render_report_md` / `evidence.py` 替代 |

## 测试

不依赖精确 RSS 或严格墙钟：

```bash
python3 -B -m unittest discover -s scripts/resource-stress -p 'test_*.py' -v
node --test scripts/resource-stress/test_probes.mjs scripts/resource-stress/test_ship_probes.mjs
```

合成 suite 覆盖成功 / 失败 / 取消 / 父进程 SIGTERM 收尾。只管理本工具创建的进程组。Node 测试核对仓库内探针 argv 与计划接线，不启动 Blender、浏览器压测或双 100MiB 上传。

整合补充：空运行、失败/取消或没有采样的运行一律不能标为有效预算。测量命令首进程退出后仍清理本工具创建的进程组（含忽略 SIGTERM 的组内后代）；主动逃离该进程组的后代、采样器被 SIGKILL 和 Windows Job Object 仍不在此证明范围。

单命令失败会保留原始退出码，并以非零 CLI 状态退出；信号退出映射为 128 + 信号编号。采样故障记录 measurement_errors，使预算无效。name 必须是单一路径分量，已存在的同名测量目录拒绝复用，避免覆盖原始证据。
