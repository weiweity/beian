"""Versioned semantic contract for packaging structure.

Adapters may differ, but every downstream caller receives the same normalized
millimetre-based value.  This module intentionally does not infer packaging
intent from colour, layer names, spacing, or bounding boxes.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any, Mapping


SCHEMA = "packaging-structure/1"
EDGE_ASSIGNMENTS = frozenset({"cut", "crease", "perforation", "glue", "ignore", "unknown"})
FACE_ROLES = frozenset(
    {
        "front",
        "right",
        "back",
        "left",
        "top",
        "bottom",
        "flap",
        "glue_tab",
        "unknown",
    }
)
VALIDATION_STATUSES = frozenset({"accepted", "review_required", "unsupported"})
UNIT_TO_MM = {"mm": 1.0, "pt": 25.4 / 72.0, "in": 25.4}
# Phase 0 observed at most 2,224 drawings and 315 knife candidates per real file.
# Keep a wide safety margin while rejecting 100k-item payloads before per-item
# normalization can monopolize the single packaging worker.
MAX_SEMANTIC_ITEMS = 20_000
DEFAULT_LIMITS = {
    "vertices": MAX_SEMANTIC_ITEMS,
    "edges": MAX_SEMANTIC_ITEMS,
    "faces": 10_000,
    "folds": MAX_SEMANTIC_ITEMS,
}
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class StructureContractError(ValueError):
    """Stable contract failure that callers can map to a product state."""

    def __init__(self, code: str, message: str, *, details: Mapping[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": str(self), "details": self.details}


def _fail(code: str, message: str, **details: Any) -> None:
    raise StructureContractError(code, message, details=details)


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _fail("structure_contract_invalid", f"{label} 必须是对象", field=label)
    return value


def _sequence(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        _fail("structure_contract_invalid", f"{label} 必须是数组", field=label)
    return value


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 128:
        _fail("structure_contract_invalid", f"{label} 必须是 1–128 字符的标识", field=label)
    if any(ch in value for ch in "\r\n\t"):
        _fail("structure_contract_invalid", f"{label} 不能含控制字符", field=label)
    return value


def _number(value: Any, label: str, *, lower: float | None = None, upper: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        _fail("structure_contract_invalid", f"{label} 必须是有限数值", field=label)
    result = float(value)
    if lower is not None and result < lower:
        _fail("structure_contract_invalid", f"{label} 不能小于 {lower}", field=label)
    if upper is not None and result > upper:
        _fail("structure_contract_invalid", f"{label} 不能大于 {upper}", field=label)
    return result


def _rounded(value: float) -> float:
    result = round(float(value), 6)
    return 0.0 if result == -0.0 else result


def _known_keys(value: Mapping[str, Any], allowed: set[str], label: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        _fail(
            "structure_contract_invalid",
            f"{label} 含未知字段：{','.join(unknown)}",
            field=label,
            unknown=unknown,
        )


def _unique_id(value: str, seen: set[str], label: str) -> None:
    if value in seen:
        _fail("structure_contract_invalid", f"{label} 重复：{value}", field=label, id=value)
    seen.add(value)


def _normalized_source(value: Any, factor: float) -> dict[str, Any]:
    source = _mapping(value, "source")
    _known_keys(
        source,
        {"sha256", "adapter", "adapter_version", "document_ref", "coordinate_space", "page_size"},
        "source",
    )
    source_hash = str(source.get("sha256") or "").lower()
    if not _SHA256.fullmatch(source_hash):
        _fail("structure_contract_invalid", "source.sha256 必须是 64 位十六进制", field="source.sha256")
    adapter = _identifier(source.get("adapter"), "source.adapter")
    adapter_version = _identifier(source.get("adapter_version"), "source.adapter_version")
    normalized = {"sha256": source_hash, "adapter": adapter, "adapter_version": adapter_version}
    if source.get("document_ref") is not None:
        document_ref = str(source["document_ref"])
        if not document_ref or len(document_ref) > 1024 or any(ch in document_ref for ch in "\r\n"):
            _fail("structure_contract_invalid", "source.document_ref 无效", field="source.document_ref")
        normalized["document_ref"] = document_ref
    if source.get("coordinate_space") is not None:
        if source["coordinate_space"] != "artboard-top-left":
            _fail(
                "structure_contract_invalid",
                f"source.coordinate_space 无效：{source['coordinate_space']}",
                field="source.coordinate_space",
            )
        normalized["coordinate_space"] = "artboard-top-left"
    if source.get("page_size") is not None:
        page_size = _sequence(source["page_size"], "source.page_size")
        if len(page_size) != 2:
            _fail("structure_contract_invalid", "source.page_size 必须是 [width,height]", field="source.page_size")
        normalized["page_size"] = [
            _rounded(_number(page_size[0], "source.page_size[0]", lower=1e-9) * factor),
            _rounded(_number(page_size[1], "source.page_size[1]", lower=1e-9) * factor),
        ]
    return normalized


def _normalized_validation(value: Any) -> dict[str, Any]:
    if value is None:
        return {"status": "review_required", "errors": [], "warnings": []}
    validation = _mapping(value, "validation")
    _known_keys(validation, {"status", "errors", "warnings"}, "validation")
    status = validation.get("status")
    if status not in VALIDATION_STATUSES:
        _fail("structure_contract_invalid", f"validation.status 无效：{status}", field="validation.status")
    result = {"status": status, "errors": [], "warnings": []}
    for key in ("errors", "warnings"):
        values = _sequence(validation.get(key, []), f"validation.{key}")
        if len(values) > 1000:
            _fail("structure_limit_exceeded", f"validation.{key} 条目过多", field=f"validation.{key}")
        result[key] = [str(item)[:500] for item in values]
    return result


def _normalize(payload: Mapping[str, Any], limits: Mapping[str, int] | None = None) -> dict[str, Any]:
    _known_keys(
        payload,
        {"schema", "units", "source", "vertices", "edges", "faces", "folds", "root_face", "structure_hash", "validation"},
        "structure",
    )
    if payload.get("schema") != SCHEMA:
        _fail(
            "structure_schema_unsupported",
            f"不支持的结构版本：{payload.get('schema')}",
            supported=SCHEMA,
        )
    units = payload.get("units")
    if units not in UNIT_TO_MM:
        _fail("structure_units_ambiguous", f"结构单位必须显式为 mm/pt/in，实际={units}", units=units)
    factor = UNIT_TO_MM[str(units)]
    configured_limits = {**DEFAULT_LIMITS, **dict(limits or {})}
    for name, maximum in configured_limits.items():
        if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum <= 0:
            _fail("structure_contract_invalid", f"limit {name} 必须是正整数", field=f"limits.{name}")

    source = _normalized_source(payload.get("source"), factor)
    raw_vertices = _sequence(payload.get("vertices"), "vertices")
    if len(raw_vertices) > configured_limits["vertices"]:
        _fail("structure_limit_exceeded", "顶点数量超过上限", count=len(raw_vertices), limit=configured_limits["vertices"])
    vertices: list[dict[str, Any]] = []
    vertex_ids: set[str] = set()
    for index, raw in enumerate(raw_vertices):
        item = _mapping(raw, f"vertices[{index}]")
        _known_keys(item, {"id", "x", "y"}, f"vertices[{index}]")
        identity = _identifier(item.get("id"), f"vertices[{index}].id")
        _unique_id(identity, vertex_ids, "vertex id")
        vertices.append(
            {
                "id": identity,
                "x": _rounded(_number(item.get("x"), f"vertices[{index}].x") * factor),
                "y": _rounded(_number(item.get("y"), f"vertices[{index}].y") * factor),
            }
        )

    raw_edges = _sequence(payload.get("edges"), "edges")
    if len(raw_edges) > configured_limits["edges"]:
        _fail("structure_limit_exceeded", "边数量超过上限", count=len(raw_edges), limit=configured_limits["edges"])
    edges: list[dict[str, Any]] = []
    edge_ids: set[str] = set()
    for index, raw in enumerate(raw_edges):
        item = _mapping(raw, f"edges[{index}]")
        _known_keys(item, {"id", "start", "end", "assignment", "fold_angle_deg", "source_refs"}, f"edges[{index}]")
        identity = _identifier(item.get("id"), f"edges[{index}].id")
        _unique_id(identity, edge_ids, "edge id")
        start = _identifier(item.get("start"), f"edges[{index}].start")
        end = _identifier(item.get("end"), f"edges[{index}].end")
        if start not in vertex_ids or end not in vertex_ids:
            _fail("structure_contract_invalid", f"edge {identity} 引用了不存在的顶点", edge=identity)
        if start == end:
            _fail("structure_contract_invalid", f"edge {identity} 起止顶点相同", edge=identity)
        assignment = item.get("assignment")
        if assignment not in EDGE_ASSIGNMENTS:
            _fail("structure_contract_invalid", f"edge {identity} assignment 无效：{assignment}", edge=identity)
        refs = _sequence(item.get("source_refs", []), f"edges[{index}].source_refs")
        if len(refs) > 100:
            _fail("structure_limit_exceeded", f"edge {identity} source_refs 过多", edge=identity)
        normalized_edge: dict[str, Any] = {
            "id": identity,
            "start": start,
            "end": end,
            "assignment": assignment,
            "source_refs": sorted({_identifier(ref, f"edges[{index}].source_refs") for ref in refs}),
        }
        if item.get("fold_angle_deg") is not None:
            normalized_edge["fold_angle_deg"] = _rounded(
                _number(item["fold_angle_deg"], f"edges[{index}].fold_angle_deg", lower=-180, upper=180)
            )
        edges.append(normalized_edge)

    raw_faces = _sequence(payload.get("faces", []), "faces")
    if len(raw_faces) > configured_limits["faces"]:
        _fail("structure_limit_exceeded", "面数量超过上限", count=len(raw_faces), limit=configured_limits["faces"])
    faces: list[dict[str, Any]] = []
    face_ids: set[str] = set()
    for index, raw in enumerate(raw_faces):
        item = _mapping(raw, f"faces[{index}]")
        _known_keys(item, {"id", "boundary", "role", "artwork_transform"}, f"faces[{index}]")
        identity = _identifier(item.get("id"), f"faces[{index}].id")
        _unique_id(identity, face_ids, "face id")
        boundary = [_identifier(edge, f"faces[{index}].boundary") for edge in _sequence(item.get("boundary"), f"faces[{index}].boundary")]
        if len(boundary) < 3 or len(set(boundary)) != len(boundary) or any(edge not in edge_ids for edge in boundary):
            _fail("structure_contract_invalid", f"face {identity} boundary 无效", face=identity)
        role = item.get("role", "unknown")
        if role not in FACE_ROLES:
            _fail("structure_contract_invalid", f"face {identity} role 无效：{role}", face=identity)
        normalized_face: dict[str, Any] = {"id": identity, "boundary": boundary, "role": role}
        if item.get("artwork_transform") is not None:
            transform = _sequence(item["artwork_transform"], f"faces[{index}].artwork_transform")
            if len(transform) != 6:
                _fail("artwork_transform_invalid", f"face {identity} artwork_transform 必须有 6 个数", face=identity)
            values = [_number(value, f"faces[{index}].artwork_transform") for value in transform]
            determinant = values[0] * values[3] - values[1] * values[2]
            if abs(determinant) < 1e-12:
                _fail("artwork_transform_invalid", f"face {identity} artwork_transform 不可逆", face=identity)
            values[4] *= factor
            values[5] *= factor
            normalized_face["artwork_transform"] = [_rounded(value) for value in values]
        faces.append(normalized_face)

    raw_folds = _sequence(payload.get("folds", []), "folds")
    if len(raw_folds) > configured_limits["folds"]:
        _fail("structure_limit_exceeded", "折叠关系超过上限", count=len(raw_folds), limit=configured_limits["folds"])
    folds: list[dict[str, Any]] = []
    fold_edges: set[str] = set()
    edge_by_id = {edge["id"]: edge for edge in edges}
    for index, raw in enumerate(raw_folds):
        item = _mapping(raw, f"folds[{index}]")
        _known_keys(item, {"edge", "left_face", "right_face", "angle_deg"}, f"folds[{index}]")
        edge = _identifier(item.get("edge"), f"folds[{index}].edge")
        if edge not in edge_by_id or edge_by_id[edge]["assignment"] not in {"crease", "perforation"}:
            _fail("structure_contract_invalid", f"fold {edge} 必须引用 crease/perforation 边", edge=edge)
        _unique_id(edge, fold_edges, "fold edge")
        left = _identifier(item.get("left_face"), f"folds[{index}].left_face")
        right = _identifier(item.get("right_face"), f"folds[{index}].right_face")
        if left == right or left not in face_ids or right not in face_ids:
            _fail("structure_contract_invalid", f"fold {edge} 面引用无效", edge=edge)
        folds.append(
            {
                "edge": edge,
                "left_face": left,
                "right_face": right,
                "angle_deg": _rounded(_number(item.get("angle_deg"), f"folds[{index}].angle_deg", lower=-180, upper=180)),
            }
        )

    root_face = payload.get("root_face")
    if root_face is not None:
        root_face = _identifier(root_face, "root_face")
        if root_face not in face_ids:
            _fail("structure_contract_invalid", "root_face 引用了不存在的面", root_face=root_face)

    return {
        "schema": SCHEMA,
        "units": "mm",
        "source": source,
        "vertices": sorted(vertices, key=lambda item: item["id"]),
        "edges": sorted(edges, key=lambda item: item["id"]),
        "faces": sorted(faces, key=lambda item: item["id"]),
        "folds": sorted(folds, key=lambda item: (item["edge"], item["left_face"], item["right_face"])),
        "root_face": root_face,
        "validation": _normalized_validation(payload.get("validation")),
    }


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _canonical_cycle(values: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ignore which boundary edge was listed first and its traversal direction."""
    if not values:
        return []
    candidates: list[list[dict[str, Any]]] = []
    for sequence in (values, list(reversed(values))):
        for index in range(len(sequence)):
            candidates.append(sequence[index:] + sequence[:index])
    return min(candidates, key=_stable_json)


