from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import sys


PACKAGING = Path(__file__).resolve().parents[4] / "workers" / "packaging"
if str(PACKAGING) not in sys.path:
    sys.path.insert(0, str(PACKAGING))

from structure_v2 import adapt_structure, resolve_structure, resolve_structure_payload  # noqa: E402
from structure_v2.dimensions import STRICT_GEOMETRY, STROKE_PROPOSAL_GEOMETRY  # noqa: E402
from packaging_structure_fixture import semantic_box  # noqa: E402


REGRESSION_CASES = Path(__file__).with_name("fixtures") / "packaging_structure_v2_1_cases.json"


def regression_case(name: str) -> dict:
    payload = json.loads(REGRESSION_CASES.read_text(encoding="utf-8"))
    assert payload["privacy"] == "synthetic-only"
    return payload["cases"][name]


def stroke_payload(**kwargs) -> dict:
    payload = semantic_box(**kwargs)
    payload["source"]["adapter"] = "illustrator-stroke-proposal/1"
    payload["faces"] = []
    payload["folds"] = []
    payload["root_face"] = None
    payload["validation"] = {
        "status": "review_required",
        "errors": ["structure_proposal_requires_confirmation"],
        "warnings": [],
    }
    return payload


def append_linework(
    target: dict,
    source: dict,
    *,
    prefix: str,
    offset_x: float = 0.0,
    offset_y: float = 0.0,
    rotation_degrees: float = 0.0,
) -> None:
    angle = math.radians(rotation_degrees)
    cosine = math.cos(angle)
    sine = math.sin(angle)
    vertex_ids: dict[str, str] = {}
    for vertex in source["vertices"]:
        identity = f"{prefix}-{vertex['id']}"
        vertex_ids[vertex["id"]] = identity
        x = float(vertex["x"])
        y = float(vertex["y"])
        target["vertices"].append(
            {
                "id": identity,
                "x": x * cosine - y * sine + offset_x,
                "y": x * sine + y * cosine + offset_y,
            }
        )
    for edge in source["edges"]:
        target["edges"].append(
            {
                **edge,
                "id": f"{prefix}-{edge['id']}",
                "start": vertex_ids[edge["start"]],
                "end": vertex_ids[edge["end"]],
                "source_refs": [f"synthetic:{prefix}:{edge['id']}"],
            }
        )


def test_resolver_builds_explicit_dimensions_and_six_faces():
    result = resolve_structure_payload(semantic_box())
    assert result.status == "ready"
    assert result.resolved is not None
    assert result.resolved["dimensions_mm"] == {"width": 30.0, "depth": 20.0, "height": 50.0}
    assert set(result.resolved["faces"]) == {"front", "right", "back", "left", "top", "bottom"}
    assert result.resolved["validation"]["status"] == "accepted"


def test_resolver_requires_complete_face_mapping_before_blender():
    payload = semantic_box()
    payload["faces"] = [face for face in payload["faces"] if face["role"] != "bottom"]
    payload["folds"] = [
        fold
        for fold in payload["folds"]
        if fold["left_face"] != "face-bottom" and fold["right_face"] != "face-bottom"
    ]
    result = resolve_structure_payload(payload)
    assert result.status == "review_required"
    assert result.code == "structure_face_mapping_incomplete"
    assert result.resolved is None


def test_resolver_rejects_disconnected_fold_graph():
    payload = semantic_box()
    payload["folds"] = payload["folds"][:-1]
    result = resolve_structure_payload(payload)
    assert result.status == "review_required"
    assert result.code == "structure_fold_graph_invalid"


def test_resolver_rejects_connected_but_impossible_role_fold_graph():
    payload = semantic_box(width=20.0, depth=20.0, height=20.0)
    role_by_face = {
        "face-back": "front",
        "face-left": "right",
        "face-front": "top",
        "face-right": "back",
        "face-top": "bottom",
        "face-bottom": "left",
    }
    for face in payload["faces"]:
        face["role"] = role_by_face[face["id"]]
    payload["root_face"] = "face-back"

    result = resolve_structure_payload(payload)

    assert result.status == "review_required"
    assert result.code == "structure_fold_graph_invalid"


