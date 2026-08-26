import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 创建只属于当前测试进程的临时目录。
 *
 * HTTP 测试会故意留下不结算的后台作业来证明接口立即返回，所以不能在文件级
 * after 中立刻删数据。创建时就登记进程退出清理，测试失败时也不会漏掉；等事件
 * 循环真正结束后再精确删除，不与后台作业争用目录。
 */
export function makeTestTempDir(prefix: `beian-${string}`): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.once("exit", () => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
