import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  selectedStructureAnchor,
  structureIssueCopy,
  structurePolygonPoints,
  structureStatusLabel,
  structureViewBox,
} from "./mockupStructure.js";

const faces = ["front", "right", "back", "left", "top", "bottom"].map((_role, index) => ({
  id: `f${index}`,
  bounds_mm: [index * 10, 0, index * 10 + 10, 20] as [number, number, number, number],
  centroid_mm: [index * 10 + 5, 10] as [number, number],
  size_mm: [10, 20] as [number, number],
  rectangular: true,
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

  it("accepts one front anchor only when it belongs to the chosen complete net", () => {
    const proposal = {
      id: "box-net-0001",
      face_ids: faces.map((face) => face.id),
      body_face_ids: [faces[0].id, faces[1].id, faces[2].id, faces[3].id] as [string, string, string, string],
      cap_face_ids: [faces[4].id, faces[5].id] as [string, string],
      strip_axis: "x" as const,
    };
    assert.deepEqual(selectedStructureAnchor(proposal, faces[1].id, 2), {
      proposal_id: proposal.id,
      front_face_id: faces[1].id,
      quarter_turns: 2,
    });
    assert.equal(selectedStructureAnchor(proposal, faces[5].id, 0), null);
    assert.equal(selectedStructureAnchor(proposal, "missing", 0), null);
    assert.equal(selectedStructureAnchor(undefined, faces[0].id, 0), null);
  });

  it("builds a padded SVG viewBox around all proposed faces", () => {
    const viewBox = structureViewBox(faces);
    assert.ok(viewBox[0] < 0);
    assert.ok(viewBox[2] > 60);
    assert.ok(viewBox[3] > 20);
    assert.deepEqual(structureViewBox([]), [0, 0, 1, 1]);
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
