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