def test_only_ready_results_enter_atomic_cache(tmp_path: Path):
    payload = semantic_box()
    first = resolve_structure_payload(payload, cache_dir=tmp_path)
    second = resolve_structure_payload(payload, cache_dir=tmp_path)
    assert first.status == second.status == "ready"
    assert first.cache_hit is False
    assert second.cache_hit is True
    cache_files = list(tmp_path.glob("*.json"))
    assert len(cache_files) == 1
    cached = json.loads(cache_files[0].read_text(encoding="utf-8"))
    assert cached["schema"] == "packaging-structure-cache/6"
    assert cached["resolved"]["schema"] == "resolved-packaging-job/3"

    bad = semantic_box(source_hash="e" * 64)
    bad["edges"] = bad["edges"][:-1]
    review = resolve_structure_payload(bad, cache_dir=tmp_path)
    assert review.status == "review_required"
    assert len(list(tmp_path.glob("*.json"))) == 1


def test_legacy_dimension_cache_is_rebuilt_under_current_contract(tmp_path: Path):
    payload = semantic_box()
    primed = resolve_structure_payload(payload, cache_dir=tmp_path)
    assert primed.status == "ready"
    cache_file = next(tmp_path.glob("*.json"))
    cached = json.loads(cache_file.read_text(encoding="utf-8"))
    cached["schema"] = "packaging-structure-cache/3"
    cached["resolved"]["schema"] = "resolved-packaging-job/1"
    cached["resolved"]["dimensions_mm"]["depth"] = 49.4
    cache_file.write_text(json.dumps(cached), encoding="utf-8")

    rebuilt = resolve_structure_payload(deepcopy(payload), cache_dir=tmp_path)

    assert rebuilt.status == "ready"
    assert rebuilt.cache_hit is False
    assert rebuilt.resolved["dimensions_mm"] == {"width": 30.0, "depth": 20.0, "height": 50.0}
    migrated = json.loads(cache_file.read_text(encoding="utf-8"))
    assert migrated["schema"] == "packaging-structure-cache/6"
    assert migrated["resolved"]["schema"] == "resolved-packaging-job/3"


def test_geometry_tolerance_is_owned_by_adapter_policy():
    assert STROKE_PROPOSAL_GEOMETRY.dimensions.close(20.0, 21.2)
    assert not STROKE_PROPOSAL_GEOMETRY.dimensions.close(20.0, 22.0)
    assert not STRICT_GEOMETRY.dimensions.close(20.0, 21.2)


def test_sidecar_adapter_binds_exact_source_hash(tmp_path: Path):
    source = tmp_path / "box.ai"
    source.write_bytes(b"private-ai-placeholder")
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    sidecar = source.with_name(source.name + ".structure.json")
    sidecar.write_text(json.dumps(semantic_box(source_hash=source_hash)), encoding="utf-8")

    adapted = adapt_structure(source)
    assert adapted.status == "adapted"
    resolved = resolve_structure(source)
    assert resolved.status == "ready"

    source.write_bytes(b"changed-source")
    stale = adapt_structure(source)
    assert stale.status == "review_required"
    assert stale.code == "structure_source_mismatch"


def test_plain_legacy_ai_never_auto_accepts_from_filename_or_layers(tmp_path: Path):
    source = tmp_path / "包装-刀线-花盒.ai"
    source.write_bytes("%PDF fake layer 刀线".encode("utf-8"))
    result = resolve_structure(source)
    assert result.status == "review_required"
    assert result.code == "structure_semantics_missing"


def test_corrupted_cache_is_ignored_and_rebuilt(tmp_path: Path):
    payload = semantic_box()
    first = resolve_structure_payload(payload, cache_dir=tmp_path)
    assert first.status == "ready"
    cache_file = next(tmp_path.glob("*.json"))
    cache_file.write_text("{broken", encoding="utf-8")
    rebuilt = resolve_structure_payload(deepcopy(payload), cache_dir=tmp_path)
    assert rebuilt.status == "ready"
    assert rebuilt.cache_hit is False


