"""Resolve validated semantic structure into the existing six-face box contract."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Mapping

from .adapters import AdaptationResult, adapt_structure
from .model import StructureContractError, canonicalize_structure, structure_cache_key
from .topology import TopologyError, analyze_declared_faces, analyze_topology, derive_face_proposal


BOX_ROLES = ("front", "right", "back", "left", "top", "bottom")
ROLE_DIMENSIONS = {
    "front": ("width", "height"),
    "back": ("width", "height"),
    "left": ("depth", "height"),
    "right": ("depth", "height"),
    "top": ("width", "depth"),
    "bottom": ("width", "depth"),
}
CACHE_SCHEMA = "packaging-structure-cache/1"
RESOLVED_SCHEMA = "resolved-packaging-job/1"


@dataclass(frozen=True)
class ResolutionResult:
    status: str
    code: str | None = None
    message: str | None = None
    structure: dict[str, Any] | None = None
    resolved: dict[str, Any] | None = None
    topology: dict[str, Any] | None = None
    cache_hit: bool = False

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"status": self.status, "cache_hit": self.cache_hit}
        for key in ("code", "message", "structure", "resolved", "topology"):
            value = getattr(self, key)
            if value is not None:
                result[key] = value
        return result


def _review(code: str, message: str, *, structure: dict[str, Any], topology: dict[str, Any] | None = None) -> ResolutionResult:
    return ResolutionResult(
        status="review_required",
        code=code,
        message=message,
        structure=structure,
        topology=topology,
    )


def _close(left: float, right: float, tolerance: float) -> bool:
    return abs(left - right) <= max(tolerance, max(abs(left), abs(right)) * 0.001)


def _matching_pair(left: list[float], right: list[float], tolerance: float) -> bool:
    return all(_close(a, b, tolerance) for a, b in zip(sorted(left), sorted(right)))


def _solve_dimensions(front: list[float], right: list[float], top: list[float], tolerance: float) -> dict[str, float] | None:
    candidates: set[tuple[float, float, float]] = set()
    for width, front_height in ((front[0], front[1]), (front[1], front[0])):
        for depth, right_height in ((right[0], right[1]), (right[1], right[0])):
            for top_width, top_depth in ((top[0], top[1]), (top[1], top[0])):
                if (
                    _close(front_height, right_height, tolerance)
                    and _close(width, top_width, tolerance)
                    and _close(depth, top_depth, tolerance)
                ):
                    candidates.add((round(width, 6), round(depth, 6), round(front_height, 6)))
    if len(candidates) != 1:
        return None
    width, depth, height = next(iter(candidates))
    return {"width": width, "depth": depth, "height": height}


def _box_roles(structure: Mapping[str, Any]) -> tuple[dict[str, dict[str, Any]], list[str]]:
    roles: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for face in structure["faces"]:
        role = face["role"]
        if role not in BOX_ROLES:
            continue
        if role in roles:
            errors.append("structure_face_mapping_incomplete")
        roles[role] = face
    if set(roles) != set(BOX_ROLES):
        errors.append("structure_face_mapping_incomplete")
    if any("artwork_transform" not in face for face in roles.values()):
        errors.append("artwork_transform_invalid")
    return roles, sorted(set(errors))


def _fold_graph_valid(structure: Mapping[str, Any], role_faces: Mapping[str, Mapping[str, Any]]) -> bool:
    face_ids = {face["id"] for face in role_faces.values()}
    boundaries = {face["id"]: set(face["boundary"]) for face in role_faces.values()}
    graph = {identity: set() for identity in face_ids}
    for fold in structure["folds"]:
        left, right, edge = fold["left_face"], fold["right_face"], fold["edge"]
        if left not in face_ids or right not in face_ids:
            continue
        if edge not in boundaries[left] or edge not in boundaries[right]:
            return False
        graph[left].add(right)
        graph[right].add(left)
    if not graph:
        return False
    pending = [next(iter(graph))]
    visited: set[str] = set()
    while pending:
        current = pending.pop()
        if current in visited:
            continue
        visited.add(current)
        pending.extend(graph[current] - visited)
    return visited == face_ids


def _mapped_face_size(
    structure: Mapping[str, Any],
    face: Mapping[str, Any],
) -> list[float] | None:
    transform = face.get("artwork_transform")
    if not isinstance(transform, list) or len(transform) != 6:
        return None
    a, b, c, d, e, f = (float(value) for value in transform)
    vertices = {item["id"]: (float(item["x"]), float(item["y"])) for item in structure["vertices"]}
    edges = {item["id"]: item for item in structure["edges"]}
    points: set[tuple[float, float]] = set()
    for edge_id in face["boundary"]:
        edge = edges[edge_id]
        points.add(vertices[edge["start"]])
        points.add(vertices[edge["end"]])
    if len(points) < 3:
        return None
    mapped = [(a * x + c * y + e, b * x + d * y + f) for x, y in points]
    width = max(point[0] for point in mapped) - min(point[0] for point in mapped)
    height = max(point[1] for point in mapped) - min(point[1] for point in mapped)
    if width <= 0 or height <= 0:
        return None
    return [round(width, 6), round(height, 6)]


def _artwork_orientations_valid(
    structure: Mapping[str, Any],
    role_faces: Mapping[str, Mapping[str, Any]],
    dimensions: Mapping[str, float],
    tolerance: float,
) -> bool:
    for role, face in role_faces.items():
        actual = _mapped_face_size(structure, face)
        if actual is None:
            return False
        keys = ROLE_DIMENSIONS[role]
        expected = [float(dimensions[keys[0]]), float(dimensions[keys[1]])]
        if not all(_close(left, right, tolerance) for left, right in zip(actual, expected)):
            return False
    return True


def _atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def _cache_path(cache_dir: Path, cache_key: str) -> Path:
    return cache_dir / (cache_key.removeprefix("sha256:") + ".json")


def _load_cache(cache_dir: Path | None, cache_key: str) -> dict[str, Any] | None:
    if cache_dir is None:
        return None
    path = _cache_path(cache_dir, cache_key)
    if not path.is_file() or path.stat().st_size > 25 * 1024 * 1024:
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if payload.get("schema") != CACHE_SCHEMA or payload.get("cache_key") != cache_key:
        return None
    resolved = payload.get("resolved")
    if not isinstance(resolved, dict) or resolved.get("schema") != RESOLVED_SCHEMA:
        return None
    return resolved


def _save_cache(cache_dir: Path | None, cache_key: str, resolved: Mapping[str, Any]) -> None:
    if cache_dir is None:
        return
    _atomic_json(
        _cache_path(cache_dir, cache_key),
        {"schema": CACHE_SCHEMA, "cache_key": cache_key, "resolved": resolved},
    )


def resolve_structure_payload(
    payload: Mapping[str, Any],
    *,
    cache_dir: Path | str | None = None,
    snap_tolerance_mm: float = 0.1,
    dimension_tolerance_mm: float = 0.1,
) -> ResolutionResult:
    try:
        structure = canonicalize_structure(payload)
    except (StructureContractError, TopologyError) as error:
        code = getattr(error, "code", "structure_contract_invalid")
        status = "unsupported" if code in {"structure_schema_unsupported", "structure_limit_exceeded"} else "review_required"
        return ResolutionResult(status=status, code=code, message=str(error))
    topology = analyze_topology(structure, snap_tolerance_mm=snap_tolerance_mm)
    if topology["status"] != "accepted":
        return _review(
            topology["errors"][0] if topology["errors"] else "structure_face_mapping_incomplete",
            "包装结构拓扑需要人工确认。",
            structure=structure,
            topology=topology,
        )
    if not structure["faces"]:
        try:
            proposal = derive_face_proposal(structure, snap_tolerance_mm=snap_tolerance_mm)
        except TopologyError as error:
            return _review(error.code, str(error), structure=structure, topology=topology)
        proposal_topology = dict(topology)
        proposal_topology["face_proposal"] = proposal["faces"]
        return _review(
            "structure_face_mapping_incomplete",
            "结构线已形成闭合面，请确认六个盒面和方向。",
            structure=proposal["structure"],
            topology=proposal_topology,
        )
    if structure["validation"]["status"] != "accepted":
        return _review(
            "structure_approval_required",
            "包装结构尚未被人工确认。",
            structure=structure,
            topology=topology,
        )
    key = structure_cache_key(structure)
    cache_root = Path(cache_dir).expanduser().resolve() if cache_dir is not None else None
    cached = _load_cache(cache_root, key)
    if cached is not None:
        return ResolutionResult(status="ready", structure=structure, resolved=cached, cache_hit=True)
    role_faces, role_errors = _box_roles(structure)
    if role_errors:
        return _review(role_errors[0], "包装结构尚未完成六面和贴图映射。", structure=structure, topology=topology)
    declared = analyze_declared_faces(
        structure,
        face_ids={face["id"] for face in role_faces.values()},
    )
    if declared["status"] != "accepted":
        return _review(
            declared["errors"][0]["code"],
            "声明的包装面无法形成有效矩形。",
            structure=structure,
            topology=topology,
        )
    metrics = declared["faces"]
    if not (
        _matching_pair(metrics[role_faces["front"]["id"]]["size_mm"], metrics[role_faces["back"]["id"]]["size_mm"], dimension_tolerance_mm)
        and _matching_pair(metrics[role_faces["left"]["id"]]["size_mm"], metrics[role_faces["right"]["id"]]["size_mm"], dimension_tolerance_mm)
        and _matching_pair(metrics[role_faces["top"]["id"]]["size_mm"], metrics[role_faces["bottom"]["id"]]["size_mm"], dimension_tolerance_mm)
    ):
        return _review("structure_face_dimensions_mismatch", "相对面的尺寸不一致。", structure=structure, topology=topology)
    dimensions = _solve_dimensions(
        metrics[role_faces["front"]["id"]]["size_mm"],
        metrics[role_faces["right"]["id"]]["size_mm"],
        metrics[role_faces["top"]["id"]]["size_mm"],
        dimension_tolerance_mm,
    )
    if dimensions is None:
        return _review("structure_dimensions_ambiguous", "无法唯一确定 width/depth/height。", structure=structure, topology=topology)
    if not _artwork_orientations_valid(structure, role_faces, dimensions, dimension_tolerance_mm):
        return _review("artwork_transform_invalid", "六面贴图方向与盒面尺寸不一致。", structure=structure, topology=topology)
    if not _fold_graph_valid(structure, role_faces):
        return _review("structure_fold_graph_invalid", "六面折叠邻接不完整。", structure=structure, topology=topology)

    resolved_faces = {
        role: {
            "face_id": face["id"],
            "boundary": face["boundary"],
            "artwork_transform": face["artwork_transform"],
            **metrics[face["id"]],
        }
        for role, face in role_faces.items()
    }
    resolved = {
        "schema": RESOLVED_SCHEMA,
        "structure_schema": structure["schema"],
        "structure_hash": structure["structure_hash"],
        "cache_key": key,
        "source_sha256": structure["source"]["sha256"],
        "adapter": structure["source"]["adapter"],
        "adapter_version": structure["source"]["adapter_version"],
        "dimensions_mm": dimensions,
        "faces": resolved_faces,
        "topology_counts": topology["counts"],
        "validation": {"status": "accepted", "errors": [], "warnings": []},
    }
    _save_cache(cache_root, key, resolved)
    return ResolutionResult(status="ready", structure=structure, resolved=resolved, topology=topology)


def resolve_structure(
    source: Path | str,
    *,
    sidecar: Path | str | None = None,
    cache_dir: Path | str | None = None,
    snap_tolerance_mm: float = 0.1,
) -> ResolutionResult:
    adapted: AdaptationResult = adapt_structure(source, sidecar=sidecar)
    if adapted.status != "adapted" or adapted.structure is None:
        return ResolutionResult(
            status=adapted.status,
            code=adapted.code,
            message=adapted.message,
        )
    return resolve_structure_payload(
        adapted.structure,
        cache_dir=cache_dir,
        snap_tolerance_mm=snap_tolerance_mm,
    )
