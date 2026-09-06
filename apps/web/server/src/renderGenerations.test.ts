import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, it } from "node:test";
import { makeTestTempDir } from "./testTemp.js";
import {
  G0_LEGACY_ORIGINAL_ID,
  RENDER_GENERATION_DIR,
  RENDER_GENERATION_DISK_SAFETY_FLOOR_BYTES,
  RENDER_GENERATION_HISTORY_DEFAULT_LIMIT,
  RENDER_GENERATION_HISTORY_MAX_LIMIT,
  RENDER_GENERATION_UNWIRED_NOTE,
  isRenderGenerationError,
  isRenderGenerationOutputKey,
  openRenderGenerationStore,
  renderGenerationDiskRequiredBytes,
  type QualityVerifyInput,
  type QualityVerifyResult,
  type RenderGenerationErrorCode,
  type RenderGenerationStore,
} from "./renderGenerations.js";

const FACES = ["front", "right", "back", "left", "top", "bottom"] as const;
const CONTRACT = Buffer.from("rf03a-contract-bytes-v1");
const CONTRACT_SHA = createHash("sha256").update(CONTRACT).digest("hex");
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function syntheticPng(r: number, g: number, b: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0, r, g, b]);
  return Buffer.concat([
    PNG_MAGIC,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngContainer(ihdr: Buffer, chunks: Buffer[]): Buffer {
  return Buffer.concat([PNG_MAGIC, pngChunk("IHDR", ihdr), ...chunks, pngChunk("IEND", Buffer.alloc(0))]);
}

function rgbHeader(): Buffer {
  return Buffer.from(syntheticPng(1, 2, 3).subarray(16, 29));
}

function syntheticGlb(marker: string): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, extras: { marker } }));
  const jsonPad = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
  const bin = Buffer.from(marker.padEnd(8, "\0"));
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  const body = Buffer.concat([jsonHeader, jsonChunk, binHeader, binChunk]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function unwiredVerifier(input: QualityVerifyInput): QualityVerifyResult {
  return {
    generation_id: input.generation_id,
    contract_sha256: input.contract_sha256,
    content_fingerprint: input.content_fingerprint,
    verifier_status: "accepted",
    quality_status: "unwired",
    verifier: "rf03a-test",
    note: RENDER_GENERATION_UNWIRED_NOTE,
  };
}

function snapshotVisible(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.set(relative(root, path), sha256(readFileSync(path)));
    }
  };
  walk(root);
  return out;
}

function assertMapsEqual(a: Map<string, string>, b: Map<string, string>): void {
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
}

function snapshotAll(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isSymbolicLink()) {
        out.set(rel, `symlink:${readlinkSync(path)}`);
        continue;
      }
      if (entry.isDirectory()) {
        out.set(rel, "dir");
        walk(path);
      } else if (entry.isFile()) {
        const st = lstatSync(path);
        out.set(rel, `file:${sha256(readFileSync(path))}:${st.size}:${st.nlink}`);
      } else {
        out.set(rel, "other");
      }
    }
  };
  walk(root);
  return out;
}

function assertOutsideFrozen(outside: string, before: Map<string, string>): void {
  assertMapsEqual(snapshotAll(outside), before);
}

function writeUpgradeSources(root: string, marker: string) {
  const scratch = join(root, `.scratch-${marker}`);
  mkdirSync(scratch);
  writeFileSync(join(scratch, "front_right_white.png"), syntheticPng(3, 3, 3));
  writeFileSync(join(scratch, "back_left_white.png"), syntheticPng(4, 4, 4));
  writeFileSync(join(scratch, "box.glb"), syntheticGlb(marker));
  return [
    { key: "white_a" as const, path: join(scratch, "front_right_white.png") },
    { key: "white_b" as const, path: join(scratch, "back_left_white.png") },
    { key: "glb" as const, path: join(scratch, "box.glb") },
  ];
}

function expectCode(fn: () => unknown, code: RenderGenerationErrorCode, root?: string): void {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (err) {
    assert.equal(isRenderGenerationError(err), true, String(err));
    assert.equal((err as { code: string }).code, code);
    const blob = `${(err as Error).message}\n${(err as { cause?: string }).cause || ""}\n${(err as { fix?: string }).fix || ""}`;
    assert.doesNotMatch(blob, /\/Users\/|C:\\|WB_DATA_DIR|secret|BEGIN /i);
    if (root) {
      assert.equal(blob.includes(root), false);
      assert.equal(blob.includes(realpathSync(root)), false);
    }
  }
}

type SeedOpts = {
  id?: string;
  ground?: "valid" | "bad" | "missing";
  pixel?: number;
};

function seedJob(opts: SeedOpts = {}) {
  const id = opts.id || "aaaaaaaaaaaa";
  const root = makeTestTempDir("beian-rg-");
  const pixel = opts.pixel ?? 40;
  const whiteA = syntheticPng(pixel, 10, 10);
  const whiteB = syntheticPng(10, pixel, 10);
  const glb = syntheticGlb(`glb-${pixel}`);
  writeFileSync(join(root, "26H06A_x_front_right_white.png"), whiteA);
  writeFileSync(join(root, "26H06A_x_back_left_white.png"), whiteB);
  writeFileSync(join(root, "box.glb"), glb);
  mkdirSync(join(root, "assets"));
  FACES.forEach((face, index) => {
    writeFileSync(join(root, "assets", `panel_${face}.png`), syntheticPng(index + 1, 20, 30));
  });
  if (opts.ground === "valid") {
    writeFileSync(join(root, "26H06A_x_front_right_ground.png"), syntheticPng(1, 2, 3));
    writeFileSync(join(root, "26H06A_x_back_left_ground.png"), syntheticPng(4, 5, 6));
  } else if (opts.ground === "bad") {
    writeFileSync(join(root, "26H06A_x_front_right_ground.png"), PNG_MAGIC);
  }
  return {
    id,
    root,
    whiteA,
    whiteB,
    glb,
    files: {
      white_a: join(root, "26H06A_x_front_right_white.png"),
      white_b: join(root, "26H06A_x_back_left_white.png"),
      glb: join(root, "box.glb"),
    },
  };
}

function openStore(
  job: { id: string; root: string },
  extra: Parameters<typeof openRenderGenerationStore>[0] extends infer T ? Omit<T, "jobRoot" | "jobId"> : never = {},
): RenderGenerationStore {
  return openRenderGenerationStore({
    jobRoot: job.root,
    jobId: job.id,
    now: () => new Date("2026-09-05T00:00:00.000Z"),
    qualityVerifier: unwiredVerifier,
    ...extra,
  });
}

function importG0(store: RenderGenerationStore) {
  const virtual = store.virtualLegacyCurrentId();
  return store.sealGeneration({
    mode: "legacy_import",
    contractSha256: CONTRACT_SHA,
    contractBytes: CONTRACT,
    profile: "compat-legacy-v0",
    observedCurrentGenerationId: null,
    expectedCurrentGenerationId: virtual,
    actorLabel: "籽烨",
  });
}