def test_semantic_linework_derives_faces_but_waits_for_explicit_roles():
    payload = semantic_box()
    expected_bounds = {
        face["role"]: tuple(
            next(
                item["bounds_mm"]
                for item in resolve_structure_payload(payload).resolved["faces"].values()
                if item["face_id"] == face["id"]
            )
        )
        for face in payload["faces"]
    }
    payload["faces"] = []
    payload["folds"] = []
    payload["root_face"] = None
    payload["validation"] = {"status": "review_required", "errors": [], "warnings": []}

    proposed = resolve_structure_payload(payload)
    assert proposed.status == "review_required"
    assert proposed.code == "structure_face_mapping_incomplete"
    assert proposed.structure is not None
    assert len(proposed.structure["faces"]) == 6
    assert all(
        all(ref.startswith("fixture:") for ref in edge["source_refs"])
        for edge in proposed.structure["edges"]
    )
    preview = proposed.topology["face_proposal"]
    assert all(face["rectangular"] for face in preview)

    role_by_bounds = {bounds: role for role, bounds in expected_bounds.items()}
    proposal_by_id = {face["id"]: face for face in preview}
    approved = deepcopy(proposed.structure)
    approved.pop("structure_hash", None)
    for face in approved["faces"]:
        bounds = tuple(proposal_by_id[face["id"]]["bounds_mm"])
        face["role"] = role_by_bounds[bounds]
    approved["root_face"] = next(face["id"] for face in approved["faces"] if face["role"] == "front")
    approved["validation"] = {"status": "accepted", "errors": [], "warnings": []}

    resolved = resolve_structure_payload(approved)
    assert resolved.status == "ready"
    assert resolved.resolved["dimensions_mm"] == {"width": 30.0, "depth": 20.0, "height": 50.0}


def test_role_mapping_without_approval_never_reaches_blender_contract():
    payload = semantic_box()
    payload["validation"] = {
        "status": "review_required",
        "errors": ["human_confirmation_missing"],
        "warnings": [],
    }
    result = resolve_structure_payload(payload)
    assert result.status == "review_required"
    assert result.code == "structure_approval_required"
    assert result.resolved is None


def test_stroke_proposal_excludes_unrelated_components_without_auto_accepting():
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
    payload["vertices"].extend(
        [
            {"id": "extra-a", "x": 200, "y": 200},
            {"id": "extra-b", "x": 210, "y": 200},
            {"id": "extra-c", "x": 210, "y": 210},
            {"id": "extra-d", "x": 200, "y": 210},
            {"id": "dangle-a", "x": 300, "y": 300},
            {"id": "dangle-b", "x": 305, "y": 300},
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
                    ("dangle-a", "dangle-b"),
                ],
                start=1,
            )
        ]
    )

    proposed = resolve_structure_payload(payload)

    assert proposed.status == "review_required"
    assert proposed.code == "structure_face_mapping_incomplete"
    assert proposed.resolved is None
    assert len(proposed.topology["face_proposal"]) == 6
    assert len(proposed.topology["net_proposals"]) == 1
    assert proposed.topology["proposal_diagnostics"]["errors"] == [
        "structure_open_boundary",
        "structure_multiple_components",
    ]


