#!/usr/bin/env node
/**
 * 本地循环协调器最小示例。fixture 采样 + fake transport，不访问网络、不发真实消息。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeTransport } from "../delivery/fake-transport.mjs";
import {
  RUNNER_EXACTLY_ONCE_NOTE,
  createFakeClock,
  createFixtureSampler,
  createLocalMonitor,
  createManualScheduler,
} from "./runner-core.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const here = dirname(SCRIPT_PATH);

export const EXAMPLE_HELP = `beian 本地监控协调器示例（F02 调度切片）

用法：
  node scripts/monitoring/runner/example.mjs

只读回放 scripts/monitoring/fixtures/down.json，用注入时钟/定时器跑完采样周期。
默认 fake transport，不访问网络、不读密钥、不选择飞书或其他真实渠道。
${RUNNER_EXACTLY_ONCE_NOTE}
`;

export async function runExample({ cwd = process.cwd(), fixtureName = "down.json" } = {}) {
  const fixturePath = resolve(here, "..", "fixtures", fixtureName);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "beian-runner-example-"));
  const clock = createFakeClock(Date.parse("2026-09-09T01:00:00.000Z"));
  const scheduler = createManualScheduler();
  const sampler = createFixtureSampler(fixture.samples);
  const transport = createFakeTransport();
  const runner = createLocalMonitor({
    stateDir: dir,
    clock,
    scheduler,
    sampler,
    transport,
    config: {
      ...fixture.config,
      interval_ms: 1000,
      first_delay_ms: 0,
    },
  });
  await runner.start({ schedule: false });
  const cycles = [];
  for (let i = 0; i < fixture.samples.length; i += 1) {
    cycles.push(await runner.runCycle());
  }
  const stopped = await runner.stop();
  return {
    schema: "beian-monitor-runner-example-v1",
    cwd,
    fixture: fixtureName,
    cycles,
    pending_event_ids: runner.snapshot().pending_event_ids,
    delivery: runner.deliverySnapshot().items.map((item) => ({
      event_id: item.event_id,
      type: item.type,
      source: item.source,
      status: item.status,
    })),
    transport_calls: transport.calls.length,
    sampler_calls: sampler.calls.length,
    stopped,
    notify: false,
    production_send: false,
    exactly_once: false,
  };
}

export async function main(argv = process.argv.slice(2), io = process) {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout.write(EXAMPLE_HELP);
    return 0;
  }
  if (argv.length) {
    io.stderr.write(`未知参数：${argv.join(" ")}\n`);
    io.exitCode = 2;
    return 2;
  }
  const result = await runExample();
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().then((code) => {
    if (code) process.exitCode = code;
  });
}
