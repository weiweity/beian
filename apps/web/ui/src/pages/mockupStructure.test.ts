import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "../api.js";
import {
  illustratorLayerPreviewD,
  illustratorPreviewPathD,
  preferredStructureTurn,
  sameStructureLayerSelection,
  selectedStructureLayerIds,
  defaultStructureLayerIds,
  shouldAutoSubmitStructureLayers,
  selectedStructureAnchor,
  structureConfirmationErrorCopy,
  structureIssueCopy,
  structurePolygonPoints,
  structureProposalHasRealPolygons,
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
  it("renders straight and bezier Illustrator paths without flattening the visual preview", () => {
    const straight: NonNullable<NonNullable<import("../api.js").MockupJob["structure_input"]>["preview"]>["layers"][number]["paths"][number] = {
      closed: false,
      points: [
        [10, 20, 10, 20, 10, 20],
        [40, 50, 40, 50, 40, 50],
      ],
    };
    const curve: typeof straight = {
      closed: true,
      points: [
        [0, 0, 0, 0, 10, 0],
        [20, 20, 20, 10, 20, 20],
      ],
    };
    assert.equal(illustratorPreviewPathD(straight), "M 10 20 L 40 50");
    assert.equal(
      illustratorPreviewPathD(curve),
      "M 0 0 C 10 0 20 10 20 20 L 0 0 Z",
    );
    assert.equal(
      illustratorLayerPreviewD([straight, curve]),
      "M 10 20 L 40 50 M 0 0 C 10 0 20 10 20 20 L 0 0 Z",
    );
    assert.equal(illustratorPreviewPathD({ closed: false, points: [[0, 0, 0, 0, 0, 0]] }), "");
    assert.equal(
      illustratorLayerPreviewD([{ closed: false, points: [[0, 0, 0, 0, 0, 0]] }, straight]),
      "M 10 20 L 40 50",
    );
  });

  it("keeps only current candidate ids in server order and caps one selection at sixteen", () => {
    const proposalLayers = Array.from({ length: 18 }, (_, index) => ({
      id: `proposal-layer-${index.toString(16).padStart(16, "0")}`,
      name: `结构层 ${index + 1}`,
      stroke_only_path_count: index + 1,
    }));
    const input = {
      schema: "packaging-structure-input-candidates/2" as const,
      proposal_layers: proposalLayers,
      selected_ids: [proposalLayers[0].id],
      truncated: false,
    };
    const selected = selectedStructureLayerIds(input, [
      "proposal-layer-ffffffffffffffff",
      ...proposalLayers.slice().reverse().map((candidate) => candidate.id),
    ]);
    assert.deepEqual(selected, proposalLayers.slice(0, 16).map((candidate) => candidate.id));
    assert.equal(sameStructureLayerSelection(input, [proposalLayers[0].id]), true);
    assert.equal(sameStructureLayerSelection(input, [proposalLayers[1].id]), false);
  });

  it("preselects a unique 刀线 layer and never treats a preview plate as selected structure", () => {
    const cut = {
      id: "proposal-layer-aaaaaaaaaaaaaaaa",
      name: "刀线",
      stroke_only_path_count: 8,
    };
    const crease = {
      id: "proposal-layer-bbbbbbbbbbbbbbbb",
      name: "折线",
      stroke_only_path_count: 4,
    };
    const empty = {
      schema: "packaging-structure-input-candidates/2" as const,
      proposal_layers: [cut, crease],
      selected_ids: [],
      truncated: false,
      preview_plates: [{ id: "preview-plate-cccccccccccccccc", name: "烫雅银" }],
    };
    assert.deepEqual(defaultStructureLayerIds(empty), [cut.id]);
    assert.deepEqual(selectedStructureLayerIds(empty, [empty.preview_plates![0].id]), []);
    const already = { ...empty, selected_ids: [crease.id] };
    assert.deepEqual(defaultStructureLayerIds(already), [crease.id]);
    const duplicateCuts = {
      ...empty,
      proposal_layers: [cut, { ...cut, id: "proposal-layer-dddddddddddddddd", name: "刀线" }],
    };
    assert.deepEqual(defaultStructureLayerIds(duplicateCuts), []);
    assert.equal(shouldAutoSubmitStructureLayers(empty), false);
    const topCut = { ...cut, name: "上刀线" };
    const print = { id: "proposal-layer-eeeeeeeeeeeeeeee", name: "印刷", stroke_only_path_count: 2 };
    const usual = {
      ...empty,
      proposal_layers: [topCut, crease, print],
    };
    assert.deepEqual(defaultStructureLayerIds(usual), [topCut.id, print.id]);
    assert.equal(shouldAutoSubmitStructureLayers(usual), true);
    assert.deepEqual(
      selectedStructureLayerIds(usual, [usual.preview_plates![0].id, print.id]),
      [print.id],
    );
    const onlyPrint = { ...empty, proposal_layers: [print] };
    assert.deepEqual(defaultStructureLayerIds(onlyPrint), []);
    assert.equal(shouldAutoSubmitStructureLayers(onlyPrint), false);
    assert.equal(shouldAutoSubmitStructureLayers(already), false);
    assert.equal(shouldAutoSubmitStructureLayers({ ...empty, proposal_layers: [] }), false);
    assert.equal(shouldAutoSubmitStructureLayers({ ...empty, proposal_layers: [crease] }), false);
    assert.equal(shouldAutoSubmitStructureLayers(duplicateCuts), false);
    assert.equal(shouldAutoSubmitStructureLayers({ ...empty, proposal_layers: [print, crease] }), false);
    const topOnly = { ...empty, proposal_layers: [topCut, crease] };
    assert.deepEqual(defaultStructureLayerIds(topOnly), [topCut.id]);
    assert.equal(shouldAutoSubmitStructureLayers(topOnly), true);
    const loneCut = { ...empty, proposal_layers: [cut] };
    assert.deepEqual(defaultStructureLayerIds(loneCut), [cut.id]);
    assert.equal(shouldAutoSubmitStructureLayers(loneCut), true);
    const otherCut = { id: "proposal-layer-ffffffffffffffff", name: "刀线", stroke_only_path_count: 8 };
    const bothCuts = { ...empty, proposal_layers: [topCut, otherCut, print] };
    assert.deepEqual(defaultStructureLayerIds(bothCuts), [topCut.id, print.id]);
    assert.equal(shouldAutoSubmitStructureLayers(bothCuts), true);
    const board = { ...cut, id: "proposal-layer-bbbbbbbbbbbbbb01", name: "刀版" };
    const boardOnly = { ...empty, proposal_layers: [board, crease, print] };
    assert.deepEqual(defaultStructureLayerIds(boardOnly), [board.id, print.id]);
    assert.equal(shouldAutoSubmitStructureLayers(boardOnly), false);
    const bothKnives = { ...empty, proposal_layers: [cut, board] };
    assert.deepEqual(defaultStructureLayerIds(bothKnives), []);
    const printOnly = { ...empty, proposal_layers: [print] };
    assert.deepEqual(defaultStructureLayerIds(printOnly), []);
    assert.equal(shouldAutoSubmitStructureLayers(printOnly), false);
  });

  it("distinguishes a human confirmation from a failed mockup", () => {
    assert.equal(structureStatusLabel({ structure_status: "analyzing" }), "正在出图");
    assert.equal(structureStatusLabel({ structure_status: "review_required" }), "打样失败");
    assert.equal(
      structureStatusLabel({
        structure_status: "review_required",
        structure_code: "structure_face_mapping_incomplete",
      }),
      "待选正面",
    );
    assert.equal(structureStatusLabel({ structure_status: "unsupported" }), "结构暂不支持");
    assert.match(
      structureIssueCopy({ structure_code: "structure_semantics_missing" }),
      /没有可自动识别的刀版/,
    );
    assert.match(
      structureIssueCopy({ structure_code: "structure_semantics_missing" }, { desk: true }),
      /请勾选「刀版」或「刀线」/,
    );
    assert.doesNotMatch(
      structureIssueCopy({ structure_code: "structure_semantics_missing" }),
      /packaging:cut/,
    );
    assert.match(structureIssueCopy({ structure_code: "structure_box_net_missing" }), /不是一个完整花盒/);
    assert.match(
      structureIssueCopy({ structure_code: "structure_box_net_missing" }, { desk: true }),
      /组不成花盒/,
    );
    assert.match(
      structureIssueCopy({ structure_code: "structure_multiple_components" }),
      /有多套盒型，当前不能自动选/,
    );
    assert.match(
      structureIssueCopy({ structure_code: "structure_multiple_components" }, { desk: true }),
      /多套可成盒结构/,
    );
    assert.equal(structureIssueCopy({}), "这张稿现在打不了样。");
    assert.equal(
      structureIssueCopy({}, { desk: true }),
      "包装结构需要人工确认后才能进入 Blender。",
    );
    assert.match(
      structureIssueCopy({ structure_code: "structure_flattened_artwork" }),
      /拼合稿/,
    );
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

  it("fails a proposed net closed unless every displayed face has its real polygon", () => {
    const polygonFaces = faces.map((face) => ({
      ...face,
      points_mm: [[
        face.bounds_mm[0],
        face.bounds_mm[1],
      ], [
        face.bounds_mm[2],
        face.bounds_mm[1],
      ], [
        face.bounds_mm[2],
        face.bounds_mm[3],
      ]] as Array<[number, number]>,
    }));
    const proposal = {
      schema: "box-net-proposal/3" as const,
      id: "box-net-0001",
      face_ids: polygonFaces.map((face) => face.id),
      body_face_ids: polygonFaces.slice(0, 4).map((face) => face.id) as [string, string, string, string],
      cap_face_ids: polygonFaces.slice(4, 6).map((face) => face.id) as [string, string],
      strip_axis: "x" as const,
      closure_assemblies: [],
    };

    assert.equal(structureProposalHasRealPolygons(proposal, polygonFaces), true);
    assert.equal(structureProposalHasRealPolygons(proposal, polygonFaces.slice(1)), false);
    assert.equal(structureProposalHasRealPolygons(proposal, faces), false);
  });
});