def _hash_material(normalized: Mapping[str, Any]) -> dict[str, Any]:
    """Geometry identity independent of adapter object IDs and provenance refs."""
    vertex_by_id = {
        vertex["id"]: [vertex["x"], vertex["y"]]
        for vertex in normalized["vertices"]
    }
    edge_by_id: dict[str, dict[str, Any]] = {}
    for edge in normalized["edges"]:
        endpoints = sorted([vertex_by_id[edge["start"]], vertex_by_id[edge["end"]]])
        signature: dict[str, Any] = {
            "segment": endpoints,
            "assignment": edge["assignment"],
        }
        if edge.get("fold_angle_deg") is not None:
            signature["fold_angle_deg"] = edge["fold_angle_deg"]
        edge_by_id[edge["id"]] = signature

    face_by_id: dict[str, dict[str, Any]] = {}
    for face in normalized["faces"]:
        signature = {
            "boundary": _canonical_cycle([edge_by_id[edge] for edge in face["boundary"]]),
            "role": face["role"],
        }
        if face.get("artwork_transform") is not None:
            signature["artwork_transform"] = face["artwork_transform"]
        face_by_id[face["id"]] = signature

    return {
        "schema": normalized["schema"],
        "units": normalized["units"],
        "vertices": sorted(vertex_by_id.values()),
        "edges": sorted(edge_by_id.values(), key=_stable_json),
        "faces": sorted(face_by_id.values(), key=_stable_json),
        "folds": sorted(
            [
                {
                    "edge": edge_by_id[fold["edge"]],
                    "left_face": face_by_id[fold["left_face"]],
                    "right_face": face_by_id[fold["right_face"]],
                    "angle_deg": fold["angle_deg"],
                }
                for fold in normalized["folds"]
            ],
            key=_stable_json,
        ),
        "root_face": face_by_id.get(normalized["root_face"]),
        "artwork_space": {
            "coordinate_space": normalized["source"].get("coordinate_space"),
            "page_size": normalized["source"].get("page_size"),
        },
    }


