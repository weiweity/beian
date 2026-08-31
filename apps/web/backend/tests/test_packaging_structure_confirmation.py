from __future__ import annotations

import hashlib
import json
import math
from copy import deepcopy
from pathlib import Path
import sys

import pytest


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
if str(PACKAGING) not in sys.path:
    sys.path.insert(0, str(PACKAGING))

from packaging_structure_fixture import semantic_box  # noqa: E402
from structure_v2 import (  # noqa: E402
    StructureConfirmationError,
    canonicalize_structure,
    confirm_structure,
    resolve_structure_payload,
)


def anchor_proposal_files(
    tmp_path: Path,
    *,
    cap_body_role: str = "front",
    net_axis: str = "x",
    width: float = 30.0,
    depth: float = 20.0,
    height: float = 50.0,
    cap_clearance: float = 0.0,
    top_cap_depth: float | None = None,
    bottom_cap_depth: float | None = None,
    rotation_degrees: float = 0.0,
    body_width_overrides: dict[str, float] | None = None,
):
    source = tmp_path / "source.ai"
    source.write_bytes(b"semantic-anchor-confirmation-fixture")
    payload = semantic_box(
        source_hash=hashlib.sha256(source.read_bytes()).hexdigest(),
        cap_body_role=cap_body_role,
        net_axis=net_axis,
        width=width,
        depth=depth,
        height=height,
        cap_clearance=cap_clearance,
        top_cap_depth=top_cap_depth,
        bottom_cap_depth=bottom_cap_depth,
        body_width_overrides=body_width_overrides,
    )
    if rotation_degrees:
        angle = math.radians(rotation_degrees)
        cosine = math.cos(angle)
        sine = math.sin(angle)
        for vertex in payload["vertices"]:
            x = float(vertex["x"])
            y = float(vertex["y"])
            vertex["x"] = x * cosine - y * sine
            vertex["y"] = x * sine + y * cosine
    vertices = {item["id"]: (item["x"], item["y"]) for item in payload["vertices"]}
    edges = {item["id"]: item for item in payload["edges"]}
    declared_front = next(face for face in payload["faces"] if face["role"] == "front")
    front_points = {
        vertices[vertex_id]
        for edge_id in declared_front["boundary"]
        for vertex_id in (edges[edge_id]["start"], edges[edge_id]["end"])
    }
    expected_front_bounds = (
        round(min(point[0] for point in front_points), 6),
        round(min(point[1] for point in front_points), 6),
        round(max(point[0] for point in front_points), 6),
        round(max(point[1] for point in front_points), 6),
    )
    payload["source"]["adapter"] = "illustrator-stroke-proposal/1"
    payload["faces"] = []
    payload["folds"] = []
    payload["root_face"] = None
    payload["validation"] = {
        "status": "review_required",
        "errors": ["structure_proposal_requires_confirmation"],
        "warnings": [],
    }
    proposed = resolve_structure_payload(payload).as_dict()
    resolution = tmp_path / "structure_resolution.json"
    resolution.write_text(json.dumps(proposed), encoding="utf-8")
    net = proposed["topology"]["net_proposals"][0]
    front = next(
        face
        for face in proposed["topology"]["face_proposal"]
        if tuple(face["bounds_mm"]) == expected_front_bounds
    )
    return source, resolution, proposed, net, front


def write_resolution(path: Path, payload: dict) -> None:
    payload["structure"].pop("structure_hash", None)
    payload["structure"] = canonicalize_structure(payload["structure"])
    topology = payload.get("topology")
    if isinstance(topology, dict):
        for proposal in topology.get("net_proposals", []):
            if isinstance(proposal, dict) and "structure_hash" in proposal:
                proposal["structure_hash"] = payload["structure"]["structure_hash"]
    path.write_text(json.dumps(payload), encoding="utf-8")


def confirm_anchor(
    source: Path,
    resolution: Path,
    proposal_id: str,
    front_face_id: str,
    quarter_turns,
    output: Path,
):
    return confirm_structure(
        source=source,
        resolution_path=resolution,
        decisions={
            "anchor": {
                "proposal_id": proposal_id,
                "front_face_id": front_face_id,
                "quarter_turns": quarter_turns,
            }
        },
        output_path=output,
    )


