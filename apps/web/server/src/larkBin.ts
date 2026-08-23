import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Hangzhou scheduled-task PATH is thin. Look beyond `where lark-cli`. */
export function whichLark(): string | null {
  const names = process.platform === "win32" ? ["lark-cli.cmd", "lark-cli.exe", "lark-cli"] : ["lark-cli"];
  const finder = process.platform === "win32" ? "where" : "which";
  for (const name of names) {
    try {
      const out = execFileSync(finder, [name], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
      if (out && existsSync(out)) return out;
    } catch {
      /* next */
    }
  }
  const extra =
    process.platform === "win32"
      ? [
          join(process.env.APPDATA || "", "npm", "lark-cli.cmd"),
          join(process.env.LOCALAPPDATA || "", "npm", "lark-cli.cmd"),
          join(homedir(), "AppData", "Roaming", "npm", "lark-cli.cmd"),
        ]
      : [join(homedir(), ".local", "bin", "lark-cli"), "/opt/homebrew/bin/lark-cli", "/usr/local/bin/lark-cli"];
  for (const p of extra) {
    if (p && existsSync(p)) return p;
  }
  return null;
}
