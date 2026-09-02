import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listedReadFaces, readFaceKey } from "./mockupReadFaces.js";

describe("listedReadFaces", () => {
  it("keeps print faces in wrap order and ignores white stills", () => {
    assert.deepEqual(
      listedReadFaces([
        { key: "white_a" },
        { key: "read_back" },
        { key: "glb" },
        { key: "read_top" },
        { key: "read_front" },
        { key: "read_mystery" },
      ]),
      ["front", "back", "top"],
    );
  });

  it("keeps wrap order for all six print faces", () => {
    assert.deepEqual(
      listedReadFaces([
        { key: "read_bottom" },
        { key: "read_left" },
        { key: "read_top" },
        { key: "read_right" },
        { key: "read_back" },
        { key: "read_front" },
        { key: "white_a" },
      ]),
      ["front", "back", "right", "left", "top", "bottom"],
    );
  });

  it("is empty when the job has no panel rasters", () => {
    assert.deepEqual(listedReadFaces([{ key: "white_a" }, { key: "white_b" }, { key: "glb" }]), []);
  });
});

describe("readFaceKey", () => {
  it("uses the files API key, not the white-still names", () => {
    assert.equal(readFaceKey("front"), "read_front");
    assert.equal(readFaceKey("back"), "read_back");
  });
});