def test_confirmation_binds_source_and_writes_an_accepted_sidecar(tmp_path: Path):
    source, resolution, _proposed, net, front = anchor_proposal_files(tmp_path)
    output = tmp_path / "approved.structure.json"
    result = confirm_anchor(source, resolution, net["id"], front["id"], 0, output)
    assert result["ok"] is True
    assert result["dimensions_mm"] == {"width": 30.0, "depth": 20.0, "height": 50.0}
    approved = json.loads(output.read_text(encoding="utf-8"))
    assert approved["validation"]["status"] == "accepted"
    assert {face["role"] for face in approved["faces"]} >= {
        "front",
        "right",
        "back",
        "left",
        "top",
        "bottom",
    }
    assert resolve_structure_payload(approved).status == "ready"


def test_confirmation_and_proposal_share_opposite_panel_dimension_averages(tmp_path: Path):
    source, resolution, _proposed, net, front = anchor_proposal_files(
        tmp_path,
        top_cap_depth=19.5,
        bottom_cap_depth=19.5,
        body_width_overrides={"back": 29.0, "left": 19.0, "front": 30.0, "right": 20.0},
    )

    result = confirm_anchor(source, resolution, net["id"], front["id"], 0, tmp_path / "drift.json")

    assert net["dimensions_mm"] == {"width": 29.5, "depth": 19.5, "height": 50.0}
    assert result["dimensions_mm"] == net["dimensions_mm"]


def test_final_resolver_preflight_hides_every_anchor_that_dimension_averaging_would_reject(tmp_path: Path):
    source = tmp_path / "source.ai"
    source.write_bytes(b"final-resolver-preflight")
    payload = semantic_box(
        source_hash=hashlib.sha256(source.read_bytes()).hexdigest(),
        top_cap_depth=18.6,
        bottom_cap_depth=18.6,
        body_width_overrides={"back": 29.0, "left": 21.0, "front": 30.0, "right": 20.0},
    )
    payload["source"]["adapter"] = "illustrator-stroke-proposal/1"
    payload["faces"] = []
    payload["folds"] = []
    payload["root_face"] = None
    payload["validation"] = {
        "status": "review_required",
        "errors": ["structure_proposal_requires_confirmation"],
        "warnings": [],
    }

    proposed = resolve_structure_payload(payload)

    assert proposed.status == "review_required"
    assert proposed.code == "structure_box_net_missing"
    assert not (proposed.topology or {}).get("net_proposals")


def test_corrupt_confirmation_storage_is_not_reported_as_a_user_semantic_error(tmp_path: Path):
    source = tmp_path / "source.ai"
    source.write_bytes(b"corrupt-confirmation-storage")
    resolution = tmp_path / "structure_resolution.json"
    resolution.write_text("{truncated", encoding="utf-8")

    with pytest.raises(StructureConfirmationError) as raised:
        confirm_structure(
            source=source,
            resolution_path=resolution,
            decisions={"anchor": {}},
            output_path=tmp_path / "never.json",
        )

    assert raised.value.code == "structure_confirmation_storage_invalid"


def test_confirmation_derives_all_six_roles_from_front_anchor(tmp_path: Path):
    source, resolution, _proposed, net, front = anchor_proposal_files(tmp_path)

    output = tmp_path / "approved-anchor.structure.json"
    result = confirm_anchor(
        source,
        resolution,
        net["id"],
        front["id"],
        0,
        output,
    )

    assert result["ok"] is True
    assert result["dimensions_mm"] == {"width": 30.0, "depth": 20.0, "height": 50.0}
    approved = json.loads(output.read_text(encoding="utf-8"))
    assert {face["role"] for face in approved["faces"]} == {
        "front",
        "right",
        "back",
        "left",
        "top",
        "bottom",
    }
    assert approved["root_face"] == front["id"]


@pytest.mark.parametrize("quarter_turns", [True, -1, 4, "1"])
def test_anchor_confirmation_rejects_invalid_quarter_turns(tmp_path: Path, quarter_turns):
    source, resolution, _proposed, net, front = anchor_proposal_files(tmp_path)

    with pytest.raises(StructureConfirmationError) as raised:
        confirm_anchor(
            source,
            resolution,
            net["id"],
            front["id"],
            quarter_turns,
            tmp_path / "never.json",
        )

    assert raised.value.code == "artwork_transform_invalid"


