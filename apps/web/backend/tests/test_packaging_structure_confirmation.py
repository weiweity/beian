from __future__ import annotations

import hashlib
import json
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


def proposal_files(tmp_path: Path):
    source = tmp_path / "source.ai"
    source.write_bytes(b"semantic-confirmation-fixture")
    payload = semantic_box(source_hash=hashlib.sha256(source.read_bytes()).hexdigest())
    ready = resolve_structure_payload(payload)
    expected = {
        tuple(face["bounds_mm"]): role
        for role, face in ready.resolved["faces"].items()
    }
    payload["faces"] = []
    payload["folds"] = []
    payload["root_face"] = None
    payload["validation"] = {"status": "review_required", "errors": [], "warnings": []}
    proposed = resolve_structure_payload(payload)
    resolution = tmp_path / "structure_resolution.json"
    resolution.write_text(json.dumps(proposed.as_dict()), encoding="utf-8")
    decisions = {
        "faces": [
            {
                "id": face["id"],
                "role": expected[tuple(face["bounds_mm"])],
                "quarter_turns": 0,
            }
            for face in proposed.topology["face_proposal"]
        ]
    }
    return source, resolution, decisions


def test_confirmation_binds_source_and_writes_an_accepted_sidecar(tmp_path: Path):
    source, resolution, decisions = proposal_files(tmp_path)
    output = tmp_path / "approved.structure.json"
    result = confirm_structure(
        source=source,
        resolution_path=resolution,
        decisions=decisions,
        output_path=output,
    )
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


def test_confirmation_rejects_a_changed_source(tmp_path: Path):
    source, resolution, decisions = proposal_files(tmp_path)
    source.write_bytes(b"changed")
    with pytest.raises(StructureConfirmationError) as raised:
        confirm_structure(
            source=source,
            resolution_path=resolution,
            decisions=decisions,
            output_path=tmp_path / "never.json",
        )
    assert raised.value.code == "structure_source_mismatch"


def test_confirmation_requires_each_box_role_once(tmp_path: Path):
    source, resolution, decisions = proposal_files(tmp_path)
    decisions["faces"][1]["role"] = decisions["faces"][0]["role"]
    with pytest.raises(StructureConfirmationError) as raised:
        confirm_structure(
            source=source,
            resolution_path=resolution,
            decisions=decisions,
            output_path=tmp_path / "never.json",
        )
    assert raised.value.code == "structure_face_mapping_incomplete"


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
    selected = [
        face
        for face in proposed.topology["face_proposal"]
        if tuple(face["bounds_mm"]) in expected
    ]
    decisions = {
        "faces": [
            {
                "id": face["id"],
                "role": expected[tuple(face["bounds_mm"])],
                "quarter_turns": 0,
            }
            for face in selected
        ]
    }
    output = tmp_path / "approved.structure.json"

    confirm_structure(
        source=source,
        resolution_path=resolution,
        decisions=decisions,
        output_path=output,
    )

    approved = json.loads(output.read_text(encoding="utf-8"))
    assert len(approved["faces"]) == 6
    assert all(not edge["id"].startswith("extra-") for edge in approved["edges"])
    assert resolve_structure_payload(approved).status == "ready"
