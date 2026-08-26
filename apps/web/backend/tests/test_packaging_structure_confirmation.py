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