def test_anchor_confirmation_rejects_old_or_expired_net_choices(tmp_path: Path):
    source, resolution, proposed, net, front = anchor_proposal_files(tmp_path)
    without_nets = deepcopy(proposed)
    without_nets["topology"].pop("net_proposals")
    write_resolution(resolution, without_nets)

    with pytest.raises(StructureConfirmationError) as old_choice:
        confirm_anchor(source, resolution, net["id"], front["id"], 0, tmp_path / "old.json")
    assert old_choice.value.code == "structure_confirmation_stale"

    write_resolution(resolution, deepcopy(proposed))
    with pytest.raises(StructureConfirmationError) as missing_choice:
        confirm_anchor(source, resolution, "box-net-9999", front["id"], 0, tmp_path / "missing.json")
    assert missing_choice.value.code == "structure_confirmation_stale"


def test_anchor_confirmation_rejects_a_proposal_bound_to_another_structure(tmp_path: Path):
    source, resolution, proposed, net, front = anchor_proposal_files(tmp_path)
    stale = deepcopy(proposed)
    stale["topology"]["net_proposals"][0]["structure_hash"] = "f" * 64
    resolution.write_text(json.dumps(stale), encoding="utf-8")

    with pytest.raises(StructureConfirmationError) as raised:
        confirm_anchor(source, resolution, net["id"], front["id"], 0, tmp_path / "never.json")

    assert raised.value.code == "structure_confirmation_stale"


def test_anchor_confirmation_keeps_legacy_proposal_basis_compatibility(tmp_path: Path):
    source, resolution, proposed, net, front = anchor_proposal_files(tmp_path)
    legacy = deepcopy(proposed)
    legacy["topology"]["net_proposals"][0].pop("basis_transform", None)
    write_resolution(resolution, legacy)

    result = confirm_anchor(source, resolution, net["id"], front["id"], 0, tmp_path / "legacy.json")

    assert result["ok"] is True


def test_anchor_confirmation_rejects_a_cap_or_malformed_net_as_the_front(tmp_path: Path):
    source, resolution, proposed, net, _front = anchor_proposal_files(tmp_path)

    with pytest.raises(StructureConfirmationError) as cap_front:
        confirm_anchor(
            source,
            resolution,
            net["id"],
            net["cap_face_ids"][0],
            0,
            tmp_path / "cap.json",
        )
    assert cap_front.value.code == "structure_face_mapping_incomplete"

    malformed = deepcopy(proposed)
    malformed["topology"]["net_proposals"][0]["cap_face_ids"] = malformed["topology"]["net_proposals"][0]["cap_face_ids"][:1]
    write_resolution(resolution, malformed)
    with pytest.raises(StructureConfirmationError) as invalid_net:
        confirm_anchor(
            source,
            resolution,
            net["id"],
            net["body_face_ids"][0],
            0,
            tmp_path / "malformed.json",
        )
    assert invalid_net.value.code == "structure_confirmation_invalid"


def test_anchor_confirmation_rejects_a_net_that_references_removed_geometry(tmp_path: Path):
    source, resolution, proposed, net, front = anchor_proposal_files(tmp_path)
    stale = deepcopy(proposed)
    stale_net = stale["topology"]["net_proposals"][0]
    removed_id = stale_net["body_face_ids"][0]
    stale_net["body_face_ids"][0] = "removed-face"
    stale_net["face_ids"] = [
        "removed-face" if face_id == removed_id else face_id
        for face_id in stale_net["face_ids"]
    ]
    write_resolution(resolution, stale)

    with pytest.raises(StructureConfirmationError) as raised:
        confirm_anchor(source, resolution, net["id"], front["id"], 0, tmp_path / "never.json")

    assert raised.value.code == "structure_confirmation_stale"


def test_anchor_confirmation_requires_the_reading_direction_to_follow_the_body_strip(tmp_path: Path):
    source, resolution, _proposed, net, front = anchor_proposal_files(tmp_path)

    with pytest.raises(StructureConfirmationError) as raised:
        confirm_anchor(source, resolution, net["id"], front["id"], 1, tmp_path / "never.json")

    assert raised.value.code == "structure_confirmation_invalid"
    assert "预检" in str(raised.value)


