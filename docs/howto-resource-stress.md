# How to 运行 R04 资源采证合成回归

这份操作验证 R04 采证工具能记录身份、预检、进程树 RSS、磁盘变化、失败和取消；它不会启动 Blender、浏览器或 Illustrator，也不会生成正式资源预算。

## 前置条件

- 在仓库根目录执行命令。
- Python 3 可用。
- `--out` 指向仓库外的新目录。工具拒绝复用已有测量目录，避免覆盖证据。
- 正式独占测量需要另外批准的机器、工作树、fixture 和原生宿主，本页不执行那一步。

## 步骤

1. 记录仓库身份和工具版本。

   ```bash
   python3 scripts/resource-stress/cli.py identity --repo .
   ```

   身份不完整时命令退出码为 2；这表示不能冻结预算，不是工具失败后可以忽略的警告。

2. 做一次只读负载预检。

   ```bash
   python3 scripts/resource-stress/cli.py preflight
   ```

   预检会报告树外 Blender 或高 CPU 的渲染/压测进程。看到 foreign load 时，不要把该窗口的数据当成独占预算。

3. 查看 R04 场景矩阵。

   ```bash
   python3 scripts/resource-stress/cli.py matrix
   ```

   矩阵列出 tall、wide、near-cap、dual-upload、blender-serial、relight、queue-drain 和失败/取消等场景，以及哪些仍未在本机执行。

4. 运行轻量合成套件。

   ```bash
   OUT="/tmp/beian-r04-synthetic-$(date +%s)"
   python3 scripts/resource-stress/cli.py run \
     --repo . --out "$OUT" --mode synthetic-local
   ```

   套件会启动工具自己创建的合成子进程，保留成功、失败和取消的 metrics。合成 workload 始终让 `budget_valid=false`，不能用数字制定产品 RSS 或磁盘阈值。

5. 运行回归测试。

   ```bash
   python3 scripts/resource-stress/test_harness.py -v
   ```

## 验证

测试应退出码为 0。报告中的 `peak_tree_rss_bytes` 是采样到的进程树 RSS，可能重复计算共享页，也不是 GPU 或上屏时间；`32MP` 是单张图片像素上限，不是进程内存预算。正式预算必须同时满足完整身份、无外部负载、独占窗口、产品 workload 和有效采样。

## 故障排查

- 退出码 2：身份不完整。先补齐可复核的仓库/版本/fixture 身份，不要手工把报告标成有效。
- 退出码 3：正式预算预检发现干扰。结束或隔离外部压测后重新预检；不要按进程名 `pkill` 或 `killall`。
- 退出码 4：命令虽然结束，但运行失败、非独占、合成或采样不完整。保留报告并修正测量条件。
- 取消后仍有子进程：工具只管理自己通过 `start_new_session` 创建的进程组。主动逃离进程组的后代、父进程被 SIGKILL 和 Windows Job Object 不在本工具证明范围。

## 相关资料

- [资源采证参考](../scripts/resource-stress/README.md)
- [测试与验证](../TESTING.md)
- [R04 未完成事项](../TODOS.md#r04--切面与渲染资源压测)
