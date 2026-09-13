/**
 * F02 独立监控配置装载：只从显式文件路径读取已有模块支持的非敏感策略。
 * 不寻找产品 settings.json，不扫描环境变量或密钥文件，不启动托管，不接入真实渠道。
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeConfig } from "../alert-core.mjs";
import { normalizeDeliveryConfig } from "../delivery/delivery-core.mjs";
import { normalizeRunnerConfig } from "../runner/runner-core.mjs";

export const MONITOR_CONFIG_SCHEMA = "beian-monitor-config-v1";
export const EXAMPLE_CONFIG_PATH = fileURLToPath(new URL("./local.example.json", import.meta.url));

const FORBIDDEN_KEY = /^(token|secret|password|webhook|authorization|credential|raw_response|open_id|app_secret)$/i;
const FORBIDDEN_ACTIVATION = new Set([
  "transport",
  "sender",
  "notify",
  "production_send",
  "loopbackurl",
  "publicurl",
  "loopback_url",
  "public_url",
  "url",
  "urls",
  "exec",
  "command",
  "module",
  "import",
  "require",
  "httpget",
  "httppost",
  "http_get",
  "http_post",
  "channel",
  "recipients",
  "recipient",
  "statedir",
  "statepath",
  "probe",
  "sampler",
  "queue",
  "createqueue",
  "settings",
  "env",
  "dotenv",
  "feishu",
  "appid",
  "app_id",
  "appsecret",
  "receiveid",
  "receive_id",
  "openid",
  "webhook_url",
  "webhookurl",
  "powershell",
  "argv",
]);

const TOP_KEYS = new Set(["schema", "production_default", "local_candidate", "alert", "runner", "delivery"]);
const ALERT_KEYS = new Set([
  "fail_threshold",
  "recover_threshold",
  "unknown_breaks_streak",
  "seen_ids_limit",
  "sources",
]);
const RUNNER_KEYS = new Set(["interval_ms", "first_delay_ms", "probe_timeout_ms"]);
const DELIVERY_KEYS = new Set(["max_attempts", "backoff_ms", "timeout_ms"]);

export class MonitoringConfigError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MonitoringConfigError";
    this.code = details.code || "invalid_config";
    this.field = details.field ?? null;
    this.details = { code: this.code, field: this.field };
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function fail(code, field, message) {
  throw new MonitoringConfigError(message, { code, field });
}

function fieldPath(section, key) {
  return section ? `${section}.${key}` : key;
}

function classifyKey(section, key) {
  const path = fieldPath(section, key);
  if (FORBIDDEN_KEY.test(key) || FORBIDDEN_ACTIVATION.has(key.toLowerCase())) {
    fail("forbidden_field", path, `forbidden field ${path}`);
  }
}

function assertAllowedKeys(value, section, allowed) {
  if (!isPlainObject(value)) fail("invalid_type", section, `${section || "config"} must be an object`);
  for (const key of Object.keys(value)) {
    if (key === "_comment") {
      if (typeof value[key] !== "string") {
        fail("invalid_type", fieldPath(section, key), `${fieldPath(section, key)} must be a string`);
      }
      continue;
    }
    classifyKey(section, key);
    if (!allowed.has(key)) fail("unknown_field", fieldPath(section, key), `unknown field ${fieldPath(section, key)}`);
  }
}

function omitComment(value) {
  if (!isPlainObject(value) || !hasOwn(value, "_comment")) return value;
  const { _comment, ...rest } = value;
  return rest;
}

function assertBoolean(value, field) {
  if (typeof value !== "boolean") fail("invalid_type", field, `${field} must be a boolean`);
}

function assertNumberPresent(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid_type", field, `${field} must be a number`);
  }
}

function pickSection(parsed, name, allowed) {
  if (!hasOwn(parsed, name)) return {};
  assertAllowedKeys(parsed[name], name, allowed);
  return omitComment(parsed[name]);
}

function runValidator(field, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof MonitoringConfigError) throw err;
    fail("invalid_range", field, `${field} has an invalid value`);
  }
}

function readExplicitFile(configPath) {
  if (configPath === undefined || configPath === null || configPath === "") {
    fail("missing_path", "path", "config path is required");
  }
  if (typeof configPath !== "string") fail("invalid_type", "path", "config path must be a string");
  if (!isAbsolute(configPath)) fail("path_not_absolute", "path", "config path must be an absolute path");

  let stat;
  try {
    stat = statSync(configPath);
  } catch (err) {
    if (err?.code === "ENOENT") fail("missing_file", "path", "config file is missing");
    fail("unreadable", "path", "config file is unreadable");
  }
  if (!stat.isFile()) fail("not_a_file", "path", "config path is not a file");

  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    fail("unreadable", "path", "config file is unreadable");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("invalid_json", null, "invalid JSON");
  }
  if (!isPlainObject(parsed)) fail("not_object", null, "config must be a JSON object");
  return parsed;
}

export function loadMonitoringConfig(configPath) {
  const parsed = readExplicitFile(configPath);
  assertAllowedKeys(parsed, "", TOP_KEYS);

  if (!hasOwn(parsed, "schema") || parsed.schema === undefined || parsed.schema === null) {
    fail("missing_schema", "schema", "schema is required");
  }
  if (parsed.schema !== MONITOR_CONFIG_SCHEMA) {
    fail("unsupported_schema", "schema", "unsupported schema");
  }
  if (hasOwn(parsed, "production_default")) {
    assertBoolean(parsed.production_default, "production_default");
    if (parsed.production_default !== false) {
      fail("production_enabled", "production_default", "production_default must be false");
    }
  }
  if (hasOwn(parsed, "local_candidate")) {
    assertBoolean(parsed.local_candidate, "local_candidate");
  }

  const alertSection = pickSection(parsed, "alert", ALERT_KEYS);
  const runnerSection = pickSection(parsed, "runner", RUNNER_KEYS);
  const deliverySection = pickSection(parsed, "delivery", DELIVERY_KEYS);

  if (hasOwn(alertSection, "unknown_breaks_streak")) {
    assertBoolean(alertSection.unknown_breaks_streak, "alert.unknown_breaks_streak");
  }
  for (const key of ["fail_threshold", "recover_threshold", "seen_ids_limit"]) {
    if (hasOwn(alertSection, key)) assertNumberPresent(alertSection[key], `alert.${key}`);
  }
  if (hasOwn(alertSection, "sources")) {
    if (!Array.isArray(alertSection.sources) || !alertSection.sources.every((item) => typeof item === "string" && item)) {
      fail("invalid_type", "alert.sources", "alert.sources must be an array of strings");
    }
    if (alertSection.sources.length === 0) {
      fail("invalid_range", "alert.sources", "alert.sources must not be empty");
    }
  }
  for (const key of ["interval_ms", "first_delay_ms", "probe_timeout_ms"]) {
    if (hasOwn(runnerSection, key)) assertNumberPresent(runnerSection[key], `runner.${key}`);
  }
  for (const key of ["max_attempts", "backoff_ms", "timeout_ms"]) {
    if (hasOwn(deliverySection, key)) assertNumberPresent(deliverySection[key], `delivery.${key}`);
  }

  const alertInput = { ...alertSection };
  if (hasOwn(parsed, "local_candidate")) alertInput.local_candidate = parsed.local_candidate;
  const alert = runValidator("alert", () => normalizeConfig(alertInput));

  const runner = runValidator("runner", () => normalizeRunnerConfig({
    ...runnerSection,
    fail_threshold: alert.fail_threshold,
    recover_threshold: alert.recover_threshold,
    unknown_breaks_streak: alert.unknown_breaks_streak,
    seen_ids_limit: alert.seen_ids_limit,
    sources: alert.sources,
    local_candidate: alert.local_candidate,
  }));

  const delivery = runValidator("delivery", () => normalizeDeliveryConfig({
    ...deliverySection,
    local_candidate: alert.local_candidate,
  }));

  return Object.freeze({
    schema: MONITOR_CONFIG_SCHEMA,
    path: configPath,
    alert,
    runner,
    delivery,
    notify: false,
    production_send: false,
    production_default: false,
    local_candidate: alert.local_candidate,
  });
}