def test_anchor_confirmation_supports_the_reverse_body_reading_direction(tmp_path: Path):
    source, resolution, proposed, net, front = anchor_proposal_files(tmp_path)
    output = tmp_path / "reverse.structure.json"

    result = confirm_anchor(source, resolution, net["id"], front["id"], 2, output)

    assert result["ok"] is True
    approved = json.loads(output.read_text(encoding="utf-8"))
    role_ids = {face["role"]: face["id"] for face in approved["faces"]}
    front_index = net["body_face_ids"].index(front["id"])
    assert role_ids["right"] == net["body_face_ids"][(front_index - 1) % 4]
    assert role_ids["left"] == net["body_face_ids"][(front_index + 1) % 4]
    assert resolve_structure_payload(approved).status == "ready"


def test_anchor_confirmation_supports_a_vertical_carton_net(tmp_path: Path):
    source, resolution, _proposed, net, front = anchor_proposal_files(
        tmp_path,
        net_axis="y",
    )
    output = tmp_path / "vertical.structure.json"

    result = confirm_anchor(source, resolution, net["id"], front["id"], 3, output)

    assert net["strip_axis"] == "y"
    assert result["dimensions_mm"] == {"width": 30.0, "depth": 20.0, "height": 50.0}
    approved = json.loads(output.read_text(encoding="utf-8"))
    assert resolve_structure_payload(approved).status == "ready"


def test_anchor_confirmation_is_invariant_to_a_rotated_source_coordinate_frame(tmp_path: Path):
    source, resolution, _proposed, net, front = anchor_proposal_files(
        tmp_path,
        rotation_degrees=17.0,
    )
    valid = next(item for item in net["valid_anchors"] if item["front_face_id"] == front["id"])
    output = tmp_path / "rotated.structure.json"

    result = confirm_anchor(
        source,
        resolution,
        net["id"],
        front["id"],
        valid["quarter_turns"][0],
        output,
    )

    assert result["ok"] is True
    assert result["dimensions_mm"] == {"width": 30.0, "depth": 20.0, "height": 50.0}
    assert resolve_structure_payload(json.loads(output.read_text(encoding="utf-8"))).status == "ready"


@pytest.mark.parametrize(
    ("cap_body_role", "expected_top", "expected_bottom"),
    [
        ("front", [1.0, 0.0, 0.0, 1.0], [1.0, 0.0, 0.0, 1.0]),
        ("right", [0.0, -1.0, 1.0, 0.0], [0.0, 1.0, -1.0, 0.0]),
        ("back", [-1.0, 0.0, 0.0, -1.0], [-1.0, 0.0, 0.0, -1.0]),
        ("left", [0.0, 1.0, -1.0, 0.0], [0.0, -1.0, 1.0, 0.0]),
    ],
)
def test_anchor_confirmation_orients_caps_from_their_folded_body_face(
    tmp_path: Path,
    cap_body_role: str,
    expected_top: list[float],
    expected_bottom: list[float],
):
    source, resolution, _proposed, net, front = anchor_proposal_files(
        tmp_path,
        cap_body_role=cap_body_role,
    )
    output = tmp_path / "side-attached-caps.structure.json"

    result = confirm_anchor(source, resolution, net["id"], front["id"], 0, output)

    assert result["ok"] is True
    approved = json.loads(output.read_text(encoding="utf-8"))
    transforms = {
        face["role"]: face["artwork_transform"][:4]
        for face in approved["faces"]
    }
    assert transforms["top"] == expected_top
    assert transforms["bottom"] == expected_bottom
    assert resolve_structure_payload(approved).status == "ready"


def test_anchor_confirmation_uses_the_fold_to_orient_square_caps(tmp_path: Path):
    source, resolution, _proposed, net, front = anchor_proposal_files(
        tmp_path,
        cap_body_role="right",
        width=30.0,
        depth=30.0,
    )
    output = tmp_path / "square-caps.structure.json"

    result = confirm_anchor(source, resolution, net["id"], front["id"], 0, output)

    assert result["ok"] is True
    approved = json.loads(output.read_text(encoding="utf-8"))
    transforms = {face["role"]: face["artwork_transform"][:4] for face in approved["faces"]}
    assert transforms["top"] == [0.0, -1.0, 1.0, 0.0]
    assert transforms["bottom"] == [0.0, 1.0, -1.0, 0.0]


