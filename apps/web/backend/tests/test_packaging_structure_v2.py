from __future__ import annotations

from copy import deepcopy
import sys
from pathlib import Path

import pytest


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
if str(PACKAGING) not in sys.path:
    sys.path.insert(0, str(PACKAGING))

from structure_v2 import (  # noqa: E402
    StructureContractError,
    TopologyError,
    analyze_topology,
    canonicalize_structure,
    structure_cache_key,
)


def base_structure(*, units: str = "mm") -> dict:
    return {
        "schema": "packaging-structure/1",
        "units": units,
        "source": {
            "sha256": "a" * 64,
            "adapter": "illustrator-semantic/1",
            "adapter_version": "1.0.0",
            "document_ref": "/private/source.ai",
        },
        "vertices": [
            {"id": "v1", "x": 0, "y": 0},
            {"id": "v2", "x": 10, "y": 0},
            {"id": "v3", "x": 10, "y": 10},
            {"id": "v4", "x": 0, "y": 10},
        ],
        "edges": [
            {"id": "e1", "start": "v1", "end": "v2", "assignment": "cut", "source_refs": ["path:1"]},
            {"id": "e2", "start": "v2", "end": "v3", "assignment": "cut", "source_refs": ["path:2"]},
            {"id": "e3", "start": "v3", "end": "v4", "assignment": "cut", "source_refs": ["path:3"]},
            {"id": "e4", "start": "v4", "end": "v1", "assignment": "cut", "source_refs": ["path:4"]},
        ],
        "faces": [],
        "folds": [],
        "root_face": None,
        "validation": {"status": "review_required", "errors": [], "warnings": []},
    }


def carton_net() -> dict:
    """Four side panels plus top/bottom, expressed only as semantic linework."""
    cells = {
        (0, 1),
        (1, 1),
        (2, 1),
        (3, 1),
        (1, 2),
        (1, 0),
    }
    vertices: dict[tuple[int, int], str] = {}
    segments: dict[tuple[tuple[int, int], tuple[int, int]], int] = {}
    for x, y in cells:
        corners = ((x, y), (x + 1, y), (x + 1, y + 1), (x, y + 1))
        for point in corners:
            vertices.setdefault(point, f"v-{point[0]}-{point[1]}")
        for start, end in zip(corners, corners[1:] + corners[:1]):
            key = tuple(sorted((start, end)))
            segments[key] = segments.get(key, 0) + 1
    payload = {
        "schema": "packaging-structure/1",
        "units": "mm",
        "source": {
            "sha256": "b" * 64,
            "adapter": "structural-sidecar/1",
            "adapter_version": "1.0.0",
        },
        "vertices": [
            {"id": identity, "x": point[0] * 10, "y": point[1] * 10}
            for point, identity in vertices.items()
        ],
        "edges": [
            {
                "id": f"e-{index:02d}",
                "start": vertices[start],
                "end": vertices[end],
                "assignment": "crease" if count == 2 else "cut",
                "source_refs": [f"fixture:{index}"],
            }
            for index, ((start, end), count) in enumerate(sorted(segments.items()), start=1)
        ],
        "faces": [],
        "folds": [],
        "root_face": None,
    }
    return payload


def test_canonical_hash_is_stable_and_excludes_source_path():
    first = base_structure()
    second = deepcopy(first)
    second["vertices"].reverse()
    second["edges"].reverse()
    for index, edge in enumerate(second["edges"], start=1):
        edge["source_refs"] = [f"other-adapter-object:{index}"]
    second["source"]["document_ref"] = "D:\\private\\renamed.ai"

    vertex_rename = {item["id"]: f"point-{index}" for index, item in enumerate(second["vertices"], start=1)}
    edge_rename = {item["id"]: f"segment-{index}" for index, item in enumerate(second["edges"], start=1)}
    for vertex in second["vertices"]:
        vertex["id"] = vertex_rename[vertex["id"]]
    for edge in second["edges"]:
        old_id = edge["id"]
        edge["id"] = edge_rename[old_id]
        edge["start"] = vertex_rename[edge["start"]]
        edge["end"] = vertex_rename[edge["end"]]

    a = canonicalize_structure(first)
    b = canonicalize_structure(second)

    assert a["structure_hash"] == b["structure_hash"]
    assert a["units"] == "mm"
    assert [item["id"] for item in a["vertices"]] == sorted(item["id"] for item in a["vertices"])


