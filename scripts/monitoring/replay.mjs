#!/usr/bin/env node
/**
 * 用本地 JSON fixture 回放告警核心，输出脱敏草稿和结构化事件。
 * 不访问网络、不发送消息、不读取密钥。
 */
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALERT_CORE_EXACTLY_ONCE,
  ALERT_CORE_EXACTLY_ONCE_NOTE,
  atomicWriteFile,
  parseState,
  replaySamples,
  serializeState,
} from "./alert-core.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export function parseArgs(argv) {
  const options = {
    input: "",
    state: "",
    writeState: "",
    text: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--text") options.text = true;
    else if (arg === "--input" || arg === "--state" || arg === "--write-state") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 需要路径`);
      if (arg === "--input") options.input = value;
      else if (arg === "--state") options.state = value;
      else options.writeState = value;
      i += 1;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

export const HELP_TEXT = `beian 本地告警回放（F02 第一阶段）

用法：
  node scripts/monitoring/replay.mjs --input <fixture.json> [--state <state.json>] [--write-state <state.json>] [--text]

只读合成 JSON，输出结构化事件和脱敏草稿。不发送、不探测生产、不注册任务。
阈值若未写在 fixture.config 里，使用本地候选默认值，不是生产默认。
${ALERT_CORE_EXACTLY_ONCE_NOTE}
`;

function abs(path, cwd) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function loadFixture(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("fixture 不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("fixture 必须是对象");
  }
  if (!Array.isArray(parsed.samples)) throw new Error("fixture.samples 必须是数组");
  return parsed;
}

export function runReplay({ inputPath, statePath = "", writeStatePath = "", cwd = process.cwd() }) {
  const fixture = loadFixture(readFileSync(abs(inputPath, cwd), "utf8"));
  let stateText;
  let stateLoad = { missing: true, invalid: false, reason: "missing" };
  if (statePath) {
    const resolved = abs(statePath, cwd);
    if (existsSync(resolved)) {
      stateText = readFileSync(resolved, "utf8");
      stateLoad = parseState(stateText);
    }
  }
  const result = replaySamples(fixture.samples, {
    config: fixture.config,
    stateText,
  });
  if (writeStatePath) {
    atomicWriteFile(abs(writeStatePath, cwd), serializeState(result.state));
  }
  return {
    schema: "beian-alert-replay-v1",
    exactly_once: ALERT_CORE_EXACTLY_ONCE,
    notify: false,
    production_probe: false,
    ...result,
    state_load: {
      missing: stateLoad.missing,
      invalid: stateLoad.invalid,
      reason: stateLoad.reason,
    },
  };
}

export function main(argv = process.argv.slice(2), io = process) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    io.exitCode = 2;
    return 2;
  }
  if (options.help) {
    io.stdout.write(HELP_TEXT);
    return 0;
  }
  if (!options.input) {
    io.stderr.write("缺少 --input\n");
    io.exitCode = 2;
    return 2;
  }
  try {
    const result = runReplay({
      inputPath: options.input,
      statePath: options.state,
      writeStatePath: options.writeState,
    });
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (options.text) {
      const drafts = result.drafts || [];
      if (!drafts.length) io.stderr.write("无事件草稿\n");
      else {
        for (const draft of drafts) {
          io.stderr.write(`${draft.body}\n---\n`);
        }
      }
    }
    return 0;
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    io.exitCode = 2;
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) main();