def test_anchor_confirmation_accepts_common_closure_flap_clearance(tmp_path: Path):
    source, resolution, _proposed, net, front = anchor_proposal_files(
        tmp_path,
        cap_clearance=1.2,
    )
    output = tmp_path / "clearance.structure.json"

    result = confirm_anchor(source, resolution, net["id"], front["id"], 0, output)

    assert result["ok"] is True
    # Physical box dimensions come from the four body panels. Normal main-panel
    # clearance must not shrink the erected carton.
    assert result["dimensions_mm"] == {"width": 30.0, "depth": 20.0, "height": 50.0}
    approved = json.loads(output.read_text(encoding="utf-8"))
    assert approved["validation"]["warnings"] == ["closure_clearance_padded"]
    cap_transforms = [
        face["artwork_transform"][:4]
        for face in approved["faces"]
        if face["role"] in {"top", "bottom"}
    ]
    assert all(
        sorted(abs(value) for value in transform) == [0.0, 0.0, 1.0, 1.0]
        for transform in cap_transforms
    )
    resolved = resolve_structure_payload(approved)
    assert resolved.status == "ready"
    for role in ("top", "bottom"):
        coverage = resolved.resolved["faces"][role]["artwork_coverage_bounds_mm"]
        assert round((coverage[2] - coverage[0]) * (coverage[3] - coverage[1]), 3) == 564.0
        assert coverage[0] == 0.0
        assert coverage[2] == 30.0
        assert coverage[1] == 0.0 or coverage[3] == 20.0


def test_short_flap_cannot_be_promoted_to_a_top_face_or_swap_width_and_depth():
    payload = semantic_box(cap_body_role="right", top_cap_depth=8.0)
    payload["source"]["adapter"] = "illustrator-stroke-proposal/1"
    payload["faces"] = []
    payload["folds"] = []
    payload["root_face"] = None
    payload["validation"] = {
        "status": "review_required",
        "errors": ["structure_proposal_requires_confirmation"],
        "warnings": [],
    }

    proposed = resolve_structure_payload(payload)

    assert proposed.status == "review_required"
    assert proposed.code == "structure_box_net_missing"
    assert not (proposed.topology or {}).get("net_proposals")


def test_anchor_confirmation_rejects_a_tampered_strip_axis(tmp_path: Path):
    source, resolution, proposed, net, front = anchor_proposal_files(tmp_path)
    tampered = deepcopy(proposed)
    tampered["topology"]["net_proposals"][0]["strip_axis"] = "y"
    write_resolution(resolution, tampered)

    with pytest.raises(StructureConfirmationError) as raised:
        confirm_anchor(source, resolution, net["id"], front["id"], 0, tmp_path / "never.json")

    assert raised.value.code == "structure_confirmation_invalid"


def test_anchor_confirmation_rejects_a_cap_without_one_folded_body_neighbor(tmp_path: Path):
    source, resolution, proposed, net, front = anchor_proposal_files(tmp_path)
    detached = deepcopy(proposed)
    cap_id = detached["topology"]["net_proposals"][0]["cap_face_ids"][0]
    detached["structure"]["folds"] = [
        fold
        for fold in detached["structure"]["folds"]
        if cap_id not in {fold["left_face"], fold["right_face"]}
    ]
    write_resolution(resolution, detached)

    with pytest.raises(StructureConfirmationError) as raised:
        confirm_anchor(source, resolution, net["id"], front["id"], 0, tmp_path / "never.json")

    assert raised.value.code == "structure_fold_graph_invalid"


def test_anchor_confirmation_rejects_caps_on_the_same_side_of_the_body(tmp_path: Path):
    source, resolution, proposed, net, front = anchor_proposal_files(tmp_path)
    same_side = deepcopy(proposed)
    same_side_net = same_side["topology"]["net_proposals"][0]
    first_cap_id, second_cap_id = same_side_net["cap_face_ids"]
    first_cap = next(face for face in same_side["structure"]["faces"] if face["id"] == first_cap_id)
    duplicate_cap = deepcopy(first_cap)
    duplicate_cap["id"] = "same-side-cap"
    same_side["structure"]["faces"].append(duplicate_cap)
    same_side_net["cap_face_ids"][1] = duplicate_cap["id"]
    same_side_net["face_ids"] = [
        duplicate_cap["id"] if face_id == second_cap_id else face_id
        for face_id in same_side_net["face_ids"]
    ]
    write_resolution(resolution, same_side)

    with pytest.raises(StructureConfirmationError) as raised:
        confirm_anchor(source, resolution, net["id"], front["id"], 0, tmp_path / "never.json")

    assert raised.value.code == "structure_fold_graph_invalid"


