import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOX_FACE_ROLES,
  selectedFaceDecisions,
  structureIssueCopy,
  structurePolygonPoints,
  structureStatusLabel,
  structureViewBox,
  type FaceChoice,
} from "./mockupStructure.js";

const faces = BOX_FACE_ROLES.map((role, index) => ({
  id: `f${index}`,
  bounds_mm: [index * 10, 0, index * 10 + 10, 20] as [number, number, number, number],
  centroid_mm: [index * 10 + 5, 10] as [number, number],
  size_mm: [10, 20] as [number, number],
  rectangular: true,
  role,
}));

describe("mockup V2 structure UX", () => {
  it("distinguishes a human confirmation from a failed mockup", () => {
    assert.equal(structureStatusLabel({ structure_status: "review_required" }), "待确认结构");
    assert.equal(structureStatusLabel({ structure_status: "unsupported" }), "结构暂不支持");
    assert.match(
      structureIssueCopy({ structure_code: "structure_semantics_missing" }),
      /packaging:cut.*packaging:crease/,
    );
  });

  it("requires six unique rectangular roles", () => {
    const choices = Object.fromEntries(
      faces.map((face) => [face.id, { role: face.role, quarterTurns: 0 } satisfies FaceChoice]),
    );
    const decisions = selectedFaceDecisions(faces, choices);
    assert.equal(decisions?.length, 6);
    assert.deepEqual(decisions?.map((item) => item.role), BOX_FACE_ROLES);
    choices.f1 = { role: "front", quarterTurns: 0 };
    assert.equal(selectedFaceDecisions(faces, choices), null);
  });

  it("builds a padded SVG viewBox around all proposed faces", () => {
    const viewBox = structureViewBox(faces);
    assert.ok(viewBox[0] < 0);
    assert.ok(viewBox[2] > 60);
    assert.ok(viewBox[3] > 20);
  });

  it("keeps the real outline available for rotated or non-axis-aligned faces", () => {
    const outlined = {
      ...faces[0],
      points_mm: [[0, 5], [5, 0], [10, 5], [5, 10]] as Array<[number, number]>,
    };
    assert.equal(structurePolygonPoints(outlined), "0,5 5,0 10,5 5,10");
    assert.equal(structurePolygonPoints(faces[1]), null);
  });
});