def test_stroke_proposal_groups_only_complete_box_nets_for_human_review():
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
    payload["vertices"].extend(
        [
            {"id": "nested-a", "x": 4.0, "y": 30.0},
            {"id": "nested-b", "x": 14.0, "y": 30.0},
            {"id": "nested-c", "x": 14.0, "y": 45.0},
            {"id": "nested-d", "x": 4.0, "y": 45.0},
            {"id": "partial-a", "x": 0.0, "y": 20.0},
            {"id": "partial-b", "x": 20.0, "y": 20.0},
            {"id": "partial-c", "x": 20.0, "y": 55.0},
            {"id": "partial-d", "x": 0.0, "y": 55.0},
        ]
    )
    payload["edges"].extend(
        {
            "id": f"noise-{index}",
            "start": start,
            "end": end,
            "assignment": "crease",
            "source_refs": [f"proposal:noise-{index}"],
        }
        for index, (start, end) in enumerate(
            [
                ("nested-a", "nested-b"),
                ("nested-b", "nested-c"),
                ("nested-c", "nested-d"),
                ("nested-d", "nested-a"),
                ("partial-a", "partial-b"),
                ("partial-b", "partial-c"),
                ("partial-c", "partial-d"),
                ("partial-d", "partial-a"),
            ],
            start=1,
        )
    )

    proposed = resolve_structure_payload(payload)

    nets = proposed.topology["net_proposals"]
    assert len(nets) == 1
    assert len(nets[0]["face_ids"]) == 6
    assert len(nets[0]["body_face_ids"]) == 4
    assert len(nets[0]["cap_face_ids"]) == 2
    exposed_ids = {face["id"] for face in proposed.topology["face_proposal"]}
    assert exposed_ids == set(nets[0]["face_ids"])
    exposed_sizes = [tuple(face["size_mm"]) for face in proposed.topology["face_proposal"]]
    assert (10.0, 15.0) not in exposed_sizes
    assert (20.0, 35.0) not in exposed_sizes


def test_internal_annotation_stroke_does_not_split_a_finished_body_panel():
    payload = stroke_payload()
    payload["vertices"].extend(
        [
            {"id": "black-annotation-top", "x": 90.0, "y": 20.0},
            {"id": "black-annotation-bottom", "x": 90.0, "y": 70.0},
        ]
    )
    payload["edges"].append(
        {
            "id": "black-annotation-line",
            "start": "black-annotation-top",
            "end": "black-annotation-bottom",
            "assignment": "crease",
            "source_refs": ["synthetic:black-dimension-line"],
        }
    )

    proposed = resolve_structure_payload(payload)

    assert proposed.status == "review_required"
    nets = proposed.topology["net_proposals"]
    assert len(nets) == 1
    assert nets[0]["dimensions_mm"] == {"width": 30.0, "depth": 20.0, "height": 50.0}
    assert [80.0, 20.0, 100.0, 70.0] in [
        face["bounds_mm"]
        for face in proposed.topology["face_proposal"]
    ]


def test_stroke_proposal_keeps_finished_panels_with_duplicate_strokes_and_a_sloped_flap():
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

    translated_vertices = []
    translated_ids = {}
    for vertex in list(payload["vertices"]):
        translated_id = f"double-{vertex['id']}"
        translated_ids[vertex["id"]] = translated_id
        translated_vertices.append(
            {
                "id": translated_id,
                "x": float(vertex["x"]) + 0.3,
                "y": float(vertex["y"]) + 0.2,
            }
        )
    payload["vertices"].extend(translated_vertices)
    payload["edges"].extend(
        {
            "id": f"double-{edge['id']}",
            "start": translated_ids[edge["start"]],
            "end": translated_ids[edge["end"]],
            "assignment": edge["assignment"],
            "source_refs": [f"proposal:double-{edge['id']}"],
        }
        for edge in list(payload["edges"])
        if not edge["id"].startswith("double-")
    )
    payload["vertices"].extend(
        [
            {"id": "flap-left", "x": -5.0, "y": 80.0},
            {"id": "flap-right", "x": 35.0, "y": 80.0},
        ]
    )
    payload["edges"].extend(
        [
            {
                "id": "flap-sloped-left",
                "start": "v-4",
                "end": "flap-left",
                "assignment": "cut",
                "source_refs": ["proposal:flap"],
            },
            {
                "id": "flap-top",
                "start": "flap-left",
                "end": "flap-right",
                "assignment": "cut",
                "source_refs": ["proposal:flap"],
            },
            {
                "id": "flap-sloped-right",
                "start": "flap-right",
                "end": "v-3",
                "assignment": "cut",
                "source_refs": ["proposal:flap"],
            },
        ]
    )

    proposed = resolve_structure_payload(payload)

    assert proposed.status == "review_required"
    assert proposed.code == "structure_face_mapping_incomplete"
    sizes = [
        tuple(face["size_mm"])
        for face in proposed.topology["face_proposal"]
        if face.get("size_mm") is not None
    ]
    assert sizes.count((30.0, 50.0)) >= 2
    assert sizes.count((20.0, 50.0)) >= 2
    assert sizes.count((30.0, 20.0)) >= 2
    assert proposed.resolved is None