def test_anchor_confirmation_rejects_relative_face_dimension_drift(tmp_path: Path):
    source, resolution, proposed, net, front = anchor_proposal_files(tmp_path)
    drifted = deepcopy(proposed)
    front_index = net["body_face_ids"].index(front["id"])
    right_id = net["body_face_ids"][(front_index + 1) % 4]
    right_face = next(face for face in drifted["structure"]["faces"] if face["id"] == right_id)
    right_face["artwork_transform"][0] *= 2
    write_resolution(resolution, drifted)

    with pytest.raises(StructureConfirmationError) as raised:
        confirm_anchor(source, resolution, net["id"], front["id"], 0, tmp_path / "never.json")

    assert raised.value.code == "structure_face_dimensions_mismatch"


def test_confirmation_rejects_a_changed_source(tmp_path: Path):
    source, resolution, _proposed, net, front = anchor_proposal_files(tmp_path)
    source.write_bytes(b"changed")
    with pytest.raises(StructureConfirmationError) as raised:
        confirm_anchor(source, resolution, net["id"], front["id"], 0, tmp_path / "never.json")
    assert raised.value.code == "structure_source_mismatch"


def test_confirmation_rejects_legacy_per_face_mapping(tmp_path: Path):
    source, resolution, _proposed, _net, _front = anchor_proposal_files(tmp_path)
    with pytest.raises(StructureConfirmationError) as raised:
        confirm_structure(
            source=source,
            resolution_path=resolution,
            decisions={"faces": []},
            output_path=tmp_path / "never.json",
        )
    assert raised.value.code == "structure_confirmation_stale"


def test_confirmation_prunes_unselected_proposal_components_before_approval(tmp_path: Path):
    source = tmp_path / "source.ai"
    source.write_bytes(b"stroke-proposal-confirmation-fixture")
    payload = semantic_box(source_hash=hashlib.sha256(source.read_bytes()).hexdigest())
    ready = resolve_structure_payload(payload)
    expected = {
        tuple(face["bounds_mm"]): role
        for role, face in ready.resolved["faces"].items()
    }
    payload["source"]["adapter"] = "illustrator-stroke-proposal/1"
    payload["faces"] = []
    payload["folds"] = []
    payload["root_face"] = None
    payload["validation"] = {
        "status": "review_required",
        "errors": ["structure_proposal_requires_confirmation"],
        "warnings": [],
    }
    payload["vertices"].extend(
        [
            {"id": "extra-a", "x": 200, "y": 200},
            {"id": "extra-b", "x": 210, "y": 200},
            {"id": "extra-c", "x": 210, "y": 210},
            {"id": "extra-d", "x": 200, "y": 210},
        ]
    )
    payload["edges"].extend(
        [
            {
                "id": f"extra-{index}",
                "start": start,
                "end": end,
                "assignment": "crease",
                "source_refs": [f"proposal:extra-{index}"],
            }
            for index, (start, end) in enumerate(
                [
                    ("extra-a", "extra-b"),
                    ("extra-b", "extra-c"),
                    ("extra-c", "extra-d"),
                    ("extra-d", "extra-a"),
                ],
                start=1,
            )
        ]
    )
    proposed = resolve_structure_payload(payload)
    resolution = tmp_path / "structure_resolution.json"
    resolution.write_text(json.dumps(proposed.as_dict()), encoding="utf-8")
    net = proposed.topology["net_proposals"][0]
    front = next(
        face
        for face in proposed.topology["face_proposal"]
        if tuple(face["bounds_mm"]) in expected and expected[tuple(face["bounds_mm"])] == "front"
    )
    output = tmp_path / "approved.structure.json"

    confirm_anchor(source, resolution, net["id"], front["id"], 0, output)

    approved = json.loads(output.read_text(encoding="utf-8"))
    assert len(approved["faces"]) == 6
    assert all(not edge["id"].startswith("extra-") for edge in approved["edges"])
    assert resolve_structure_payload(approved).status == "ready"
