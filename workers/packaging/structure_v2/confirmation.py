"""Apply an explicit human face-role decision to a V2 structure proposal."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Mapping

from .adapters import sha256_file
from .model import canonicalize_structure
from .resolver import BOX_ROLES, resolve_structure_payload


class StructureConfirmationError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code

    def as_dict(self) -> dict[str, Any]:
        return {"ok": False, "code": self.code, "message": str(self)}


def _read_json(path: Path, *, maximum: int = 25 * 1024 * 1024) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size > maximum:
        raise StructureConfirmationError("structure_confirmation_missing", "结构确认文件不存在或超过上限。")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise StructureConfirmationError("structure_confirmation_invalid", "结构确认文件不是有效 JSON。") from error
    if not isinstance(value, dict):
        raise StructureConfirmationError("structure_confirmation_invalid", "结构确认文件必须是对象。")
    return value


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


def _mapped_size(structure: Mapping[str, Any], face: Mapping[str, Any]) -> tuple[float, float]:
    transform = face.get("artwork_transform")
    if not isinstance(transform, list) or len(transform) != 6:
        raise StructureConfirmationError("artwork_transform_invalid", "所选盒面没有可用贴图方向。")
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
        raise StructureConfirmationError("artwork_transform_invalid", "所选盒面贴图尺寸无效。")
    return width, height


def _rotated_transform(transform: list[float], width: float, height: float, quarter_turns: int) -> list[float]:
    a, b, c, d, e, f = (float(value) for value in transform)
    turn = quarter_turns % 4
    if turn == 0:
        values = [a, b, c, d, e, f]
    elif turn == 1:
        values = [-b, a, -d, c, height - f, e]
    elif turn == 2:
        values = [-a, -b, -c, -d, width - e, height - f]
    else:
        values = [b, -a, d, -c, f, width - e]
    return [round(value, 9) for value in values]


def confirm_structure(
    *,
    source: Path | str,
    resolution_path: Path | str,
    decisions: Mapping[str, Any] | list[Mapping[str, Any]],
    output_path: Path | str,
) -> dict[str, Any]:
    source_path = Path(source).expanduser().resolve()
    if not source_path.is_file():
        raise StructureConfirmationError("packaging_source_missing", "包装源文件不存在。")
    resolution = _read_json(Path(resolution_path).expanduser().resolve())
    structure_value = resolution.get("structure")
    if resolution.get("status") != "review_required" or not isinstance(structure_value, dict):
        raise StructureConfirmationError("structure_confirmation_stale", "这单当前没有可确认的结构提案。")
    structure = canonicalize_structure(structure_value)
    if structure["source"]["sha256"] != sha256_file(source_path):
        raise StructureConfirmationError("structure_source_mismatch", "源稿已变化，请重新识别结构。")
    raw_faces = decisions.get("faces") if isinstance(decisions, Mapping) else decisions
    if not isinstance(raw_faces, list) or len(raw_faces) != 6:
        raise StructureConfirmationError("structure_face_mapping_incomplete", "必须确认且只确认六个盒面。")
    faces_by_id = {face["id"]: face for face in structure["faces"]}
    chosen_ids: set[str] = set()
    chosen_roles: set[str] = set()
    normalized: list[tuple[str, str, int]] = []
    for raw in raw_faces:
        if not isinstance(raw, Mapping):
            raise StructureConfirmationError("structure_confirmation_invalid", "盒面确认项必须是对象。")
        face_id = str(raw.get("id") or "")
        role = str(raw.get("role") or "")
        turns = raw.get("quarter_turns", 0)
        if face_id not in faces_by_id or face_id in chosen_ids:
            raise StructureConfirmationError("structure_face_mapping_incomplete", "盒面不存在或被重复选择。")
        if role not in BOX_ROLES or role in chosen_roles:
            raise StructureConfirmationError("structure_face_mapping_incomplete", "六个盒面角色必须各出现一次。")
        if isinstance(turns, bool) or not isinstance(turns, int) or turns not in {0, 1, 2, 3}:
            raise StructureConfirmationError("artwork_transform_invalid", "盒面方向只能旋转 0/90/180/270 度。")
        chosen_ids.add(face_id)
        chosen_roles.add(role)
        normalized.append((face_id, role, turns))
    if chosen_roles != set(BOX_ROLES):
        raise StructureConfirmationError("structure_face_mapping_incomplete", "六个盒面角色不完整。")

    structure.pop("structure_hash", None)
    for face in structure["faces"]:
        face["role"] = "unknown"
    for face_id, role, turns in normalized:
        face = faces_by_id[face_id]
        width, height = _mapped_size(structure, face)
        face["artwork_transform"] = _rotated_transform(
            list(face["artwork_transform"]),
            width,
            height,
            turns,
        )
        face["role"] = role
    selected_face_ids = {face_id for face_id, _role, _turns in normalized}
    structure["faces"] = [face for face in structure["faces"] if face["id"] in selected_face_ids]
    selected_edge_ids = {
        edge_id
        for face in structure["faces"]
        for edge_id in face["boundary"]
    }
    structure["edges"] = [edge for edge in structure["edges"] if edge["id"] in selected_edge_ids]
    selected_vertex_ids = {
        vertex_id
        for edge in structure["edges"]
        for vertex_id in (edge["start"], edge["end"])
    }
    structure["vertices"] = [
        vertex for vertex in structure["vertices"] if vertex["id"] in selected_vertex_ids
    ]
    structure["folds"] = [
        fold
        for fold in structure["folds"]
        if fold["edge"] in selected_edge_ids
        and fold["left_face"] in selected_face_ids
        and fold["right_face"] in selected_face_ids
    ]
    structure["root_face"] = next(face_id for face_id, role, _turns in normalized if role == "front")
    structure["validation"] = {"status": "accepted", "errors": [], "warnings": []}
    approved = canonicalize_structure(structure)
    resolved = resolve_structure_payload(approved)
    if resolved.status != "ready" or resolved.resolved is None:
        raise StructureConfirmationError(
            resolved.code or "structure_confirmation_invalid",
            resolved.message or "六面确认不能形成受支持的闭合盒。",
        )
    destination = Path(output_path).expanduser().resolve()
    _atomic_json(destination, approved)
    return {
        "ok": True,
        "sidecar": str(destination),
        "structure_hash": approved["structure_hash"],
        "dimensions_mm": resolved.resolved["dimensions_mm"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="确认 PackagingStructure V2 六面角色")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--resolution", type=Path, required=True)
    parser.add_argument("--decisions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    decisions = _read_json(args.decisions, maximum=1024 * 1024)
    result = confirm_structure(
        source=args.source,
        resolution_path=args.resolution,
        decisions=decisions,
        output_path=args.output,
    )
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except StructureConfirmationError as error:
        print(json.dumps(error.as_dict(), ensure_ascii=False, separators=(",", ":")), file=os.sys.stderr)
        raise SystemExit(2)