def test_ready_cache_never_bypasses_current_approval_status(tmp_path: Path):
    accepted = semantic_box()
    primed = resolve_structure_payload(accepted, cache_dir=tmp_path)
    assert primed.status == "ready"

    pending = deepcopy(accepted)
    pending.pop("structure_hash", None)
    pending["validation"] = {
        "status": "review_required",
        "errors": ["human_confirmation_missing"],
        "warnings": [],
    }
    result = resolve_structure_payload(pending, cache_dir=tmp_path)

    assert result.status == "review_required"
    assert result.code == "structure_approval_required"
    assert result.resolved is None
    assert result.cache_hit is False


def test_sanitized_white_carton_fixture_keeps_outer_and_insert_choices_without_color_guessing():
    case = regression_case("white_outer_with_insert")
    outer = stroke_payload(
        width=case["outer"]["width"],
        depth=case["outer"]["depth"],
        height=case["outer"]["height"],
        top_cap_depth=case["outer"]["top_closure_depth"],
    )
    insert = stroke_payload(
        width=case["insert"]["width"],
        depth=case["insert"]["depth"],
        height=case["insert"]["height"],
    )
    append_linework(outer, insert, prefix="insert", offset_x=250.0)

    proposed = resolve_structure_payload(outer)

    assert proposed.status == "review_required"
    assert proposed.code == "structure_face_mapping_incomplete"
    nets = proposed.topology["net_proposals"]
    assert len(nets) == case["expected"]["proposal_count"]
    assert nets[0]["dimensions_mm"] == {"width": 30.0, "depth": 20.0, "height": 50.0}
    assert nets[1]["dimensions_mm"] == {"width": 10.0, "depth": 8.0, "height": 18.0}
    assert any(item["extent"] == "partial" for item in nets[0]["closure_assemblies"])
    assert all(net["valid_anchors"] for net in nets)
    assert "color" not in json.dumps(proposed.as_dict()).lower()


def test_annotation_heavy_fixture_partitions_noise_before_candidate_search():
    case = regression_case("annotation_heavy_carton")
    payload = stroke_payload()
    for index in range(case["detached_annotation_components"]):
        start = f"annotation-{index}-a"
        end = f"annotation-{index}-b"
        x = 500.0 + index * 3.0
        payload["vertices"].extend(
            [
                {"id": start, "x": x, "y": 500.0},
                {"id": end, "x": x + 1.0, "y": 500.0},
            ]
        )
        payload["edges"].append(
            {
                "id": f"annotation-{index}",
                "start": start,
                "end": end,
                "assignment": "crease",
                "source_refs": [f"synthetic:annotation:{index}"],
            }
        )

    proposed = resolve_structure_payload(payload)

    assert proposed.status == "review_required"
    assert len(proposed.topology["net_proposals"]) == case["expected"]["proposal_count"]
    diagnostics = proposed.topology["proposal_diagnostics"]
    assert diagnostics["components_seen"] > 100
    assert diagnostics["candidate_components"] == 1
    assert diagnostics["work_units"] < 50_000


def test_stroke_proposal_never_confirms_residual_lines_after_export_budget_failure():
    payload = stroke_payload()
    payload["validation"]["errors"].append("structure_curve_complexity_exceeded")

    result = resolve_structure_payload(payload)

    assert result.status == "unsupported"
    assert result.code == "structure_curve_complexity_exceeded"
    assert result.resolved is None
    assert not (result.topology or {}).get("net_proposals")


