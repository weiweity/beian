#!/usr/bin/env node
/**
 * F02 只读探测单次入口。不发送、不调度、不读生产配置、无默认公网 URL。
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSample, DEFAULT_TIMEOUT_MS } from "./collect.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export function parseArgs(argv) {
  const options = {
    loopbackUrl: "",
    publicUrl: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    id: "",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--loopback-url" || arg === "--public-url" || arg === "--timeout-ms" || arg === "--id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 需要值`);
      if (arg === "--loopback-url") options.loopbackUrl = value;
      else if (arg === "--public-url") options.publicUrl = value;
      else if (arg === "--id") options.id = value;
      else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new Error("timeout-ms 必须是正整数");
        options.timeoutMs = n;
      }
      i += 1;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

export const HELP_TEXT = `beian 本地只读探测（F02 适配器）

用法：
  node scripts/monitoring/probes/cli.mjs [--loopback-url <url>] [--public-url <url>] [--timeout-ms <n>] [--id <id>]

单次采样 Windows 服务 beian-server-8787 / cloudflared。
HTTP health 仅在显式给出 URL 时探测；没有默认地址。
不发送消息、不注册计划任务、不读取生产配置。
`;

const VALIDATION_MESSAGES = Object.freeze({
  credentials_in_url: "URL 含凭据，已拒绝",
  loopback_as_public: "公网探测不能使用环回地址",
  public_as_loopback: "环回探测不能使用非环回地址",
  invalid_url: "URL 无效",
  invalid_timeout: "timeout-ms 必须是正整数",
  invalid_target: "探测目标无效",
});

function publicErrorMessage(err) {
  const code = err instanceof Error ? err.message : String(err);
  return VALIDATION_MESSAGES[code] || (code.startsWith("未知参数") || code.includes("需要值") || code.includes("正整数")
    ? code
    : "参数无效");
}

export async function main(argv = process.argv.slice(2), io = process) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`${publicErrorMessage(err)}\n`);
    io.exitCode = 2;
    return 2;
  }
  if (options.help) {
    io.stdout.write(HELP_TEXT);
    return 0;
  }
  try {
    const collected = await collectSample({
      loopbackUrl: options.loopbackUrl || undefined,
      publicUrl: options.publicUrl || undefined,
      timeoutMs: options.timeoutMs,
      id: options.id || undefined,
    });
    const payload = {
      ...(collected.sample.id ? { id: collected.sample.id } : {}),
      sampled_at: collected.sample.sampled_at,
      ...(Number.isInteger(collected.sample.sequence) ? { sequence: collected.sample.sequence } : {}),
      facts: collected.sample.facts,
    };
    if (collected.reasons && Object.keys(collected.reasons).length) payload.reasons = collected.reasons;
    io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  } catch (err) {
    io.stderr.write(`${publicErrorMessage(err)}\n`);
    io.exitCode = 2;
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((err) => {
    process.stderr.write(`${publicErrorMessage(err)}\n`);
    process.exitCode = 2;
  });
}
