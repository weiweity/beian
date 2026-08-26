import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "../../../..");
const script = readFileSync(resolve(root, "scripts/dev-start.sh"), "utf8");
const serverPackage = JSON.parse(
  readFileSync(resolve(root, "apps/web/server/package.json"), "utf8"),
) as { version?: string };

describe("dev-start dependency contract", () => {
  it("checks the installed workspace layout and installs at most once", () => {
    assert.match(script, /node_modules\/\.bin\/tsx/);
    assert.match(script, /apps\/web\/ui\/node_modules\/\.bin\/vite/);
    assert.match(script, /node_modules\/@google\/model-viewer/);
    assert.equal((script.match(/\bnpm install\b/g) || []).length, 1);
    assert.doesNotMatch(script, /SERVER\/node_modules/);
    assert.doesNotMatch(script, /ui\/node_modules\/@google/);
  });

  it("keeps the workspace package version valid semver", () => {
    assert.match(String(serverPackage.version || ""), /^\d+\.\d+\.\d+$/);
  });
});
