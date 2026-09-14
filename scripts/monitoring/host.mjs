#!/usr/bin/env node
/**
 * F02 杭州托管入口：显式路径装配探测、循环和飞书 bot transport。
 * 不读产品 settings / FEISHU_*，不改 Illustrator，不停 beian-server-8787。
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMonitoringConfig } from "./config/load-config.mjs";
import { createDeliveryQueue } from "./delivery/delivery-core.mjs";
import {
  createFeishuBotTransport,
  createFeishuHttpTransport,
  createLarkCliExec,
} from "./delivery/feishu-bot-transport.mjs";
import { createLocalMonitor } from "./runner/runner-core.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const IDENTITY_SCHEMA = "beian-monitor-identity-v1";
const RECEIVE_ID = /^ou_[a-z0-9]+$/i;
const FORBIDDEN_BASENAME = /^(settings\.json|settings\.secrets\.json|\.env.*)$/i;

export const HOST_HELP = `beian 监控托管（F02）

用法：
  node scripts/monitoring/host.mjs --state-dir <abs> --identity <abs> --loopback-url <url> --public-url <url> [--config <abs>] [--once]

state-dir / identity / config 必须是仓库外绝对路径。
identity.allowRealSend 不是 true 时只入队不发送。
不读产品 FEISHU_*，不停生产服务，不改 Illustrator。
`;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseHostArgs(argv) {
  const options = {
    stateDir: "",
    identityPath: "",
    configPath: "",
    loopbackUrl: "",
    publicUrl: "",
    once: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--once") options.once = true;
    else if (
      arg === "--state-dir"
      || arg === "--identity"
      || arg === "--config"
      || arg === "--loopback-url"
      || arg === "--public-url"
    ) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 需要值`);
      if (arg === "--state-dir") options.stateDir = value;
      else if (arg === "--identity") options.identityPath = value;
      else if (arg === "--config") options.configPath = value;
      else if (arg === "--loopback-url") options.loopbackUrl = value;
      else options.publicUrl = value;
      i += 1;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function assertOutsideRepo(path, repoRoot) {
  const resolved = resolve(path);
  const root = resolve(repoRoot);
  if (resolved === root || resolved.startsWith(`${root}/`) || resolved.startsWith(`${root}\\`)) {
    throw new Error("state, identity and config must be outside the git checkout");
  }
}

export function stripUtfBom(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  if (text.charCodeAt(0) === 0xFEFF) return text.slice(1);
  return text;
}

export function decodeTextFile(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.subarray(3).toString("utf8");
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.subarray(2).toString("utf16le");
  }
  return stripUtfBom(buf.toString("utf8"));
}

export function parseJsonFile(path) {
  try {
    return JSON.parse(decodeTextFile(readFileSync(path)));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`invalid JSON in ${path}: ${err.message}`);
    }
    throw err;
  }
}

function writeHostError(stateDir, err) {
  if (!stateDir || !isAbsolute(stateDir)) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "host-error.json"), `${JSON.stringify({
      at: new Date().toISOString(),
      message: err instanceof Error ? err.message : String(err),
    }, null, 2)}\n`);
  } catch {
    // Best-effort only; startup errors still go to stderr.
  }
}

export function loadMonitorIdentity(path, { repoRoot } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new Error("identity path must be absolute");
  }
  if (FORBIDDEN_BASENAME.test(basename(path))) {
    throw new Error("identity must not be product settings");
  }
  if (repoRoot) assertOutsideRepo(path, repoRoot);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("identity is not a file");
  const raw = parseJsonFile(path);
  if (!isPlainObject(raw) || raw.schema !== IDENTITY_SCHEMA) {
    throw new Error("identity schema must be beian-monitor-identity-v1");
  }
  if (typeof raw.receiveId !== "string" || !RECEIVE_ID.test(raw.receiveId)) {
    throw new Error("identity.receiveId must be an ou_ open_id");
  }
  const identity = {
    receiveId: raw.receiveId,
    allowRealSend: raw.allowRealSend === true,
    cliPath: typeof raw.cliPath === "string" ? raw.cliPath : "",
    appId: typeof raw.appId === "string" ? raw.appId : "",
    appSecret: typeof raw.appSecret === "string" ? raw.appSecret : "",
  };
  if (identity.cliPath && !isAbsolute(identity.cliPath)) {
    throw new Error("identity.cliPath must be absolute when set");
  }
  return identity;
}

export function defaultPostJson(url, { body, headers, signal, accessToken } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const target = new URL(url);
    const req = httpsRequest({
      protocol: target.protocol,
      hostname: target.hostname,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...(headers || {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) {
        req.destroy(Object.assign(new Error("cancelled"), { reason: "cancelled" }));
        return;
      }
      signal.addEventListener("abort", () => {
        req.destroy(Object.assign(new Error("cancelled"), { reason: "cancelled" }));
      }, { once: true });
    }
    req.write(payload);
    req.end();
  });
}

export function createHostTransport(identity, { exec, postJson } = {}) {
  if (!identity.allowRealSend) return null;
  if (identity.cliPath) {
    return createFeishuBotTransport({
      cliPath: identity.cliPath,
      receiveId: identity.receiveId,
      exec: exec || createLarkCliExec({ allowRealSend: true }),
    });
  }
  if (identity.appId && identity.appSecret) {
    return createFeishuHttpTransport({
      receiveId: identity.receiveId,
      appId: identity.appId,
      appSecret: identity.appSecret,
      postJson: postJson || defaultPostJson,
    });
  }
  throw new Error("allowRealSend requires identity.cliPath or appId/appSecret");
}

export function assembleHost(options) {
  const {
    stateDir,
    identityPath,
    configPath,
    loopbackUrl,
    publicUrl,
    repoRoot,
    sampler,
    exec,
    postJson,
    platform,
  } = options;
  if (!stateDir || !isAbsolute(stateDir)) throw new Error("stateDir must be absolute");
  if (repoRoot) {
    assertOutsideRepo(stateDir, repoRoot);
    if (configPath) assertOutsideRepo(configPath, repoRoot);
  }
  if (!loopbackUrl || !publicUrl) throw new Error("loopback-url and public-url are required");
  const identity = loadMonitorIdentity(identityPath, { repoRoot });
  const loaded = configPath ? loadMonitoringConfig(configPath) : null;
  const transport = createHostTransport(identity, { exec, postJson });
  const runner = createLocalMonitor({
    stateDir,
    transport,
    sampler,
    platform,
    probe: { loopbackUrl, publicUrl },
    config: loaded ? { ...loaded.runner, ...loaded.alert } : undefined,
    createQueue: ({ statePath, clock, transport: nextTransport }) => createDeliveryQueue({
      statePath,
      clock,
      transport: nextTransport,
      config: loaded ? loaded.delivery : undefined,
    }),
  });
  return {
    runner,
    transport,
    identity: {
      receiveId: identity.receiveId,
      allowRealSend: identity.allowRealSend,
      hasCli: Boolean(identity.cliPath),
      hasApp: Boolean(identity.appId),
    },
  };
}

export async function runHost(args, { repoRoot, sampler, exec, postJson, platform, io = process } = {}) {
  if (args.help) {
    io.stdout.write(HOST_HELP);
    return { code: 0 };
  }
  if (!args.stateDir || !args.identityPath || !args.loopbackUrl || !args.publicUrl) {
    throw new Error("state-dir, identity, loopback-url and public-url are required");
  }
  const assembled = assembleHost({
    stateDir: args.stateDir,
    identityPath: args.identityPath,
    configPath: args.configPath || "",
    loopbackUrl: args.loopbackUrl,
    publicUrl: args.publicUrl,
    repoRoot,
    sampler,
    exec,
    postJson,
    platform,
  });
  await assembled.runner.start({ schedule: !args.once });
  if (args.once) {
    const cycle = await assembled.runner.runCycle();
    await assembled.runner.stop();
    return { code: 0, cycle, identity: assembled.identity, sending: Boolean(assembled.transport) };
  }
  return { code: 0, runner: assembled.runner, identity: assembled.identity, sending: Boolean(assembled.transport) };
}

export async function main(argv = process.argv.slice(2), io = process) {
  let args;
  try {
    args = parseHostArgs(argv);
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    io.exitCode = 2;
    return 2;
  }
  try {
    const repoRoot = resolve(SCRIPT_PATH, "../../..");
    const result = await runHost(args, { repoRoot, io });
    if (args.once) {
      io.stdout.write(`${JSON.stringify({
        schema: "beian-monitor-host-once-v1",
        sending: result.sending,
        allowRealSend: result.identity.allowRealSend,
        cycle: result.cycle,
      }, null, 2)}\n`);
    }
    return result.code;
  } catch (err) {
    writeHostError(args?.stateDir, err);
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    io.exitCode = 2;
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().then((code) => {
    if (code) process.exitCode = code;
  });
}
