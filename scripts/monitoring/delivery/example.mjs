#!/usr/bin/env node
/**
 * 主 agent 可直接接入的最小调用示例。
 * 使用告警核心生成的事件 + 本地 fake transport，不发送真实消息。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { replaySamples } from "../alert-core.mjs";
import { createDeliveryQueue, createFakeClock, DELIVERY_EXACTLY_ONCE_NOTE } from "./delivery-core.mjs";
import { createFakeTransport } from "./fake-transport.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const here = dirname(SCRIPT_PATH);

export const EXAMPLE_HELP = `beian 本地告警投递示例（F02 第二阶段）

用法：
  node scripts/monitoring/delivery/example.mjs

只读回放 scripts/monitoring/fixtures/recovery.json，入队后用 fake transport 确认。
不访问网络、不读密钥、不选择飞书或其他真实渠道。
${DELIVERY_EXACTLY_ONCE_NOTE}
`;

export function runExample({ cwd = process.cwd(), fixtureName = "recovery.json" } = {}) {
  const fixturePath = resolve(here, "..", "fixtures", fixtureName);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const replay = replaySamples(fixture.samples, { config: fixture.config });
  const dir = mkdtempSync(join(tmpdir(), "beian-delivery-example-"));
  const clock = createFakeClock(Date.parse("2026-09-09T04:02:00.000Z"));
  const transport = createFakeTransport();
  const queue = createDeliveryQueue({
    statePath: join(dir, "delivery.json"),
    clock,
    transport,
  });
  const enqueued = queue.enqueueFromReplay(replay);
  const firstTick = queue.tick();
  return {
    schema: "beian-delivery-example-v1",
    cwd,
    fixture: fixtureName,
    events: replay.events.map((event) => ({ id: event.id, type: event.type, source: event.source })),
    enqueued,
    tick: firstTick,
    snapshot: queue.snapshot(),
    transport_calls: transport.calls.length,
    notify: false,
    production_send: false,
    exactly_once: false,
  };
}

export function main(argv = process.argv.slice(2), io = process) {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout.write(EXAMPLE_HELP);
    return 0;
  }
  if (argv.length) {
    io.stderr.write(`未知参数：${argv.join(" ")}\n`);
    io.exitCode = 2;
    return 2;
  }
  const result = runExample();
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) main();
