import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../../..");
export const WEB_ROOT = resolve(here, "../..");
export const UI_DIST = join(WEB_ROOT, "ui/dist");
export const UI_BRAND = join(WEB_ROOT, "ui/public/brand");
export const PYTHON_APP = join(WEB_ROOT, "backend");
export const PACKAGING = join(REPO_ROOT, "workers/packaging");

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = val;
  }
}

loadEnvFile(join(PYTHON_APP, ".env.secrets"));
loadEnvFile(join(PYTHON_APP, ".env.baidu"));
loadEnvFile(join(WEB_ROOT, ".env"));

export const PORT = Number(process.env.WB_PORT || 8787);
export const HOST = process.env.WB_HOST || "127.0.0.1";
export const DATA_DIR = resolve(process.env.WB_DATA_DIR || join(PYTHON_APP, "data"));
export const COOKIE = "wb_session";
export const PYTHON = process.env.WB_PYTHON || join(PYTHON_APP, ".venv/bin/python");

export function cookieSecure(): boolean {
  const base = (process.env.WB_PUBLIC_BASE || "https://www.jianghua.site").replace(/\/$/, "");
  return base.startsWith("https://");
}
