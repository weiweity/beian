import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "../api.js";
import {
  preferredStructureTurn,
  selectedStructureAnchor,
  structureConfirmationErrorCopy,
  structureIssueCopy,
  structurePolygonPoints,
  structureStatusLabel,
  structureViewBox,
  validTurnsForFace,
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
    assert.match(structureIssueCopy({ structure_code: "structure_box_net_missing" }), /不会按颜色/);
    assert.match(structureIssueCopy({ structure_code: "structure_limit_exceeded" }), /安全上限/);
  });

  it("turns semantic confirmation failures into an actionable inline retry", () => {
    assert.match(
      structureConfirmationErrorCopy(new ApiError(409, "stale", false, "structure_confirmation_stale")),
      /刷新本单/,
    );
    assert.equal(
      structureConfirmationErrorCopy(new ApiError(409, "这单结构正在确认，请稍候")),
      "这单结构正在确认，请稍候",
    );
    assert.match(
      structureConfirmationErrorCopy(new ApiError(422, "invalid", false, "structure_fold_graph_invalid")),
      /整理真实刀线和折线/,
    );
    assert.match(
      structureConfirmationErrorCopy(new ApiError(422, "invalid", false, "artwork_transform_invalid")),
      /成盒预检/,
    );
  });

  it("accepts one front anchor only when it belongs to the chosen complete net", () => {
    const proposal = {
      schema: "box-net-proposal/3" as const,
      id: "box-net-0001",
      face_ids: faces.map((face) => face.id),
      body_face_ids: [faces[0].id, faces[1].id, faces[2].id, faces[3].id] as [string, string, string, string],
      cap_face_ids: [faces[4].id, faces[5].id] as [string, string],
      strip_axis: "x" as const,
      valid_anchors: [{
        front_face_id: faces[1].id,
        quarter_turns: [0, 2] as Array<0 | 2>,
        preferred_quarter_turns: 2 as const,
      }],
      closure_assemblies: [
        {
          primary_face_id: faces[4].id,
          side: -1 as const,
          extent: "full" as const,
          closure_kind: "full" as const,
          coverage_ratio: 1,
          members: [{
            face_id: faces[4].id,
            attached_body_face_id: faces[0].id,
            extent: "full" as const,
            coverage_ratio: 1,
          }],
        },
        {
          primary_face_id: faces[5].id,
          side: 1 as const,
          extent: "full" as const,
          closure_kind: "full" as const,
          coverage_ratio: 1,
          members: [{
            face_id: faces[5].id,
            attached_body_face_id: faces[2].id,
            extent: "full" as const,
            coverage_ratio: 1,
          }],
        },
      ],
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

  it("uses only a complete engine recommendation and fails old waiting records closed", () => {
    const proposal = {
      schema: "box-net-proposal/3" as const,
      id: "box-net-0123456789abcdef",
      face_ids: faces.map((face) => face.id),
      body_face_ids: [faces[0].id, faces[1].id, faces[2].id, faces[3].id] as [string, string, string, string],
      cap_face_ids: [faces[4].id, faces[5].id] as [string, string],
      strip_axis: "x" as const,
      dimensions_mm: { width: 30, depth: 20, height: 50 },
      valid_anchors: [{
        front_face_id: faces[1].id,
        quarter_turns: [0, 2] as Array<0 | 2>,
        preferred_quarter_turns: 2 as const,
      }],
      closure_assemblies: [
        {
          primary_face_id: faces[4].id,
          side: -1 as const,
          extent: "partial" as const,
          closure_kind: "clearance" as const,
          coverage_ratio: 0.94,
          members: [{
            face_id: faces[4].id,
            attached_body_face_id: faces[0].id,
            extent: "partial" as const,
            coverage_ratio: 0.94,
          }],
        },
        {
          primary_face_id: faces[5].id,
          side: 1 as const,
          extent: "full" as const,
          closure_kind: "full" as const,
          coverage_ratio: 1,
          members: [{
            face_id: faces[5].id,
            attached_body_face_id: faces[0].id,
            extent: "full" as const,
            coverage_ratio: 1,
          }],
        },
      ],
    };

    assert.deepEqual(validTurnsForFace(proposal, faces[1].id), [0, 2]);
    assert.deepEqual(validTurnsForFace(proposal, faces[0].id), []);
    assert.equal(preferredStructureTurn(proposal, faces[1].id), 2);
    assert.equal(
      preferredStructureTurn({
        ...proposal,
        valid_anchors: [{ front_face_id: faces[1].id, quarter_turns: [0, 2] }],
      }, faces[1].id),
      null,
    );
    assert.deepEqual(validTurnsForFace({ ...proposal, valid_anchors: undefined }, faces[1].id), []);
    assert.equal(preferredStructureTurn(proposal, faces[0].id), null);
    assert.equal(selectedStructureAnchor(proposal, faces[1].id, 1), null);
    assert.deepEqual(selectedStructureAnchor(proposal, faces[1].id, 2), {
      proposal_id: proposal.id,
      front_face_id: faces[1].id,
      quarter_turns: 2,
    });
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
