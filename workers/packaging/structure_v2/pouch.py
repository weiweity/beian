"""Two-panel pouch divert after carton box_net fails.

Never key on SKU names like 面膜. Marker is only 膜袋. 袋装 cartons stay cartons.
v1 preview is a 3 mm card through existing add_box, not a bag mesh.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping

from shapely.geometry import LineString

from .dimensions import STROKE_PROPOSAL_GEOMETRY
from .model import canonicalize_structure
from .topology import (
    LINEWORK_ASSIGNMENTS,
    TopologyError,
    _extract_lines,
    _partition_line_components,
    _partition_spatial_line_components,
    _rectangular_candidates_for_component,
    _segment_key,
    _snap_same_assignment,
)
from shapely import unary_union


POUCH_NET_PROPOSAL_SCHEMA = "pouch-net-proposal/1"
POUCH_DEPTH_MM = 3.0
POUCH_MIN_WIDTH_MM = 40.0
POUCH_MAX_WIDTH_MM = 400.0
POUCH_MIN_HEIGHT_MM = 60.0
POUCH_MAX_HEIGHT_MM = 500.0
POUCH_MIN_AREA_MM2 = 2_400.0
POUCH_SIMILARITY = 0.7
RESOLVED_SCHEMA = "resolved-packaging-job/3"

POUCH_UNSUPPORTED_MESSAGE = "当前不支持（膜袋）。这版只做两块相近刀线的袋片。"
POUCH_REVIEW_MESSAGE = "已识别膜袋正反面，请点品名面。"


def derive_pouch_proposal(payload: Mapping[str, Any]) -> dict[str, Any] | None:
    """Return a two-face pouch proposal, or None if this is not a v1 pouch."""
    structure = canonicalize_structure(payload)
    vertices = {item["id"]: (float(item["x"]), float(item["y"])) for item in structure["vertices"]}
    source_lines = [
        LineString([vertices[edge["start"]], vertices[edge["end"]]])
        for edge in structure["edges"]
        if edge["assignment"] in LINEWORK_ASSIGNMENTS
    ]
    source_lines = [line for line in source_lines if line.length >= 1e-6]
    if not source_lines:
        return None
    tolerance = STROKE_PROPOSAL_GEOMETRY.boundary_mm
    if tolerance is None:
        return None
    source_components = _partition_spatial_line_components(source_lines, tolerance)
    work_state = [0]
    panels: list[dict[str, Any]] = []
    for component_index, source_component in enumerate(source_components, start=1):
        if len(source_component) < 4:
            continue
        normalized = _snap_same_assignment(source_component, tolerance)
        for noded_component in _partition_line_components(_extract_lines(unary_union(normalized))):
            if len(noded_component) < 4:
                continue
            try:
                component_candidates, _basis = _rectangular_candidates_for_component(
                    noded_component,
                    source_hash=structure["source"]["sha256"],
                    tolerance=tolerance,
                    work_state=work_state,
                )
            except TopologyError:
                return None
            closed = [
                candidate
                for candidate in component_candidates
                if not candidate.get("open_sides")
                and float(candidate["polygon"].area) >= POUCH_MIN_AREA_MM2
            ]
            if not closed:
                continue
            closed.sort(key=lambda item: -float(item["polygon"].area))
            panels.append(closed[0])
    if len(panels) != 2:
        return None
    first, second = panels
    if not _similar_panels(first, second):
        return None
    portraits = [_portrait_size(panel["size_mm"]) for panel in (first, second)]
    width = (portraits[0][0] + portraits[1][0]) / 2.0
    height = (portraits[0][1] + portraits[1][1]) / 2.0
    if not (
        POUCH_MIN_WIDTH_MM <= width <= POUCH_MAX_WIDTH_MM
        and POUCH_MIN_HEIGHT_MM <= height <= POUCH_MAX_HEIGHT_MM
    ):
        return None
    built = _structure_from_panels(structure, panels)
    if built is None:
        return None
    normalized = canonicalize_structure(built["structure"])
    net = {
        "schema": POUCH_NET_PROPOSAL_SCHEMA,
        "id": _pouch_net_id(normalized["source"]["sha256"], [panel["id"] for panel in panels]),
        "structure_hash": normalized["structure_hash"],
        "face_ids": [str(face["id"]) for face in normalized["faces"]],
        "body_face_ids": [str(face["id"]) for face in normalized["faces"]],
        "packaging_family": "pouch",
        "bounds_mm": built["bounds_mm"],
        "dimensions_mm": {"width": round(width, 6), "depth": POUCH_DEPTH_MM, "height": round(height, 6)},
    }
    return {
        "structure": normalized,
        "faces": built["faces"],
        "net_proposals": [net],
        "topology_counts": {
            "linework_edges": len(source_lines),
            "faces": 2,
            "components": len(source_components),
        },
        "proposal_diagnostics": {
            "errors": [],
            "warnings": [],
            "diagnostics": {"pouch_v1": True},
        },
    }


def mapped_face_size(structure: Mapping[str, Any], face: Mapping[str, Any]) -> tuple[float, float]:
    transform = face.get("artwork_transform")
    if not isinstance(transform, list) or len(transform) != 6:
        raise ValueError("pouch face missing artwork_transform")
    a, b, c, d, e, f = (float(value) for value in transform)
    vertices = {item["id"]: (float(item["x"]), float(item["y"])) for item in structure["vertices"]}
    edges = {item["id"]: item for item in structure["edges"]}
    points: set[tuple[float, float]] = set()
    for edge_id in face["boundary"]:
        edge = edges[edge_id]
        points.add(vertices[edge["start"]])
        points.add(vertices[edge["end"]])
    mapped = [(a * x + c * y + e, b * x + d * y + f) for x, y in points]
    width = max(point[0] for point in mapped) - min(point[0] for point in mapped)
    height = max(point[1] for point in mapped) - min(point[1] for point in mapped)
    if width <= 0 or height <= 0:
        raise ValueError("pouch face size invalid")
    return width, height


def build_pouch_resolved(
    structure: Mapping[str, Any],
    *,
    front_face: Mapping[str, Any],
    back_face: Mapping[str, Any],
    dimensions_mm: Mapping[str, float],
) -> dict[str, Any]:
    width = float(dimensions_mm["width"])
    depth = float(dimensions_mm.get("depth") or POUCH_DEPTH_MM)
    height = float(dimensions_mm["height"])
    if depth <= 0:
        depth = POUCH_DEPTH_MM

    def printed(face: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "face_id": face["id"],
            "boundary": list(face["boundary"]),
            "artwork_layers": [
                {
                    "face_id": face["id"],
                    "artwork_transform": list(face["artwork_transform"]),
                    "artwork_coverage_bounds_mm": [0.0, 0.0, width, height],
                    "z_index": 0,
                }
            ],
            "size_mm": [width, height],
            "rectangular": True,
        }

    def paper(role: str, size: list[float]) -> dict[str, Any]:
        return {
            "face_id": f"pouch-paper-{role}",
            "paper_only": True,
            "artwork_layers": [],
            "size_mm": size,
            "rectangular": True,
        }

    return {
        "schema": RESOLVED_SCHEMA,
        "packaging_family": "pouch",
        "structure_schema": structure["schema"],
        "structure_hash": structure["structure_hash"],
        "cache_key": f"pouch:{structure['structure_hash']}:{front_face['id']}",
        "source_sha256": structure["source"]["sha256"],
        "adapter": structure["source"]["adapter"],
        "adapter_version": structure["source"]["adapter_version"],
        "dimensions_mm": {"width": width, "depth": depth, "height": height},
        "faces": {
            "front": printed(front_face),
            "back": printed(back_face),
            "left": paper("left", [depth, height]),
            "right": paper("right", [depth, height]),
            "top": paper("top", [width, depth]),
            "bottom": paper("bottom", [width, depth]),
        },
        "topology_counts": {"faces": 2, "components": 2},
        "validation": {
            "status": "accepted",
            "errors": [],
            "warnings": ["pouch_v1_thin_card"],
        },
    }


def _similar_panels(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    area_left = float(left["polygon"].area)
    area_right = float(right["polygon"].area)
    if min(area_left, area_right) / max(area_left, area_right) < POUCH_SIMILARITY:
        return False
    aspect_left = _aspect(left["size_mm"])
    aspect_right = _aspect(right["size_mm"])
    return min(aspect_left, aspect_right) / max(aspect_left, aspect_right) >= POUCH_SIMILARITY


def _portrait_size(size_mm: Any) -> tuple[float, float]:
    width, height = float(size_mm[0]), float(size_mm[1])
    return (min(width, height), max(width, height))


def _aspect(size_mm: Any) -> float:
    width, height = _portrait_size(size_mm)
    return height / max(width, 1e-9)


def _pouch_net_id(source_hash: str, face_ids: list[str]) -> str:
    encoded = json.dumps({"source": source_hash, "faces": sorted(face_ids)}, separators=(",", ":"))
    return "pouch-net-" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]


def _structure_from_panels(
    structure: Mapping[str, Any],
    panels: list[dict[str, Any]],
) -> dict[str, Any] | None:
    point_keys = sorted(
        {
            (round(float(point[0]), 6), round(float(point[1]), 6))
            for panel in panels
            for point in panel["points"]
        }
    )
    vertex_ids = {point: f"pv-{index:04d}" for index, point in enumerate(point_keys, start=1)}
    segment_keys = sorted(
        {
            _segment_key(tuple(points[index]), tuple(points[(index + 1) % 4]))
            for panel in panels
            for points in [panel["points"]]
            for index in range(4)
        }
    )
    edge_ids = {key: f"pe-{index:04d}" for index, key in enumerate(segment_keys, start=1)}
    face_payload: list[dict[str, Any]] = []
    preview: list[dict[str, Any]] = []
    xs: list[float] = []
    ys: list[float] = []
    for panel in panels:
        identity = str(panel["id"])
        points = panel["points"]
        boundary = [
            edge_ids[_segment_key(tuple(points[item]), tuple(points[(item + 1) % 4]))]
            for item in range(4)
        ]
        face_payload.append(
            {
                "id": identity,
                "boundary": boundary,
                "role": "unknown",
                "artwork_transform": panel["transform"],
            }
        )
        polygon = panel["polygon"]
        bounds = [round(float(value), 6) for value in polygon.bounds]
        xs.extend(bounds[0::2])
        ys.extend(bounds[1::2])
        preview.append(
            {
                "id": identity,
                "bounds_mm": bounds,
                "centroid_mm": [round(float(polygon.centroid.x), 6), round(float(polygon.centroid.y), 6)],
                "area_mm2": round(float(polygon.area), 6),
                "rectangular": True,
                "size_mm": panel["size_mm"],
                "points_mm": [[round(float(x), 6), round(float(y), 6)] for x, y in points],
                "boundary_coverage": panel["coverage"],
            }
        )
    if len(face_payload) != 2:
        return None
    proposal = {
        "schema": structure["schema"],
        "units": "mm",
        "source": structure["source"],
        "packaging_family": "pouch",
        "vertices": [
            {"id": vertex_ids[point], "x": point[0], "y": point[1]}
            for point in point_keys
        ],
        "edges": [
            {
                "id": edge_ids[key],
                "start": vertex_ids[key[0]],
                "end": vertex_ids[key[1]],
                "assignment": "cut",
                "source_refs": ["pouch-v1:cut"],
            }
            for key in segment_keys
        ],
        "faces": face_payload,
        "folds": [],
        "root_face": None,
        "validation": {
            "status": "review_required",
            "errors": ["structure_face_mapping_incomplete"],
            "warnings": ["pouch_v1_requires_front_pick"],
        },
    }
    return {
        "structure": proposal,
        "faces": preview,
        "bounds_mm": [min(xs), min(ys), max(xs), max(ys)],
    }
