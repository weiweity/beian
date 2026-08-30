from __future__ import annotations

import hashlib
import json
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
    )
    vertices = {item["id"]: (item["x"], item["y"]) for item in payload["vertices"]}
    edges = {item["id"]: item for item in payload["edges"]}
    declared_front = next(face for face in payload["faces"] if face["role"] == "front")
    front_points = {
        vertices[vertex_id]
        for edge_id in declared_front["boundary"]
        for vertex_id in (edges[edge_id]["start"], edges[edge_id]["end"])
    }
    expected_front_bounds = (
        min(point[0] for point in front_points),
        min(point[1] for point in front_points),
        max(point[0] for point in front_points),
        max(point[1] for point in front_points),
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

    assert raised.value.code == "artwork_transform_invalid"
    assert "旋转 90" in str(raised.value)


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
    # Physical box dimensions come from the four body panels. A deliberately
    # shorter closure flap must not shrink the erected carton.
    assert result["dimensions_mm"] == {"width": 30.0, "depth": 20.0, "height": 50.0}
    approved = json.loads(output.read_text(encoding="utf-8"))
    assert resolve_structure_payload(approved).status == "ready"


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
