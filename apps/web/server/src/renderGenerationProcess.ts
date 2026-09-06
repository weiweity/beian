import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** This bridge starts a detached POSIX group; the current Python/Blender path
 * inherits that group. This is not containment for children that call setsid().
 * Windows needs an owned Job Object before this bridge can be enabled there.
 */
export type RenderGenerationGroupState = "present" | "missing" | "unknown";

export function renderGenerationProcessSupported(platform = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/** A parent PID being missing is insufficient. Only group ESRCH proves absence.
 * Present is NOT ownership: never use this probe alone to authorize a signal.
 */
export function inspectRenderGenerationGroup(
  pid: number,
  runtime: Pick<NodeJS.Process, "platform" | "kill"> = process,
): RenderGenerationGroupState {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !renderGenerationProcessSupported(runtime.platform)) return "unknown";
  try {
    runtime.kill(-pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ESRCH" ? "missing" : "unknown";
  }
}

/** Caller must freshly prove the exact generation parent's ownership first.
 * No fallback to a standalone/reused PID, and no Windows taskkill assumption.
 */
export function signalRenderGenerationGroup(pid: number, force = false): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !renderGenerationProcessSupported()) {
    throw new Error("render_generation_group_unsupported");
  }
  process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
}

/** Named native Job Object recovery is available even with creation disabled.
 * Caller must also establish the old supervisor is gone; job absence alone
 * cannot release a supervisor that has not created its container yet.
 */
export function recoverWindowsRenderGeneration(executionId: string, options: {
  pythonExecutable: string; packagingDir: string; cancel?: boolean;
}): RenderGenerationGroupState {
  if (process.platform !== "win32" || !/^[a-zA-Z0-9_-]{1,96}:[a-zA-Z0-9_-]{1,96}:[a-f0-9]{32}$/.test(executionId)) return "unknown";
  try {
    const output = execFileSync(options.pythonExecutable, [join(options.packagingDir, "windows_render_supervisor.py"),
      options.cancel ? "--cancel-owned" : "--recover", executionId], {
      encoding:"utf8",timeout:5000,maxBuffer:4096,windowsHide:true,stdio:["ignore","pipe","ignore"],
    });
    const result = JSON.parse(output.trim());
    if (result.schema !== "render-job-recovery/1" || result.execution_id !== executionId
      || !["present","missing","unknown"].includes(result.state)) return "unknown";
    return result.state;
  } catch { return "unknown"; }
}