describe("renderGenerations", () => {
  for (const damage of ["output", "manifest"]) {
    it(`final commit barrier rejects ${damage} replacement after sealing`, () => {
      const job = seedJob();
      const store = openStore(job);
      const sealed = importG0(store);
      const original = readFileSync(job.files.white_a);
      if (damage === "output") writeFileSync(sealed.patch.files[0].path, syntheticPng(99,88,77));
      else {
        const manifest = join(job.root, RENDER_GENERATION_DIR, sealed.generation_id, "generation.json");
        const data = JSON.parse(readFileSync(manifest,"utf8")); data.actor_label = "changed";
        writeFileSync(manifest,JSON.stringify(data));
      }
      assert.throws(() => sealed.prepareCommit());
      assert.deepEqual(readFileSync(job.files.white_a), original);
    });
  }

  for (const phase of ["copy", "fsync", "rename", "after-rename"] as const) {
    it(`lifecycle failure during ${phase} retains source bytes and never returns a current patch`, () => {
      const job = seedJob();
      const before = snapshotAll(job.root);
      let expired = false;
      const store = openStore(job, {
        lifecycle: { check: () => { if (expired) throw new Error("lifecycle_timeout"); },
          beforeWrite: () => { if (phase === "copy") throw new Error("lifecycle_disk_budget"); } },
        failpoints: {
          duringCopy: () => { if (phase === "fsync") expired = true; },
          beforeRename: () => { if (phase === "rename") expired = true; },
          afterRenameBeforeIndex: () => { if (phase === "after-rename") expired = true; },
        },
      });
      assert.throws(() => importG0(store), /lifecycle_/);
      for (const [path, hash] of before) assert.equal(snapshotAll(job.root).get(path), hash);
      const fresh = openStore(job);
      const recovered = fresh.recoverOrphans();
      assert.equal(recovered.recovered.length, phase === "after-rename" ? 1 : 0);
      assert.equal(fresh.virtualLegacyCurrentId(), openStore(job).virtualLegacyCurrentId());
    });
  }

  it("accepts indexed palettes grayscale alpha RGBA and 16-bit container variants", () => {
    for (const [colorType, bitDepth] of [[3, 8], [4, 8], [6, 8], [0, 16], [2, 16], [4, 16], [6, 16]]) {
      const job = seedJob();
      const ihdr = rgbHeader();
      ihdr[9] = colorType;
      ihdr[8] = bitDepth;
      const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 2 ? 3 : 4;
      const chunks = colorType === 3 ? [pngChunk("PLTE", Buffer.from([10, 20, 30]))] : [];
      chunks.push(pngChunk("IDAT", deflateSync(Buffer.alloc(1 + channels * bitDepth / 8))));
      const png = pngContainer(ihdr, chunks);
      writeFileSync(job.files.white_a, png);
      const sealed = importG0(openStore(job));
      assert.equal(readFileSync(sealed.patch.files.find((file) => file.key === "white_a")?.path || "").equals(png), true);
    }
  });

  it("returns empty history and recovery without creating storage when no generation exists", () => {
    const job = seedJob();
    const before = snapshotAll(job.root);
    const store = openStore(job);
    assert.deepEqual(store.listHistory(), { items: [], next_cursor: null });
    assert.deepEqual(store.recoverOrphans(), { recovered: [], skipped_invalid: [], already_indexed: [] });
    assertMapsEqual(snapshotAll(job.root), before);
  });

  it("rejects unbound verifier hashes and false quality pass before publishing", () => {
    const overrides: Partial<QualityVerifyResult>[] = [
      { contract_sha256: "f".repeat(64) },
      { content_fingerprint: "e".repeat(64) },
      { quality_status: "pass" as QualityVerifyResult["quality_status"] },
      { quality_status: "failed" },
    ];
    for (const override of overrides) {
      const job = seedJob();
      const store = openStore(job, { qualityVerifier: (input) => ({ ...unwiredVerifier(input), ...override }) });
      expectCode(() => importG0(store), "render_generation_invalid", job.root);
      assert.equal(existsSync(join(job.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID)), false);
      assert.equal(existsSync(join(job.root, RENDER_GENERATION_DIR, "index.jsonl")), false);
    }
  });

  it("rejects an empty verifier before publishing ready or index and allows a corrected retry", () => {
    const job = seedJob();
    let verifier = "";
    const store = openStore(job, { qualityVerifier: (input) => ({ ...unwiredVerifier(input), verifier }) });
    expectCode(() => importG0(store), "render_generation_invalid", job.root);
    assert.equal(existsSync(join(job.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID)), false);
    assert.equal(existsSync(join(job.root, RENDER_GENERATION_DIR, "index.jsonl")), false);
    verifier = "corrected-synthetic-verifier";
    const sealed = importG0(store);
    assert.equal(sealed.generation_id, G0_LEGACY_ORIGINAL_ID);
    assert.equal(store.listHistory().items.length, 1);
  });

  it("accepts consecutive IDAT fragments including empty fragments around a nonempty stream", () => {
    const job = seedJob();
    const compressed = deflateSync(Buffer.from([0, 12, 23, 34]));
    const png = pngContainer(rgbHeader(), [
      pngChunk("IDAT", Buffer.alloc(0)),
      pngChunk("IDAT", compressed.subarray(0, 3)),
      pngChunk("IDAT", compressed.subarray(3)),
      pngChunk("IDAT", Buffer.alloc(0)),
    ]);
    writeFileSync(job.files.white_a, png);
    const sealed = importG0(openStore(job));
    assert.equal(readFileSync(sealed.patch.files.find((file) => file.key === "white_a")?.path || "").equals(png), true);
  });

  it("rejects illegal PNG color-type and bit-depth combinations before ready", () => {
    for (const [colorType, bitDepth] of [[2, 1], [3, 16], [4, 4], [6, 2], [1, 8]]) {
      const job = seedJob();
      const ihdr = rgbHeader();
      ihdr[9] = colorType;
      ihdr[8] = bitDepth;
      writeFileSync(job.files.white_a, pngContainer(ihdr, [pngChunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3])))]));
      expectCode(() => importG0(openStore(job)), "render_generation_invalid", job.root);
      assert.equal(existsSync(join(job.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID)), false);
    }
  });

  it("rejects unsupported PNG compression filter and interlace methods", () => {
    for (const [offset, value] of [[10, 1], [11, 1], [12, 2]]) {
      const job = seedJob();
      const ihdr = rgbHeader();
      ihdr[offset] = value;
      writeFileSync(job.files.white_a, pngContainer(ihdr, [pngChunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3])))]));
      expectCode(() => importG0(openStore(job)), "render_generation_invalid", job.root);
    }
  });

  it("rejects nonconsecutive IDAT invalid palettes and unknown critical chunks", () => {
    const stream = deflateSync(Buffer.from([0, 1, 2, 3]));
    const indexed = rgbHeader();
    indexed[9] = 3;
    const cases = [
      pngContainer(rgbHeader(), [pngChunk("IDAT", stream.subarray(0, 3)), pngChunk("tEXt", Buffer.from("k\0v")), pngChunk("IDAT", stream.subarray(3))]),
      pngContainer(indexed, [pngChunk("IDAT", deflateSync(Buffer.from([0, 0])))]),
      pngContainer(indexed, [pngChunk("PLTE", Buffer.from([1, 2])), pngChunk("IDAT", stream)]),
      pngContainer(indexed, [pngChunk("PLTE", Buffer.from([1, 2, 3])), pngChunk("PLTE", Buffer.from([1, 2, 3])), pngChunk("IDAT", stream)]),
      pngContainer(rgbHeader(), [pngChunk("IDAT", stream), pngChunk("PLTE", Buffer.from([1, 2, 3]))]),
      pngContainer(rgbHeader(), [pngChunk("ABCD", Buffer.from([1])), pngChunk("IDAT", stream)]),
      pngContainer(rgbHeader(), [pngChunk("abcd", Buffer.from([1])), pngChunk("IDAT", stream)]),
    ];
    for (const png of cases) {
      const job = seedJob();
      writeFileSync(job.files.white_a, png);
      expectCode(() => importG0(openStore(job)), "render_generation_invalid", job.root);
    }
  });

  it("rejects PNG CRC truncation duplicate headers absent data and trailing bytes", () => {
    const valid = syntheticPng(1, 2, 3);
    const badCrc = Buffer.from(valid);
    badCrc[29] ^= 1;
    const cases = [
      badCrc, valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from([0])]),
      pngContainer(rgbHeader(), [pngChunk("IHDR", rgbHeader()), pngChunk("IDAT", Buffer.from([1]))]),
      pngContainer(rgbHeader(), [pngChunk("IDAT", Buffer.alloc(0))]),
      pngContainer(rgbHeader(), [pngChunk("tEXt", Buffer.from("k\0v"))]),
    ];
    for (const png of cases) {
      const job = seedJob();
      writeFileSync(job.files.white_a, png);
      expectCode(() => importG0(openStore(job)), "render_generation_invalid", job.root);
    }
  });

  it("rejects GLB length version chunk alignment and malformed JSON", () => {
    const valid = syntheticGlb("container");
    const wrongLength = Buffer.from(valid);
    wrongLength.writeUInt32LE(valid.length + 4, 8);
    const wrongVersion = Buffer.from(valid);
    wrongVersion.writeUInt32LE(1, 4);
    const unaligned = Buffer.from(valid);
    unaligned.writeUInt32LE(3, 12);
    const malformed = Buffer.from(valid);
    malformed[20] = 0xff;
    for (const glb of [wrongLength, wrongVersion, unaligned, malformed]) {
      const job = seedJob();
      writeFileSync(job.files.glb, glb);
      expectCode(() => importG0(openStore(job)), "render_generation_invalid", job.root);
    }
  });

  it("accepts exact disk safety capacity and rejects invalid or overflowing estimates", () => {
    assert.equal(renderGenerationDiskRequiredBytes(0), RENDER_GENERATION_DISK_SAFETY_FLOOR_BYTES);
    for (const value of [-1, NaN, Infinity]) {
      expectCode(() => renderGenerationDiskRequiredBytes(value), "render_generation_invalid");
    }
    expectCode(() => renderGenerationDiskRequiredBytes(Number.MAX_SAFE_INTEGER), "render_generation_disk_guard");
    const job = seedJob();
    const estimated = Object.values(job.files).reduce((sum, file) => sum + lstatSync(file).size, 256 * 1024);
    const required = renderGenerationDiskRequiredBytes(estimated);
    const sealed = importG0(openStore(job, { probeDisk: () => ({ availableBytes: required, source: "injected" }) }));
    assert.equal(sealed.report.disk.availableBytes, sealed.report.disk.requiredBytes);
    assert.equal(sealed.report.disk.source, "injected");
  });

  it("fails closed on invalid injected disk probes without creating a ready generation", () => {
    for (const availableBytes of [-1, NaN, Infinity]) {
      const job = seedJob();
      expectCode(() => importG0(openStore(job, { probeDisk: () => ({ availableBytes, source: "injected" }) })), "render_generation_disk_guard", job.root);
      assert.equal(existsSync(join(job.root, RENDER_GENERATION_DIR)), false);
    }
  });

  it("rejects manifest schema extra fields duplicated files missing faces and total-byte tampering", () => {
    const job = seedJob();
    const store = openStore(job);
    importG0(store);
    const path = join(job.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID, "generation.json");
    const original = readFileSync(path, "utf8");
    const mutations: Array<(value: any) => void> = [
      (value) => { value.schema = "render-generation/999"; },
      (value) => { value.extra = true; },
      (value) => { value.files.push(value.files[0]); },
      (value) => { delete value.faces.bottom; },
      (value) => { value.total_bytes += 1; },
      (value) => { value.files[0].rel = "../outside.png"; },
      (value) => { value.quality.quality_status = "pass"; },
    ];
    for (const mutate of mutations) {
      const manifest = JSON.parse(original);
      mutate(manifest);
      writeFileSync(path, JSON.stringify(manifest));
      expectCode(() => store.publicSummary(G0_LEGACY_ORIGINAL_ID, null), "render_generation_invalid", job.root);
      assert.deepEqual(store.listHistory().items, []);
    }
    writeFileSync(path, original);
    assert.equal(store.listHistory().items.length, 1);
  });

  it("skips invalid orphan manifests and hidden staging without indexing or activating either", () => {
    const job = seedJob();
    const store = openStore(job, { failpoints: { afterRenameBeforeIndex: () => { throw new Error("orphan"); } } });
    assert.throws(() => importG0(store), /orphan/);
    writeFileSync(join(job.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID, "generation.json"), "{");
    mkdirSync(join(job.root, RENDER_GENERATION_DIR, ".staging-abandoned"));
    const before = snapshotAll(job.root);
    assert.deepEqual(store.recoverOrphans(), { recovered: [], skipped_invalid: [G0_LEGACY_ORIGINAL_ID], already_indexed: [] });
    assertMapsEqual(snapshotAll(job.root), before);
    assert.equal(existsSync(join(job.root, "job.json")), false);
  });

  it("accepts a valid grayscale PNG with color type zero without rewriting its bytes", () => {
    const job = seedJob();
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 0;
    const gray = Buffer.concat([
      PNG_MAGIC, pngChunk("IHDR", ihdr),
      pngChunk("IDAT", deflateSync(Buffer.from([0, 128]))),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    writeFileSync(job.files.white_a, gray);
    const sealed = importG0(openStore(job));
    const output = sealed.patch.files.find((file) => file.key === "white_a");
    assert.equal(readFileSync(output?.path || "").equals(gray), true);
    assert.equal(sealed.report.quality_status, "unwired");
  });

  it("seals a hyphenated legacy_relight generation id after g0", () => {
    const job = seedJob({ id: "bbbbbbbbbbbb" });
    const store = openStore(job);
    const g0 = importG0(store);
    const sealed = store.sealGeneration({
      mode: "legacy_relight",
      contractSha256: CONTRACT_SHA,
      contractBytes: CONTRACT,
      profile: "compat-legacy-v0",
      sources: writeUpgradeSources(job.root, "relight"),
      observedCurrentGenerationId: g0.generation_id,
      expectedCurrentGenerationId: g0.generation_id,
    });
    assert.match(sealed.generation_id, /^g1-legacy-relight-[a-f0-9]{8}-[a-f0-9]{8}$/);
    assert.equal(sealed.patch.current_render_generation_id, sealed.generation_id);
  });

  it("classifies generation output keys without treating ppt or read faces as generation files", () => {
    assert.equal(isRenderGenerationOutputKey("white_a"), true);
    assert.equal(isRenderGenerationOutputKey("white_a_ground"), true);
    assert.equal(isRenderGenerationOutputKey("glb"), true);
    assert.equal(isRenderGenerationOutputKey("ppt"), false);
    assert.equal(isRenderGenerationOutputKey("sheet"), false);
    assert.equal(isRenderGenerationOutputKey("read_front"), false);
  });

  it("does not import config or touch process DATA_DIR", () => {
    const before = process.env.WB_DATA_DIR;
    const job = seedJob();
    const store = openStore(job);
    importG0(store);
    assert.equal(process.env.WB_DATA_DIR, before);
    assert.equal(existsSync(join(job.root, "job.json")), false);
  });

  it("imports, seals, reads, and returns an activation patch without writing job.json", () => {
    const job = seedJob();
    const before = snapshotVisible(job.root);
    const store = openStore(job);
    const sealed = importG0(store);
    assert.equal(sealed.generation_id, G0_LEGACY_ORIGINAL_ID);
    assert.equal(sealed.patch.current_render_generation_id, G0_LEGACY_ORIGINAL_ID);
    assert.deepEqual(sealed.patch.files.map((f) => f.key).sort(), ["glb", "white_a", "white_b"]);
    const realRoot = realpathSync(job.root);
    for (const file of sealed.patch.files) {
      assert.equal(file.path.startsWith(realRoot), true);
      assert.equal(file.path.includes(RENDER_GENERATION_DIR), true);
      assert.equal(existsSync(file.path), true);
      assert.notEqual(lstatSync(file.path).ino, lstatSync(job.files[file.key as "white_a" | "white_b" | "glb"]).ino);
    }
    assertMapsEqual(snapshotVisible(job.root), before);
    assert.equal(readFileSync(job.files.white_a).equals(job.whiteA), true);
    assert.equal(existsSync(join(job.root, "job.json")), false);
    assert.equal(sealed.report.quality_wired, false);
    assert.equal(sealed.report.quality_status, "unwired");
    assert.equal(sealed.report.note, RENDER_GENERATION_UNWIRED_NOTE);
    assert.equal(sealed.report.durability.power_loss_proven, false);
    assert.equal(sealed.report.durability.windows_durability_proven, false);
    assert.equal(sealed.report.disk.source, "statfs");
    assert.equal(sealed.public_summary.quality_status, "unwired");
    assert.equal(JSON.stringify(sealed.public_summary).includes(job.root), false);
    assert.equal(JSON.stringify(sealed.public_summary).includes(realRoot), false);
    assert.equal(JSON.stringify(sealed.public_summary).includes(RENDER_GENERATION_DIR), false);

    const virtual = store.virtualLegacyCurrentId();
    const patch = store.prepareActivationPatch({
      generationId: G0_LEGACY_ORIGINAL_ID,
      observedCurrentGenerationId: null,
      expectedCurrentGenerationId: virtual,
    });
    assert.deepEqual(patch, sealed.patch);

    const summary = store.publicSummary(G0_LEGACY_ORIGINAL_ID, G0_LEGACY_ORIGINAL_ID);
    assert.equal(summary.current, true);
    assert.equal(summary.actor_label, "籽烨");
    assert.equal(JSON.stringify(summary).includes(job.root), false);
    assert.equal(JSON.stringify(summary).includes(realRoot), false);

    const page = store.listHistory({ currentGenerationId: G0_LEGACY_ORIGINAL_ID });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.generation_id, G0_LEGACY_ORIGINAL_ID);
    assert.equal(page.next_cursor, null);
  });

  it("keeps a new generation isolated from the previous ready generation and the root", () => {
    const job = seedJob();
    const store = openStore(job);
    const g0 = importG0(store);
    const g0Bytes = new Map(g0.patch.files.map((f) => [f.key, readFileSync(f.path)]));
    mkdirSync(join(job.root, "scratch"));
    const nextA = syntheticPng(9, 9, 9);
    const nextB = syntheticPng(8, 8, 8);
    const nextGlb = syntheticGlb("next");
    writeFileSync(join(job.root, "scratch", "front_right_white.png"), nextA);
    writeFileSync(join(job.root, "scratch", "back_left_white.png"), nextB);
    writeFileSync(join(job.root, "scratch", "box.glb"), nextGlb);
    const rootBefore = snapshotVisible(job.root);
    const g1 = store.sealGeneration({
      mode: "upgrade",
      contractSha256: CONTRACT_SHA,
      contractBytes: CONTRACT,
      profile: "packshot-neutral-v1",
      sources: [
        { key: "white_a", path: join(job.root, "scratch", "front_right_white.png") },
        { key: "white_b", path: join(job.root, "scratch", "back_left_white.png") },
        { key: "glb", path: join(job.root, "scratch", "box.glb") },
      ],
      observedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
      expectedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
    });
    assert.notEqual(g1.generation_id, G0_LEGACY_ORIGINAL_ID);
    assert.match(g1.generation_id, /^g1-upgrade-[a-f0-9]{8}-[a-f0-9]{8}$/);
    for (const file of g0.patch.files) {
      assert.equal(readFileSync(file.path).equals(g0Bytes.get(file.key) || Buffer.alloc(0)), true);
    }
    const g1A = g1.patch.files.find((f) => f.key === "white_a");
    assert.equal(g1A && readFileSync(g1A.path).equals(nextA), true);
    assert.equal(readFileSync(job.files.white_a).equals(job.whiteA), true);
    assertMapsEqual(snapshotVisible(job.root), rootBefore);
  });

  it("rejects field, hash, file, asset and quality failures", () => {
    const job = seedJob();
    const store = openStore(job);
    const sealed = importG0(store);
    const virtual = store.virtualLegacyCurrentId();

    const manifestPath = join(job.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID, "generation.json");
    const originalManifest = readFileSync(manifestPath);
    const broken = JSON.parse(originalManifest.toString("utf8")) as { generation_id: unknown };
    broken.generation_id = 1;
    writeFileSync(manifestPath, JSON.stringify(broken));
    expectCode(
      () => store.prepareActivationPatch({
        generationId: G0_LEGACY_ORIGINAL_ID,
        observedCurrentGenerationId: null,
        expectedCurrentGenerationId: virtual,
      }),
      "render_generation_invalid",
      job.root,
    );
    writeFileSync(manifestPath, originalManifest);

    const destA = sealed.patch.files.find((f) => f.key === "white_a")?.path || "";
    const originalA = readFileSync(destA);
    writeFileSync(destA, Buffer.concat([originalA, Buffer.from([1])]));
    expectCode(
      () => store.prepareActivationPatch({
        generationId: G0_LEGACY_ORIGINAL_ID,
        observedCurrentGenerationId: null,
        expectedCurrentGenerationId: virtual,
      }),
      "render_generation_invalid",
      job.root,
    );
    writeFileSync(destA, originalA);

    const destGlb = sealed.patch.files.find((f) => f.key === "glb")?.path || "";
    const originalGlb = readFileSync(destGlb);
    writeFileSync(destGlb, Buffer.alloc(0));
    expectCode(
      () => store.prepareActivationPatch({
        generationId: G0_LEGACY_ORIGINAL_ID,
        observedCurrentGenerationId: null,
        expectedCurrentGenerationId: virtual,
      }),
      "render_generation_invalid",
      job.root,
    );
    writeFileSync(destGlb, originalGlb);

    const job2 = seedJob({ id: "bbbbbbbbbbbb" });
    const rejected = openStore(job2, {
      qualityVerifier: (input) => ({ ...unwiredVerifier(input), verifier_status: "rejected", quality_status: "failed" }),
    });
    expectCode(() => importG0(rejected), "render_generation_invalid", job2.root);
    assert.equal(existsSync(join(job2.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID)), false);

    const job3 = seedJob({ id: "cccccccccccc" });
    const unbound = openStore(job3, {
      qualityVerifier: (input) => ({ ...unwiredVerifier(input), generation_id: "g1-upgrade-deadbeef-deadbeef" }),
    });
    expectCode(() => importG0(unbound), "render_generation_invalid", job3.root);

    const job4 = seedJob({ id: "dddddddddddd" });
    const none = openRenderGenerationStore({ jobRoot: job4.root, jobId: job4.id });
    expectCode(() => importG0(none), "render_generation_invalid", job4.root);

    const job5 = seedJob({ id: "eeeeeeeeeeee" });
    writeFileSync(job5.files.white_a, PNG_MAGIC);
    const magicPng = openStore(job5);
    expectCode(() => importG0(magicPng), "render_generation_invalid", job5.root);

    const job6 = seedJob({ id: "ffffffffffff" });
    writeFileSync(job6.files.glb, Buffer.concat([Buffer.from("glTF"), Buffer.alloc(20, 7)]));
    const magicGlb = openStore(job6);
    expectCode(() => importG0(magicGlb), "render_generation_invalid", job6.root);
  });

  it("omits invalid optional ground/set instead of mixing them into ready", () => {
    const job = seedJob({ ground: "bad" });
    const store = openStore(job);
    const sealed = importG0(store);
    assert.equal(sealed.patch.files.some((f) => f.key === "white_a_ground"), false);
    assert.equal(sealed.report.optional_omitted.some((row) => row.key === "white_a_ground"), true);
    assert.equal(existsSync(join(job.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID, "outputs", "26H06A_x_front_right_ground.png")), false);

    const jobOk = seedJob({ id: "bbbbbbbbbbbb", ground: "valid" });
    const ok = importG0(openStore(jobOk));
    assert.equal(ok.patch.files.some((f) => f.key === "white_a_ground"), true);
    assert.equal(ok.patch.files.some((f) => f.key === "white_b_ground"), true);
  });

  it("rejects path escape, symlink and alias/inode sharing", () => {
    const job = seedJob();
    const outside = makeTestTempDir("beian-rg-out-");
    const escaped = join(outside, "front_right_white.png");
    writeFileSync(escaped, syntheticPng(1, 1, 1));
    const store = openStore(job);
    const virtual = store.virtualLegacyCurrentId();
    expectCode(
      () => store.sealGeneration({
        mode: "legacy_import",
        contractSha256: CONTRACT_SHA,
        profile: "compat-legacy-v0",
        sources: [
          { key: "white_a", path: escaped },
          { key: "white_b", path: job.files.white_b },
          { key: "glb", path: job.files.glb },
        ],
        observedCurrentGenerationId: null,
        expectedCurrentGenerationId: virtual,
      }),
      "render_generation_invalid",
      job.root,
    );

    const linked = join(job.root, "link_front_right.png");
    symlinkSync(job.files.white_a, linked);
    expectCode(
      () => store.sealGeneration({
        mode: "legacy_import",
        contractSha256: CONTRACT_SHA,
        profile: "compat-legacy-v0",
        sources: [
          { key: "white_a", path: linked },
          { key: "white_b", path: job.files.white_b },
          { key: "glb", path: job.files.glb },
        ],
        observedCurrentGenerationId: null,
        expectedCurrentGenerationId: virtual,
      }),
      "render_generation_invalid",
      job.root,
    );

    const alias = join(job.root, "alias_back_left.png");
    linkSync(job.files.white_a, alias);
    expectCode(
      () => store.sealGeneration({
        mode: "legacy_import",
        contractSha256: CONTRACT_SHA,
        profile: "compat-legacy-v0",
        sources: [
          { key: "white_a", path: job.files.white_a },
          { key: "white_b", path: alias },
          { key: "glb", path: job.files.glb },
        ],
        observedCurrentGenerationId: null,
        expectedCurrentGenerationId: virtual,
      }),
      "render_generation_invalid",
      job.root,
    );

    const cased = join(job.root, "26H06A_X_FRONT_RIGHT_WHITE.PNG");
    if (existsSync(cased) && lstatSync(cased).ino === lstatSync(job.files.white_a).ino) {
      expectCode(
        () => store.sealGeneration({
          mode: "legacy_import",
          contractSha256: CONTRACT_SHA,
          profile: "compat-legacy-v0",
          sources: [
            { key: "white_a", path: job.files.white_a },
            { key: "white_b", path: cased },
            { key: "glb", path: job.files.glb },
          ],
          observedCurrentGenerationId: null,
          expectedCurrentGenerationId: virtual,
        }),
        "render_generation_invalid",
        job.root,
      );
    }

    expectCode(
      () => store.prepareActivationPatch({
        generationId: join(job.root, G0_LEGACY_ORIGINAL_ID),
        observedCurrentGenerationId: null,
        expectedCurrentGenerationId: virtual,
      }),
      "render_generation_invalid",
      job.root,
    );
    expectCode(
      () => store.prepareActivationPatch({
        generationId: "../g0-legacy-original",
        observedCurrentGenerationId: null,
        expectedCurrentGenerationId: virtual,
      }),
      "render_generation_invalid",
      job.root,
    );
  });

  it("rejects a second materialize of g0", () => {
    const job = seedJob();
    const store = openStore(job);
    importG0(store);
    expectCode(() => importG0(store), "render_generation_invalid", job.root);
  });

  it("rejects stale expected/observed pointers and does not treat that as CAS", () => {
    const job = seedJob();
    const store = openStore(job);
    expectCode(
      () => store.sealGeneration({
        mode: "legacy_import",
        contractSha256: CONTRACT_SHA,
        profile: "compat-legacy-v0",
        observedCurrentGenerationId: null,
        expectedCurrentGenerationId: null,
      }),
      "render_generation_stale",
      job.root,
    );
    importG0(store);
    expectCode(
      () => store.prepareActivationPatch({
        generationId: G0_LEGACY_ORIGINAL_ID,
        observedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
        expectedCurrentGenerationId: "legacy-current-ffffffff",
      }),
      "render_generation_stale",
      job.root,
    );
  });

  it("enforces an injected disk guard and reports the formula without calling it a live remaining-space reading", () => {
    const job = seedJob();
    const estimated = lstatSync(job.files.white_a).size + lstatSync(job.files.white_b).size + lstatSync(job.files.glb).size + 256 * 1024;
    const required = renderGenerationDiskRequiredBytes(estimated);
    assert.equal(required, estimated * 2 + RENDER_GENERATION_DISK_SAFETY_FLOOR_BYTES);
    const before = snapshotVisible(job.root);
    const store = openStore(job, {
      probeDisk: () => ({ availableBytes: 1024, source: "injected" }),
    });
    expectCode(() => importG0(store), "render_generation_disk_guard", job.root);
    assertMapsEqual(snapshotVisible(job.root), before);
    assert.equal(existsSync(join(job.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID)), false);
  });

  it("keeps root bytes at copy/manifest/rename/index failpoints", () => {
    const cases: Array<{ name: string; failpoints: Parameters<typeof openRenderGenerationStore>[0]["failpoints"] }> = [
      { name: "duringCopy", failpoints: { duringCopy: () => { throw new Error("fail-copy"); } } },
      { name: "afterManifestWrite", failpoints: { afterManifestWrite: () => { throw new Error("fail-manifest"); } } },
      { name: "beforeRename", failpoints: { beforeRename: () => { throw new Error("fail-before-rename"); } } },
      { name: "afterRenameBeforeIndex", failpoints: { afterRenameBeforeIndex: () => { throw new Error("fail-after-rename"); } } },
    ];
    const failpointIds = ["a11111111111", "a22222222222", "a33333333333", "a44444444444"];
    for (const [index, item] of cases.entries()) {
      const job = seedJob({ id: failpointIds[index] });
      const before = snapshotVisible(job.root);
      const store = openStore(job, { failpoints: item.failpoints });
      assert.throws(() => importG0(store), new RegExp(`fail-`));
      assertMapsEqual(snapshotVisible(job.root), before);
      assert.equal(existsSync(join(job.root, "job.json")), false);
      if (item.name !== "afterRenameBeforeIndex") {
        assert.equal(existsSync(join(job.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID)), false);
      } else {
        assert.equal(existsSync(join(job.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID)), true);
        const index = join(job.root, RENDER_GENERATION_DIR, "index.jsonl");
        assert.equal(existsSync(index) && readFileSync(index, "utf8").includes(G0_LEGACY_ORIGINAL_ID), false);
      }
    }
  });

  it("recovers an orphan ready generation twice without duplicating index events or activating", () => {
    const job = seedJob();
    const before = snapshotVisible(job.root);
    const store = openStore(job, {
      failpoints: { afterRenameBeforeIndex: () => { throw new Error("fail-after-rename"); } },
    });
    assert.throws(() => importG0(store), /fail-after-rename/);
    const first = store.recoverOrphans();
    assert.deepEqual(first.recovered, [G0_LEGACY_ORIGINAL_ID]);
    const indexPath = join(job.root, RENDER_GENERATION_DIR, "index.jsonl");
    const once = readFileSync(indexPath, "utf8");
    assert.equal(once.trim().split("\n").length, 1);
    assert.match(once, /"event":"recovered"/);
    const second = store.recoverOrphans();
    assert.deepEqual(second.recovered, []);
    assert.equal(second.already_indexed.includes(G0_LEGACY_ORIGINAL_ID), true);
    assert.equal(readFileSync(indexPath, "utf8"), once);
    assertMapsEqual(snapshotVisible(job.root), before);
    const page = store.listHistory({ currentGenerationId: null });
    assert.equal(page.items[0]?.current, false);
    assert.equal(existsSync(join(job.root, "job.json")), false);
  });

  it("does not treat a truncated index tail as a record and can append after it", () => {
    const job = seedJob();
    const store = openStore(job);
    importG0(store);
    const indexPath = join(job.root, RENDER_GENERATION_DIR, "index.jsonl");
    appendFileSync(indexPath, '{"partial":');
    mkdirSync(join(job.root, "scratch"));
    writeFileSync(join(job.root, "scratch", "front_right_white.png"), syntheticPng(3, 3, 3));
    writeFileSync(join(job.root, "scratch", "back_left_white.png"), syntheticPng(4, 4, 4));
    writeFileSync(join(job.root, "scratch", "box.glb"), syntheticGlb("after-trunc"));
    const g1 = store.sealGeneration({
      mode: "upgrade",
      contractSha256: CONTRACT_SHA,
      profile: "packshot-neutral-v1",
      sources: [
        { key: "white_a", path: join(job.root, "scratch", "front_right_white.png") },
        { key: "white_b", path: join(job.root, "scratch", "back_left_white.png") },
        { key: "glb", path: join(job.root, "scratch", "box.glb") },
      ],
      observedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
      expectedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
    });
    const raw = readFileSync(indexPath, "utf8");
    assert.equal(raw.includes('{"partial":'), true);
    const page = store.listHistory();
    assert.equal(page.items.some((item) => item.generation_id === G0_LEGACY_ORIGINAL_ID), true);
    assert.equal(page.items.some((item) => item.generation_id === g1.generation_id), true);
    assert.equal(raw.includes("partial") && page.items.some((item) => JSON.stringify(item).includes("partial")), false);
  });

  it("paginates with a job-bound cursor and rejects forged or cross-job cursors", () => {
    const job = seedJob();
    const store = openStore(job);
    importG0(store);
    const ids = [G0_LEGACY_ORIGINAL_ID];
    for (let i = 0; i < 2; i += 1) {
      const scratch = join(job.root, `scratch-${i}`);
      mkdirSync(scratch);
      writeFileSync(join(scratch, "front_right_white.png"), syntheticPng(i + 2, 1, 1));
      writeFileSync(join(scratch, "back_left_white.png"), syntheticPng(1, i + 2, 1));
      writeFileSync(join(scratch, "box.glb"), syntheticGlb(`p${i}`));
      const sealed = store.sealGeneration({
        mode: "upgrade",
        contractSha256: CONTRACT_SHA,
        profile: "packshot-neutral-v1",
        sources: [
          { key: "white_a", path: join(scratch, "front_right_white.png") },
          { key: "white_b", path: join(scratch, "back_left_white.png") },
          { key: "glb", path: join(scratch, "box.glb") },
        ],
        observedCurrentGenerationId: ids[ids.length - 1] || G0_LEGACY_ORIGINAL_ID,
        expectedCurrentGenerationId: ids[ids.length - 1] || G0_LEGACY_ORIGINAL_ID,
      });
      ids.push(sealed.generation_id);
    }
    const first = store.listHistory({ limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(typeof first.next_cursor, "string");
    assert.equal(JSON.stringify(first).includes(job.root), false);
    const second = store.listHistory({ limit: 2, cursor: first.next_cursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.next_cursor, null);
    const all = store.listHistory();
    assert.equal(all.items.length, 3);
    assert.equal(all.next_cursor, null);

    expectCode(() => store.listHistory({ limit: 0 }), "render_generation_invalid", job.root);
    expectCode(() => store.listHistory({ limit: RENDER_GENERATION_HISTORY_MAX_LIMIT + 1 }), "render_generation_invalid", job.root);
    expectCode(() => store.listHistory({ cursor: "forged.cursor" }), "render_generation_invalid", job.root);
    expectCode(() => store.listHistory({ cursor: first.next_cursor ? `${first.next_cursor}x` : "x" }), "render_generation_invalid", job.root);

    const other = seedJob({ id: "bbbbbbbbbbbb" });
    const otherStore = openStore(other);
    importG0(otherStore);
    expectCode(() => otherStore.listHistory({ cursor: first.next_cursor }), "render_generation_invalid", other.root);
    assert.equal(RENDER_GENERATION_HISTORY_DEFAULT_LIMIT, 20);
  });

  it("binds dest byte hashes and ignores the idea of a caller-supplied hash", () => {
    const job = seedJob();
    const store = openStore(job);
    const sealed = importG0(store);
    const manifest = JSON.parse(
      readFileSync(join(job.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID, "generation.json"), "utf8"),
    ) as { files: Array<{ key: string; sha256: string; path?: string }> };
    for (const row of manifest.files) {
      const file = sealed.patch.files.find((item) => item.key === row.key);
      assert.equal(Boolean(file), true);
      assert.equal(row.sha256, sha256(readFileSync(file?.path || "")));
      assert.equal("path" in row, false);
    }
  });

  it("uses dest hashes for virtual current id and rejects contract byte mismatch", () => {
    const job = seedJob();
    const store = openStore(job);
    const virtual = store.virtualLegacyCurrentId();
    assert.match(virtual, /^legacy-current-[a-f0-9]{8}$/);
    expectCode(
      () => store.sealGeneration({
        mode: "legacy_import",
        contractSha256: CONTRACT_SHA,
        contractBytes: Buffer.from("nope"),
        profile: "compat-legacy-v0",
        observedCurrentGenerationId: null,
        expectedCurrentGenerationId: virtual,
      }),
      "render_generation_invalid",
      job.root,
    );
  });

  it("keeps history, summary and activation after shared faces change or vanish, but rejects stale-source rerender", () => {
    const job = seedJob();
    const store = openStore(job);
    const sealed = importG0(store);
    const virtual = store.virtualLegacyCurrentId();
    const sources = writeUpgradeSources(job.root, "stale");
    const face = join(job.root, "assets", "panel_front.png");
    const originalFace = readFileSync(face);
    const readyDirs = () =>
      readdirSync(join(job.root, RENDER_GENERATION_DIR), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort();

    const assertHistoryReadable = () => {
      const page = store.listHistory({ currentGenerationId: G0_LEGACY_ORIGINAL_ID });
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0]?.generation_id, G0_LEGACY_ORIGINAL_ID);
      const summary = store.publicSummary(G0_LEGACY_ORIGINAL_ID, G0_LEGACY_ORIGINAL_ID);
      assert.equal(summary.generation_id, G0_LEGACY_ORIGINAL_ID);
      assert.equal(summary.current, true);
      const patch = store.prepareActivationPatch({
        generationId: G0_LEGACY_ORIGINAL_ID,
        observedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
        expectedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
      });
      assert.equal(patch.current_render_generation_id, G0_LEGACY_ORIGINAL_ID);
      const viaVirtual = store.prepareActivationPatch({
        generationId: G0_LEGACY_ORIGINAL_ID,
        observedCurrentGenerationId: null,
        expectedCurrentGenerationId: virtual,
      });
      assert.equal(viaVirtual.current_render_generation_id, G0_LEGACY_ORIGINAL_ID);
    };

    const assertRerenderRejected = () => {
      expectCode(
        () => store.sealGeneration({
          mode: "upgrade",
          contractSha256: CONTRACT_SHA,
          profile: "packshot-neutral-v1",
          sources,
          observedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
          expectedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
        }),
        "render_generation_invalid",
        job.root,
      );
      assert.deepEqual(readyDirs(), [G0_LEGACY_ORIGINAL_ID]);
    };

    writeFileSync(face, syntheticPng(9, 9, 9));
    assertHistoryReadable();
    assertRerenderRejected();

    unlinkSync(face);
    assertHistoryReadable();
    assertRerenderRejected();

    writeFileSync(face, originalFace);
    const destA = sealed.patch.files.find((f) => f.key === "white_a")?.path || "";
    const originalA = readFileSync(destA);
    writeFileSync(destA, Buffer.concat([originalA, Buffer.from([1])]));
    expectCode(
      () => store.publicSummary(G0_LEGACY_ORIGINAL_ID, G0_LEGACY_ORIGINAL_ID),
      "render_generation_invalid",
      job.root,
    );
    expectCode(
      () => store.prepareActivationPatch({
        generationId: G0_LEGACY_ORIGINAL_ID,
        observedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
        expectedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
      }),
      "render_generation_invalid",
      job.root,
    );
    assert.equal(store.listHistory({ currentGenerationId: G0_LEGACY_ORIGINAL_ID }).items.length, 0);
    assertRerenderRejected();
    writeFileSync(destA, originalA);
    assertHistoryReadable();
  });

  it("rejects genDir/index/cursor/staging symlink escape before any write and leaves the outside tree unchanged", () => {
    const job = seedJob();
    const outside = makeTestTempDir("beian-rg-out-");
    writeFileSync(join(outside, "SENTINEL"), "keep-me");
    mkdirSync(join(outside, "nested"));
    writeFileSync(join(outside, "nested", "keep.bin"), Buffer.from("abc"));
    mkdirSync(join(outside, G0_LEGACY_ORIGINAL_ID));
    writeFileSync(join(outside, G0_LEGACY_ORIGINAL_ID, "generation.json"), "{}\n");
    const genLink = join(job.root, RENDER_GENERATION_DIR);
    symlinkSync(outside, genLink, "dir");
    const before = snapshotAll(outside);
    const store = openStore(job);
    expectCode(() => importG0(store), "render_generation_invalid", job.root);
    expectCode(() => store.recoverOrphans(), "render_generation_invalid", job.root);
    expectCode(() => store.listHistory(), "render_generation_invalid", job.root);
    expectCode(
      () => store.publicSummary(G0_LEGACY_ORIGINAL_ID, null),
      "render_generation_invalid",
      job.root,
    );
    assertMapsEqual(snapshotAll(outside), before);
    assert.equal(readFileSync(join(outside, "SENTINEL"), "utf8"), "keep-me");
    assert.equal(lstatSync(genLink).isSymbolicLink(), true);
    assert.equal(existsSync(join(job.root, "job.json")), false);

    unlinkSync(genLink);
    const sealed = importG0(openStore(job));
    assert.equal(sealed.generation_id, G0_LEGACY_ORIGINAL_ID);
    assert.equal(lstatSync(join(job.root, RENDER_GENERATION_DIR)).isSymbolicLink(), false);

    const indexPath = join(job.root, RENDER_GENERATION_DIR, "index.jsonl");
    const outsideIndex = join(outside, "stolen-index.jsonl");
    writeFileSync(outsideIndex, readFileSync(indexPath));
    const indexBefore = snapshotAll(outside);
    unlinkSync(indexPath);
    symlinkSync(outsideIndex, indexPath);
    const afterIndexLink = openStore(job);
    expectCode(() => afterIndexLink.listHistory(), "render_generation_invalid", job.root);
    expectCode(
      () => afterIndexLink.sealGeneration({
        mode: "upgrade",
        contractSha256: CONTRACT_SHA,
        profile: "packshot-neutral-v1",
        sources: writeUpgradeSources(job.root, "idx"),
        observedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
        expectedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
      }),
      "render_generation_invalid",
      job.root,
    );
    assertMapsEqual(snapshotAll(outside), indexBefore);

    unlinkSync(indexPath);
    writeFileSync(indexPath, readFileSync(outsideIndex));
    const g1 = openStore(job).sealGeneration({
      mode: "upgrade",
      contractSha256: CONTRACT_SHA,
      profile: "packshot-neutral-v1",
      sources: writeUpgradeSources(job.root, "ok"),
      observedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
      expectedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
    });
    assert.match(g1.generation_id, /^g1-upgrade-/);

    const cursorPath = join(job.root, RENDER_GENERATION_DIR, ".cursor-key");
    const outsideCursor = join(outside, "stolen-cursor");
    if (existsSync(cursorPath)) {
      writeFileSync(outsideCursor, readFileSync(cursorPath));
      unlinkSync(cursorPath);
    } else {
      writeFileSync(outsideCursor, "ab".repeat(32));
    }
    symlinkSync(outsideCursor, cursorPath);
    const cursorBefore = snapshotAll(outside);
    const cursorStore = openStore(job);
    expectCode(() => cursorStore.listHistory({ limit: 1 }), "render_generation_invalid", job.root);
    assertMapsEqual(snapshotAll(outside), cursorBefore);
    assert.equal(lstatSync(cursorPath).isSymbolicLink(), true);
  });

  it("refuses reused staging and exclusive-create writes so the outside tree and bytes stay frozen", () => {
    const injected = (n: number) => Buffer.alloc(n, 0x11);
    const stagingName = `.staging-${G0_LEGACY_ORIGINAL_ID}-11111111`;

    const manifestJob = seedJob({ id: "b11111111111" });
    const manifestOutside = makeTestTempDir("beian-rg-out-");
    writeFileSync(join(manifestOutside, "SENTINEL"), "UNCHANGED");
    mkdirSync(join(manifestOutside, "nested"));
    writeFileSync(join(manifestOutside, "nested", "keep.bin"), Buffer.from("abc"));
    const staging = join(manifestJob.root, RENDER_GENERATION_DIR, stagingName);
    mkdirSync(join(staging, "outputs"), { recursive: true });
    symlinkSync(join(manifestOutside, "SENTINEL"), join(staging, "generation.json"));
    const manifestBefore = snapshotAll(manifestOutside);
    expectCode(
      () => importG0(openStore(manifestJob, { randomBytes: injected })),
      "render_generation_invalid",
      manifestJob.root,
    );
    assertOutsideFrozen(manifestOutside, manifestBefore);
    assert.equal(readFileSync(join(manifestOutside, "SENTINEL"), "utf8"), "UNCHANGED");
    assert.equal(lstatSync(join(staging, "generation.json")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(staging, "generation.json")), join(manifestOutside, "SENTINEL"));
    assert.equal(existsSync(join(manifestJob.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID)), false);
    assert.equal(existsSync(join(manifestJob.root, "job.json")), false);

    const danglingJob = seedJob({ id: "b22222222222" });
    const danglingOutside = makeTestTempDir("beian-rg-out-");
    writeFileSync(join(danglingOutside, "SENTINEL"), "keep-dangling");
    mkdirSync(join(danglingJob.root, RENDER_GENERATION_DIR));
    const danglingTarget = join(danglingOutside, "missing-staging-target");
    symlinkSync(danglingTarget, join(danglingJob.root, RENDER_GENERATION_DIR, stagingName));
    const danglingBefore = snapshotAll(danglingOutside);
    expectCode(
      () => importG0(openStore(danglingJob, { randomBytes: injected })),
      "render_generation_invalid",
      danglingJob.root,
    );
    assertOutsideFrozen(danglingOutside, danglingBefore);
    assert.equal(existsSync(danglingTarget), false);
    assert.equal(lstatSync(join(danglingJob.root, RENDER_GENERATION_DIR, stagingName)).isSymbolicLink(), true);

    const reuseJob = seedJob({ id: "b33333333333" });
    const reuseStaging = join(reuseJob.root, RENDER_GENERATION_DIR, stagingName);
    mkdirSync(join(reuseStaging, "outputs"), { recursive: true });
    writeFileSync(join(reuseStaging, "marker"), "pre-existing-staging");
    expectCode(
      () => importG0(openStore(reuseJob, { randomBytes: injected })),
      "render_generation_invalid",
      reuseJob.root,
    );
    assert.equal(readFileSync(join(reuseStaging, "marker"), "utf8"), "pre-existing-staging");
    assert.equal(existsSync(join(reuseStaging, "generation.json")), false);
    assert.equal(existsSync(join(reuseJob.root, RENDER_GENERATION_DIR, G0_LEGACY_ORIGINAL_ID)), false);
    const reused = importG0(openStore(reuseJob));
    assert.equal(reused.generation_id, G0_LEGACY_ORIGINAL_ID);
    assert.equal(readFileSync(join(reuseStaging, "marker"), "utf8"), "pre-existing-staging");

    const hardManifestJob = seedJob({ id: "b44444444444" });
    const hardManifestOutside = makeTestTempDir("beian-rg-out-");
    const hardSentinel = join(hardManifestOutside, "SENTINEL");
    writeFileSync(hardSentinel, "HARD-MANIFEST");
    const hardStaging = join(hardManifestJob.root, RENDER_GENERATION_DIR, stagingName);
    mkdirSync(join(hardStaging, "outputs"), { recursive: true });
    linkSync(hardSentinel, join(hardStaging, "generation.json"));
    const hardManifestBefore = snapshotAll(hardManifestOutside);
    expectCode(
      () => importG0(openStore(hardManifestJob, { randomBytes: injected })),
      "render_generation_invalid",
      hardManifestJob.root,
    );
    assertOutsideFrozen(hardManifestOutside, hardManifestBefore);
    assert.equal(readFileSync(hardSentinel, "utf8"), "HARD-MANIFEST");
    assert.equal(lstatSync(join(hardStaging, "generation.json")).nlink, 2);

    const indexJob = seedJob({ id: "b55555555555" });
    const indexOutside = makeTestTempDir("beian-rg-out-");
    writeFileSync(join(indexOutside, "SENTINEL"), "keep-index");
    const indexStore = openStore(indexJob, {
      failpoints: { afterRenameBeforeIndex: () => { throw new Error("fail-after-rename"); } },
    });
    assert.throws(() => importG0(indexStore), /fail-after-rename/);
    const indexPath = join(indexJob.root, RENDER_GENERATION_DIR, "index.jsonl");
    const stolenIndex = join(indexOutside, "stolen-index.jsonl");
    writeFileSync(stolenIndex, "keep-index-bytes\n");
    if (existsSync(indexPath)) unlinkSync(indexPath);
    linkSync(stolenIndex, indexPath);
    const indexBefore = snapshotAll(indexOutside);
    expectCode(() => indexStore.recoverOrphans(), "render_generation_invalid", indexJob.root);
    expectCode(
      () => openStore(indexJob).sealGeneration({
        mode: "upgrade",
        contractSha256: CONTRACT_SHA,
        profile: "packshot-neutral-v1",
        sources: writeUpgradeSources(indexJob.root, "hard-index"),
        observedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
        expectedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
      }),
      "render_generation_invalid",
      indexJob.root,
    );
    assertOutsideFrozen(indexOutside, indexBefore);
    assert.equal(readFileSync(stolenIndex, "utf8"), "keep-index-bytes\n");
    assert.equal(lstatSync(stolenIndex).nlink, 2);

    const cursorJob = seedJob({ id: "b66666666666" });
    const cursorOutside = makeTestTempDir("beian-rg-out-");
    writeFileSync(join(cursorOutside, "SENTINEL"), "keep-cursor");
    const cursorStore = openStore(cursorJob);
    importG0(cursorStore);
    cursorStore.sealGeneration({
      mode: "upgrade",
      contractSha256: CONTRACT_SHA,
      profile: "packshot-neutral-v1",
      sources: writeUpgradeSources(cursorJob.root, "hard-cursor"),
      observedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
      expectedCurrentGenerationId: G0_LEGACY_ORIGINAL_ID,
    });
    const cursorPath = join(cursorJob.root, RENDER_GENERATION_DIR, ".cursor-key");
    const stolenCursor = join(cursorOutside, "stolen-cursor");
    writeFileSync(stolenCursor, existsSync(cursorPath) ? readFileSync(cursorPath) : Buffer.from("ab".repeat(32)));
    if (existsSync(cursorPath)) unlinkSync(cursorPath);
    linkSync(stolenCursor, cursorPath);
    const cursorBefore = snapshotAll(cursorOutside);
    expectCode(() => openStore(cursorJob).listHistory({ limit: 1 }), "render_generation_invalid", cursorJob.root);
    assertOutsideFrozen(cursorOutside, cursorBefore);
    assert.equal(readFileSync(stolenCursor).equals(readFileSync(cursorPath)), true);
    assert.equal(lstatSync(stolenCursor).nlink, 2);
    assert.equal(lstatSync(cursorPath).isSymbolicLink(), false);
  });
});