def test_cache_key_binds_source_and_adapter_version():
    original = base_structure()
    changed_source = deepcopy(original)
    changed_source["source"]["sha256"] = "c" * 64
    changed_adapter = deepcopy(original)
    changed_adapter["source"]["adapter_version"] = "1.0.1"

    assert structure_cache_key(original) != structure_cache_key(changed_source)
    assert structure_cache_key(original) != structure_cache_key(changed_adapter)
    assert canonicalize_structure(original)["structure_hash"] == canonicalize_structure(changed_source)["structure_hash"]


def test_points_are_normalized_to_millimetres():
    payload = base_structure(units="pt")
    normalized = canonicalize_structure(payload)
    by_id = {item["id"]: item for item in normalized["vertices"]}
    assert by_id["v2"]["x"] == pytest.approx(10 * 25.4 / 72, abs=1e-6)


def test_contract_rejects_unknown_units_and_broken_references():
    payload = base_structure()
    payload["units"] = None
    with pytest.raises(StructureContractError) as units:
        canonicalize_structure(payload)
    assert units.value.code == "structure_units_ambiguous"

    payload = base_structure()
    payload["edges"][0]["end"] = "missing"
    with pytest.raises(StructureContractError) as reference:
        canonicalize_structure(payload)
    assert reference.value.code == "structure_contract_invalid"


def test_contract_rejects_degenerate_artwork_transform():
    payload = base_structure()
    payload["faces"] = [
        {
            "id": "face-1",
            "boundary": ["e1", "e2", "e3", "e4"],
            "role": "front",
            "artwork_transform": [1, 2, 2, 4, 0, 0],
        }
    ]
    payload["root_face"] = "face-1"
    with pytest.raises(StructureContractError) as error:
        canonicalize_structure(payload)
    assert error.value.code == "artwork_transform_invalid"


def test_closed_carton_net_polygonizes_to_six_faces():
    report = analyze_topology(carton_net(), snap_tolerance_mm=0.05)
    assert report["status"] == "accepted"
    assert report["errors"] == []
    assert report["counts"]["faces"] == 6
    assert report["counts"]["components"] == 1
    assert report["diagnostics"]["dangles"]["count"] == 0
    assert report["diagnostics"]["invalid_rings"]["count"] == 0


def test_same_assignment_near_endpoints_snap_deterministically():
    payload = base_structure()
    payload["vertices"].append({"id": "v2-near", "x": 10.05, "y": 0})
    payload["edges"][1]["start"] = "v2-near"
    report = analyze_topology(payload, snap_tolerance_mm=0.1)
    assert report["status"] == "accepted"
    assert report["counts"]["faces"] == 1


def test_open_boundary_is_reported_not_repaired():
    payload = base_structure()
    payload["edges"] = payload["edges"][:-1]
    report = analyze_topology(payload)
    assert report["status"] == "review_required"
    assert "structure_open_boundary" in report["errors"]
    assert "structure_face_mapping_incomplete" in report["errors"]


def test_multiple_components_are_not_auto_accepted():
    payload = base_structure()
    offset_vertices = [
        {"id": f"x-{item['id']}", "x": item["x"] + 30, "y": item["y"]}
        for item in payload["vertices"]
    ]
    offset_edges = [
        {
            **edge,
            "id": f"x-{edge['id']}",
            "start": f"x-{edge['start']}",
            "end": f"x-{edge['end']}",
        }
        for edge in payload["edges"]
    ]
    payload["vertices"].extend(offset_vertices)
    payload["edges"].extend(offset_edges)
    report = analyze_topology(payload)
    assert report["status"] == "review_required"
    assert report["counts"]["components"] == 2
    assert "structure_multiple_components" in report["errors"]


def test_topology_has_bounded_linework_limit():
    with pytest.raises(TopologyError) as error:
        analyze_topology(base_structure(), limits={"linework_edges": 3})
    assert error.value.code == "structure_limit_exceeded"


def test_contract_rejects_100k_edges_before_normalizing_each_item():
    payload = base_structure()
    payload["edges"] = [payload["edges"][0]] * 100_000
    with pytest.raises(StructureContractError) as error:
        canonicalize_structure(payload)
    assert error.value.code == "structure_limit_exceeded"
    assert error.value.details == {"count": 100_000, "limit": 20_000}
