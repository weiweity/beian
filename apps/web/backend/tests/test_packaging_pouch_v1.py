from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
if str(PACKAGING) not in sys.path:
    sys.path.insert(0, str(PACKAGING))

from packaging_structure_fixture import semantic_box  # noqa: E402
from structure_v2 import confirm_structure, resolve_structure_payload  # noqa: E402
from structure_v2.pouch import POUCH_NET_PROPOSAL_SCHEMA, POUCH_UNSUPPORTED_MESSAGE  # noqa: E402


def two_panel_payload(
    *,
    source_hash: str = "a" * 64,
    left: tuple[float, float, float, float] = (0.0, 0.0, 80.0, 120.0),
    right: tuple[float, float, float, float] = (100.0, 0.0, 180.0, 120.0),
    extra: tuple[float, float, float, float] | None = None,
) -> dict:
    rectangles = [left, right] + ([extra] if extra else [])
    segment_faces: dict[tuple[tuple[float, float], tuple[float, float]], list[int]] = {}
    for index, (x0, y0, x1, y1) in enumerate(rectangles):
        corners = ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
        for start, end in zip(corners, corners[1:] + corners[:1]):
            segment_faces.setdefault(tuple(sorted((start, end))), []).append(index)
    points = sorted({point for segment in segment_faces for point in segment})
    vertex_ids = {point: f"v-{index}" for index, point in enumerate(points, start=1)}
    return {
        "schema": "packaging-structure/1",
        "units": "mm",
        "source": {
            "sha256": source_hash,
            "adapter": "illustrator-stroke-proposal/1",
            "adapter_version": "1.0.0",
            "coordinate_space": "artboard-top-left",
            "page_size": [220.0, 140.0],
        },
        "vertices": [
            {"id": vertex_ids[point], "x": point[0], "y": point[1]}
            for point in points
        ],
        "edges": [
            {
                "id": f"e-{index}",
                "start": vertex_ids[start],
                "end": vertex_ids[end],
                "assignment": "cut",
                "source_refs": [f"pouch:{index}"],
            }
            for index, ((start, end), _names) in enumerate(sorted(segment_faces.items()), start=1)
        ],
        "faces": [],
        "folds": [],
        "root_face": None,
        "validation": {
            "status": "review_required",
            "errors": ["structure_proposal_requires_confirmation"],
            "warnings": [],
        },
    }


def test_two_similar_panels_with_pouch_hint_ask_for_front():
    result = resolve_structure_payload(two_panel_payload(), pouch_hint=True)
    assert result.status == "review_required"
    assert result.code == "structure_face_mapping_incomplete"
    assert result.message and "膜袋" in result.message
    nets = (result.topology or {}).get("net_proposals") or []
    assert len(nets) == 1
    assert nets[0]["schema"] == POUCH_NET_PROPOSAL_SCHEMA
    assert len(nets[0]["body_face_ids"]) == 2
    assert len(nets[0]["valid_anchors"]) == 2


def test_two_similar_panels_without_pouch_hint_stay_carton_fail():
    result = resolve_structure_payload(two_panel_payload(), pouch_hint=False)
    assert result.status == "review_required"
    assert result.code == "structure_box_net_missing"
    assert result.message and "膜袋" not in result.message


def test_mianmo_name_does_not_divert_without_pouch_marker():
    result = resolve_structure_payload(two_panel_payload(), pouch_hint=False)
    assert result.code == "structure_box_net_missing"


def test_three_panels_with_pouch_hint_are_unsupported_pouch():
    result = resolve_structure_payload(
        two_panel_payload(extra=(200.0, 0.0, 280.0, 120.0)),
        pouch_hint=True,
    )
    assert result.status == "unsupported"
    assert result.code == "structure_category_unsupported"
    assert result.message == POUCH_UNSUPPORTED_MESSAGE


def test_dissimilar_panels_with_pouch_hint_are_unsupported_pouch():
    result = resolve_structure_payload(
        two_panel_payload(right=(100.0, 0.0, 130.0, 40.0)),
        pouch_hint=True,
    )
    assert result.status == "unsupported"
    assert result.code == "structure_category_unsupported"


def test_carton_with_pouch_hint_still_folds_as_carton():
    payload = semantic_box()
    payload["source"]["adapter"] = "illustrator-stroke-proposal/1"
    payload["faces"] = []
    payload["folds"] = []
    payload["root_face"] = None
    payload["validation"] = {
        "status": "review_required",
        "errors": ["structure_proposal_requires_confirmation"],
        "warnings": [],
    }
    result = resolve_structure_payload(payload, pouch_hint=True)
    assert result.status == "review_required"
    nets = (result.topology or {}).get("net_proposals") or []
    assert nets
    assert nets[0]["schema"] == "box-net-proposal/3"


def test_confirm_pouch_writes_paper_only_sides(tmp_path: Path):
    source = tmp_path / "26H11A-膜袋.ai"
    source.write_bytes(b"pouch-v1-source")
    payload = two_panel_payload(source_hash=hashlib.sha256(source.read_bytes()).hexdigest())
    proposed = resolve_structure_payload(payload, pouch_hint=True)
    assert proposed.status == "review_required"
    net = proposed.topology["net_proposals"][0]
    front_id = net["valid_anchors"][0]["front_face_id"]
    turns = net["valid_anchors"][0]["preferred_quarter_turns"]
    resolution = tmp_path / "structure_resolution.json"
    resolution.write_text(
        json.dumps(
            {
                "status": "review_required",
                "structure": proposed.structure,
                "topology": proposed.topology,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    sidecar = tmp_path / "approved.json"
    result = confirm_structure(
        source=source,
        resolution_path=resolution,
        decisions={"anchor": {"proposal_id": net["id"], "front_face_id": front_id, "quarter_turns": turns}},
        output_path=sidecar,
    )
    assert result["ok"] is True
    approved = json.loads(sidecar.read_text(encoding="utf-8"))
    assert approved["packaging_family"] == "pouch"
    roles = {face["role"] for face in approved["faces"]}
    assert roles == {"front", "back"}
    ready = resolve_structure_payload(approved)
    assert ready.status == "ready"
    assert ready.resolved is not None
    assert ready.resolved["packaging_family"] == "pouch"
    assert ready.resolved["dimensions_mm"]["depth"] == 3.0
    assert ready.resolved["faces"]["left"]["paper_only"] is True
    assert ready.resolved["faces"]["right"]["artwork_layers"] == []
    assert ready.resolved["faces"]["front"]["artwork_layers"]
    assert ready.resolved["faces"]["back"]["artwork_layers"]
