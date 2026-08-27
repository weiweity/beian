import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { illustratorBin } from "./settings.js";

export type RasterResult = { ok: boolean; png?: string; message: string };

/** Illustrator 保存且勾选“创建 PDF 兼容文件”的 AI，可直接交给现有 PDF/刀线流水线。 */
export function isPdfCompatibleAi(source: string): boolean {
  if (!/\.ai$/i.test(source || "")) return false;
  let fd: number | undefined;
  try {
    fd = openSync(source, "r");
    const magic = Buffer.alloc(5);
    return readSync(fd, magic, 0, magic.length, 0) === magic.length && magic.toString("ascii") === "%PDF-";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function assertIllustratorReady(): string {
  const p = illustratorBin();
  if (!p || !existsSync(p)) {
    throw Object.assign(new Error("没扫到 Illustrator。.ai 不会当 PDF 吃进去。请到开工板扫描这台电脑。"), {
      status: 412,
    });
  }
  return p;
}

function lastJson(stdout: string): RasterResult | null {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const last = lines[lines.length - 1] || "";
  try {
    const parsed = JSON.parse(last) as RasterResult;
    if (typeof parsed.ok === "boolean") return parsed;
  } catch {
    /* not json */
  }
  return null;
}

/** 假 COM：子进程最后一行 JSON。真 Windows COM 本波不做。 */
export function rasterAiFile(opts: {
  source: string;
  outDir: string;
  timeoutMs?: number;
}): Promise<RasterResult> {
  mkdirSync(opts.outDir, { recursive: true });
  const bin = process.execPath;
  const script = `
    const fs = require('fs');
    const path = require('path');
    const src = process.argv[1];
    const dir = process.argv[2];
    if (!src || src.endsWith('.fail.ai')) {
      process.stdout.write(JSON.stringify({ ok: false, message: 'COM 被拒绝或文件打不开' }) + '\\n');
      process.exit(2);
    }
    const png = path.join(dir, 'ai-raster.png');
    fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
    process.stdout.write(JSON.stringify({ ok: true, png, message: '假 COM 已导出 PNG' }) + '\\n');
  `;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return new Promise((resolve) => {
    const child = spawn(bin, ["-e", script, opts.source, opts.outDir], {
      timeout: timeoutMs,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => resolve({ ok: false, message: err.message || "转图失败" }));
    child.on("close", () => {
      const parsed = lastJson(stdout);
      if (parsed) {
        resolve(parsed);
        return;
      }
      resolve({ ok: false, message: stderr.trim() || "转图失败，最后一行不是 JSON" });
    });
  });
}

export function writePlaceholderPng(dir: string): string {
  const png = join(dir, "ai-raster.png");
  writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));
  return png;
}