def _digest(value: Mapping[str, Any]) -> str:
    encoded = _stable_json(value).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def canonicalize_structure(payload: Mapping[str, Any], *, limits: Mapping[str, int] | None = None) -> dict[str, Any]:
    normalized = _normalize(_mapping(payload, "structure"), limits)
    structure_hash = _digest(_hash_material(normalized))
    supplied_hash = payload.get("structure_hash")
    if supplied_hash is not None and supplied_hash != structure_hash:
        _fail(
            "structure_hash_mismatch",
            "结构哈希与规范化内容不一致",
            expected=structure_hash,
            actual=supplied_hash,
        )
    normalized["structure_hash"] = structure_hash
    return normalized


def structure_cache_key(payload: Mapping[str, Any], *, limits: Mapping[str, int] | None = None) -> str:
    normalized = canonicalize_structure(payload, limits=limits)
    source = normalized["source"]
    return _digest(
        {
            "schema": normalized["schema"],
            "source_sha256": source["sha256"],
            "adapter": source["adapter"],
            "adapter_version": source["adapter_version"],
            "structure_hash": normalized["structure_hash"],
        }
    )


def load_structure(source: Path | str | bytes | Mapping[str, Any], *, limits: Mapping[str, int] | None = None) -> dict[str, Any]:
    if isinstance(source, Mapping):
        payload: Any = deepcopy(dict(source))
    elif isinstance(source, Path):
        payload = json.loads(source.read_text(encoding="utf-8"))
    elif isinstance(source, bytes):
        payload = json.loads(source.decode("utf-8"))
    elif isinstance(source, str):
        try:
            payload = json.loads(source)
        except json.JSONDecodeError:
            payload = json.loads(Path(source).read_text(encoding="utf-8"))
    else:
        _fail("structure_contract_invalid", "不支持的结构输入类型", input_type=type(source).__name__)
    return canonicalize_structure(_mapping(payload, "structure"), limits=limits)