def test_detached_annotation_components_do_not_exhaust_the_global_topology_limit():
    payload = stroke_payload()
    for index in range(4_100):
        start = f"noise-{index}-a"
        end = f"noise-{index}-b"
        x = 1_000.0 + index * 3.0
        payload["vertices"].extend(
            [
                {"id": start, "x": x, "y": 1_000.0},
                {"id": end, "x": x + 1.0, "y": 1_000.0},
            ]
        )
        payload["edges"].append(
            {
                "id": f"noise-{index}",
                "start": start,
                "end": end,
                "assignment": "crease",
                "source_refs": [f"synthetic:noise:{index}"],
            }
        )

    result = resolve_structure_payload(payload)

    assert result.status == "review_required"
    assert result.code == "structure_face_mapping_incomplete"
    assert result.resolved is None
    assert len(result.topology["net_proposals"]) == 1
    assert result.topology["proposal_diagnostics"]["components_seen"] > 4_096
    assert result.topology["proposal_diagnostics"]["candidate_components"] == 1


def test_axis_budget_cannot_hide_the_outer_carton_and_promote_a_smaller_insert():
    payload = stroke_payload(width=30, depth=20, height=50)
    insert = stroke_payload(width=10, depth=8, height=18, source_hash="e" * 64)
    append_linework(payload, insert, prefix="insert", offset_x=700)
    payload["vertices"].extend(
        [
            {"id": "comb-base-a", "x": 0.0, "y": 20.0},
            {"id": "comb-base-b", "x": 500.0, "y": 20.0},
        ]
    )
    payload["edges"].append(
        {
            "id": "comb-base",
            "start": "comb-base-a",
            "end": "comb-base-b",
            "assignment": "crease",
            "source_refs": ["synthetic:comb"],
        }
    )
    for index in range(41):
        start = f"comb-{index}-a"
        end = f"comb-{index}-b"
        x = 200.0 + index * 5.0
        payload["vertices"].extend(
            [
                {"id": start, "x": x, "y": 20.0},
                {"id": end, "x": x, "y": 25.0},
            ]
        )
        payload["edges"].append(
            {
                "id": f"comb-{index}",
                "start": start,
                "end": end,
                "assignment": "crease",
                "source_refs": [f"synthetic:comb:{index}"],
            }
        )

    result = resolve_structure_payload(payload)

    assert result.status == "unsupported"
    assert result.code == "structure_limit_exceeded"
    assert result.resolved is None
    assert not (result.topology or {}).get("net_proposals")


def test_rotated_fixture_uses_one_explicit_basis_and_exposes_only_confirmable_anchors():
    case = regression_case("rotated_carton")
    payload = stroke_payload()
    rotated = stroke_payload(source_hash="e" * 64)
    payload["vertices"] = []
    payload["edges"] = []
    append_linework(
        payload,
        rotated,
        prefix="rotated",
        rotation_degrees=case["rotation_degrees"],
    )

    proposed = resolve_structure_payload(payload)

    assert proposed.status == "review_required"
    assert len(proposed.topology["net_proposals"]) == case["expected"]["proposal_count"]
    net = proposed.topology["net_proposals"][0]
    assert net["basis_transform"] != [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    assert net["valid_anchors"]
    assert all(item["quarter_turns"] for item in net["valid_anchors"])


def test_proposal_preflight_is_repeatable_and_never_mutates_the_source_contract():
    payload = stroke_payload()
    original = deepcopy(payload)

    first = resolve_structure_payload(payload)
    after_first = deepcopy(payload)
    second = resolve_structure_payload(payload)

    assert payload == after_first == original
    assert first.status == second.status == "review_required"
    assert first.structure == second.structure
    assert first.topology["net_proposals"] == second.topology["net_proposals"]
    assert first.topology["net_proposals"][0]["id"].startswith("box-net-")
