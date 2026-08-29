import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";
import {
  ILLUSTRATOR_AGENT_PROTOCOL,
  ILLUSTRATOR_AGENT_PIPE,
  ILLUSTRATOR_AGENT_RELEASE_VERSION,
  ILLUSTRATOR_AGENT_SCRIPT_SHA256,
  assertIllustratorAgentReady,
  publicIllustratorAgentStatus,
  readIllustratorAgentStatus,
} from "./illustratorAgent.js";

describe("Illustrator desktop agent heartbeat", () => {
  it("does not change the existing macOS AppleScript path", () => {
    const status = readIllustratorAgentStatus({ platform: "darwin" });
    assert.equal(status.required, false);
    assert.equal(status.ready, true);
    assert.equal(status.mode, "native");
  });

  it("fails closed when the Windows Session 1 agent is missing", () => {
    const path = join(makeTestTempDir("beian-agent-missing-"), "missing.json");
    const status = readIllustratorAgentStatus({ platform: "win32", heartbeatPath: path });
    assert.equal(status.ready, false);
    assert.equal(status.state, "offline");
    assert.throws(() => assertIllustratorAgentReady(status), /登录杭州电脑/);
  });

  it("accepts only a fresh heartbeat from an interactive session", () => {
    const dir = makeTestTempDir("beian-agent-ready-");
    const path = join(dir, "runtime", "illustrator-agent.json");
    mkdirSync(join(dir, "runtime"), { recursive: true });
    const now = Date.parse("2026-08-28T02:00:10.000Z");
    writeFileSync(path, JSON.stringify({
      protocol: ILLUSTRATOR_AGENT_PROTOCOL,
      pid: 24068,
      session_id: 1,
      user: "HANGZHOU\\Administrator",
      user_sid: "S-1-5-21-1000-500",
      pipe: ILLUSTRATOR_AGENT_PIPE,
      state: "idle",
      updated_at: "2026-08-28T02:00:05.000Z",
      script_sha256: ILLUSTRATOR_AGENT_SCRIPT_SHA256,
      release_version: ILLUSTRATOR_AGENT_RELEASE_VERSION,
    }));
    const status = readIllustratorAgentStatus({ platform: "win32", heartbeatPath: path, nowMs: now });
    assert.equal(status.ready, true);
    assert.equal(status.session_id, 1);
    assert.equal(status.age_ms, 5_000);

    writeFileSync(path, JSON.stringify({
      protocol: ILLUSTRATOR_AGENT_PROTOCOL,
      pid: 24068,
      session_id: 0,
      pipe: ILLUSTRATOR_AGENT_PIPE,
      state: "idle",
      updated_at: "2026-08-28T02:00:09.000Z",
    }));
    const sessionZero = readIllustratorAgentStatus({ platform: "win32", heartbeatPath: path, nowMs: now });
    assert.equal(sessionZero.ready, false);
    assert.equal(sessionZero.state, "wrong_session");
  });

  it("rejects stale or incompatible heartbeats", () => {
    const dir = makeTestTempDir("beian-agent-stale-");
    const path = join(dir, "agent.json");
    writeFileSync(path, JSON.stringify({
      protocol: ILLUSTRATOR_AGENT_PROTOCOL,
      pid: 24068,
      session_id: 1,
      user_sid: "S-1-5-21-1000-500",
      pipe: ILLUSTRATOR_AGENT_PIPE,
      state: "idle",
      updated_at: "2026-08-28T02:00:00.000Z",
      script_sha256: ILLUSTRATOR_AGENT_SCRIPT_SHA256,
      release_version: ILLUSTRATOR_AGENT_RELEASE_VERSION,
    }));
    const stale = readIllustratorAgentStatus({
      platform: "win32",
      heartbeatPath: path,
      nowMs: Date.parse("2026-08-28T02:00:20.001Z"),
    });
    assert.equal(stale.ready, false);
    assert.equal(stale.state, "stale");

    writeFileSync(path, JSON.stringify({
      protocol: "old-protocol",
      pid: 24068,
      session_id: 1,
      pipe: ILLUSTRATOR_AGENT_PIPE,
      state: "idle",
      updated_at: "2026-08-28T02:00:20.000Z",
    }));
    const incompatible = readIllustratorAgentStatus({
      platform: "win32",
      heartbeatPath: path,
      nowMs: Date.parse("2026-08-28T02:00:20.001Z"),
    });
    assert.equal(incompatible.ready, false);
    assert.equal(incompatible.state, "protocol_mismatch");
  });

  it("rejects a heartbeat that does not identify the fixed pipe and live process contract", () => {
    const path = join(makeTestTempDir("beian-agent-invalid-"), "agent.json");
    writeFileSync(path, JSON.stringify({
      protocol: ILLUSTRATOR_AGENT_PROTOCOL,
      pid: 0,
      session_id: 1,
      pipe: "other-pipe",
      state: "idle",
      updated_at: "2026-08-28T02:00:10.000Z",
    }));
    const status = readIllustratorAgentStatus({
      platform: "win32",
      heartbeatPath: path,
      nowMs: Date.parse("2026-08-28T02:00:10.000Z"),
    });
    assert.equal(status.ready, false);
    assert.equal(status.state, "invalid_heartbeat");
  });

  it("fails closed when the heartbeat file is malformed", () => {
    const path = join(makeTestTempDir("beian-agent-malformed-"), "agent.json");
    writeFileSync(path, "{not-json");

    const status = readIllustratorAgentStatus({ platform: "win32", heartbeatPath: path });

    assert.equal(status.ready, false);
    assert.equal(status.state, "invalid_heartbeat");
    assert.match(status.message, /状态损坏/);
  });

  it("rejects a heartbeat timestamp too far in the future", () => {
    const path = join(makeTestTempDir("beian-agent-future-"), "agent.json");
    writeFileSync(path, JSON.stringify({
      protocol: ILLUSTRATOR_AGENT_PROTOCOL,
      pid: 24068,
      session_id: 1,
      user_sid: "S-1-5-21-1000-500",
      pipe: ILLUSTRATOR_AGENT_PIPE,
      state: "idle",
      updated_at: "2026-08-28T02:00:06.000Z",
      script_sha256: ILLUSTRATOR_AGENT_SCRIPT_SHA256,
      release_version: ILLUSTRATOR_AGENT_RELEASE_VERSION,
    }));

    const status = readIllustratorAgentStatus({
      platform: "win32",
      heartbeatPath: path,
      nowMs: Date.parse("2026-08-28T02:00:00.000Z"),
    });

    assert.equal(status.ready, false);
    assert.equal(status.state, "stale");
  });

  it("keeps a fresh busy agent ready and exposes bounded diagnostics", () => {
    const path = join(makeTestTempDir("beian-agent-busy-"), "agent.json");
    writeFileSync(path, JSON.stringify({
      protocol: ILLUSTRATOR_AGENT_PROTOCOL,
      pid: 24068,
      session_id: 1,
      user: "HANGZHOU\\Administrator",
      user_sid: "S-1-5-21-1000-500",
      pipe: ILLUSTRATOR_AGENT_PIPE,
      state: "busy",
      updated_at: "2026-08-28T02:00:00.000Z",
      last_code: "illustrator_documents_open",
      script_sha256: ILLUSTRATOR_AGENT_SCRIPT_SHA256,
      release_version: ILLUSTRATOR_AGENT_RELEASE_VERSION,
    }));

    const status = readIllustratorAgentStatus({
      platform: "win32",
      heartbeatPath: path,
      nowMs: Date.parse("2026-08-28T02:00:01.000Z"),
    });

    assert.equal(status.ready, true);
    assert.equal(status.state, "busy");
    assert.equal(status.user, "HANGZHOU\\Administrator");
    assert.equal(status.last_code, "illustrator_documents_open");
    assert.equal(assertIllustratorAgentReady(status), status);
    assert.deepEqual(publicIllustratorAgentStatus(status), {
      required: true,
      ready: true,
      mode: "desktop_agent",
      state: "busy",
      message: status.message,
      last_code: "illustrator_documents_open",
    });
    assert.equal("pid" in publicIllustratorAgentStatus(status), false);
  });

  it("rejects a heartbeat from an older agent build", () => {
    const path = join(makeTestTempDir("beian-agent-build-"), "agent.json");
    writeFileSync(path, JSON.stringify({
      protocol: ILLUSTRATOR_AGENT_PROTOCOL,
      pid: 24068,
      session_id: 1,
      user_sid: "S-1-5-21-1000-500",
      pipe: ILLUSTRATOR_AGENT_PIPE,
      state: "idle",
      updated_at: "2026-08-28T02:00:00.000Z",
      script_sha256: "0".repeat(64),
      release_version: ILLUSTRATOR_AGENT_RELEASE_VERSION,
    }));

    const status = readIllustratorAgentStatus({
      platform: "win32",
      heartbeatPath: path,
      nowMs: Date.parse("2026-08-28T02:00:01.000Z"),
    });

    assert.equal(status.ready, false);
    assert.equal(status.state, "build_mismatch");
  });

  it("keeps a cleanup failure faulted until an administrator restarts the agent", () => {
    const path = join(makeTestTempDir("beian-agent-faulted-"), "agent.json");
    writeFileSync(path, JSON.stringify({
      protocol: ILLUSTRATOR_AGENT_PROTOCOL,
      pid: 24068,
      session_id: 1,
      user: "HANGZHOU\\Administrator",
      user_sid: "S-1-5-21-1000-500",
      pipe: ILLUSTRATOR_AGENT_PIPE,
      state: "faulted",
      updated_at: "2026-08-28T02:00:00.000Z",
      last_code: "illustrator_recovery_failed",
      script_sha256: ILLUSTRATOR_AGENT_SCRIPT_SHA256,
      release_version: ILLUSTRATOR_AGENT_RELEASE_VERSION,
    }));

    const status = readIllustratorAgentStatus({
      platform: "win32",
      heartbeatPath: path,
      nowMs: Date.parse("2026-08-28T02:00:01.000Z"),
    });

    assert.equal(status.ready, false);
    assert.equal(status.state, "faulted");
    assert.equal(status.last_code, "illustrator_recovery_failed");
    assert.throws(() => assertIllustratorAgentReady(status), /确认桌面稿件/);
    assert.equal("pid" in publicIllustratorAgentStatus(status), false);
  });
});
