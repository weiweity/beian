"""Apply an explicit human face-role decision to a V2 structure proposal."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Mapping

from .adapters import sha256_file
from .box_net import BOX_NET_PROPOSAL_SCHEMA
from .dimensions import (
    DimensionPolicy,
    MAX_CLOSURE_ASSEMBLY_MEMBER_RATIO,
    MAX_CLOSURE_ASSEMBLY_MEMBER_SUM_RATIO,
    MIN_CLOSURE_ASSEMBLY_MEMBER_RATIO,
    MIN_CLOSURE_ASSEMBLY_UNION_RATIO,
    fit_closure_dimensions,
    fit_closure_member_dimensions,
    geometry_policy_for_source,
    is_stroke_proposal_source,
    normalized_mm,
    solve_body_dimensions,
)
from .model import canonicalize_structure
from .pouch import POUCH_NET_PROPOSAL_SCHEMA
from .resolver import resolve_structure_payload


CAP_OUTWARD_DIRECTIONS = {
    "top": {
        "front": (0, -1),
        "right": (-1, 0),
        "back": (0, 1),
        "left": (1, 0),
    },
    "bottom": {
        "front": (0, 1),
        "right": (-1, 0),
        "back": (0, -1),
        "left": (1, 0),
    },
}


class StructureConfirmationError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code

    def as_dict(self) -> dict[str, Any]:
        return {"ok": False, "code": self.code, "message": str(self)}


@dataclass(frozen=True)
class FaceDecision:
    face_id: str
    role: str
    target_role: str
    quarter_turns: int
    expected_size: tuple[float, float]
    closure_kind: str | None = None
    attached_body_face_id: str | None = None


def _read_json(path: Path, *, maximum: int = 25 * 1024 * 1024) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size > maximum:
        raise StructureConfirmationError("structure_confirmation_missing", "结构确认文件不存在或超过上限。")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise StructureConfirmationError(
            "structure_confirmation_storage_invalid",
            "结构确认数据损坏，请稍后重试。",
        ) from error
    if not isinstance(value, dict):
        raise StructureConfirmationError(
            "structure_confirmation_storage_invalid",
            "结构确认数据损坏，请稍后重试。",
        )
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


def _mapped_bounds(
    structure: Mapping[str, Any],
    face: Mapping[str, Any],
    transform: list[float] | None = None,
) -> tuple[float, float, float, float]:
    transform = face.get("artwork_transform") if transform is None else transform
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
    if len(points) < 3:
        raise StructureConfirmationError("artwork_transform_invalid", "所选盒面贴图边界不完整。")
    mapped = [(a * x + c * y + e, b * x + d * y + f) for x, y in points]
    bounds = (
        min(point[0] for point in mapped),
        min(point[1] for point in mapped),
        max(point[0] for point in mapped),
        max(point[1] for point in mapped),
    )
    if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
        raise StructureConfirmationError("artwork_transform_invalid", "所选盒面贴图尺寸无效。")
    return bounds


def _mapped_size(structure: Mapping[str, Any], face: Mapping[str, Any]) -> tuple[float, float]:
    minimum_x, minimum_y, maximum_x, maximum_y = _mapped_bounds(structure, face)
    width = maximum_x - minimum_x
    height = maximum_y - minimum_y
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


def _face_centroid(structure: Mapping[str, Any], face: Mapping[str, Any]) -> tuple[float, float]:
    vertices = {item["id"]: (float(item["x"]), float(item["y"])) for item in structure["vertices"]}
    edges = {item["id"]: item for item in structure["edges"]}
    points = {
        vertices[vertex_id]
        for edge_id in face["boundary"]
        for vertex_id in (edges[edge_id]["start"], edges[edge_id]["end"])
    }
    if len(points) < 3:
        raise StructureConfirmationError("structure_face_mapping_incomplete", "盒面边界不完整。")
    return (
        sum(point[0] for point in points) / len(points),
        sum(point[1] for point in points) / len(points),
    )


def _turned_size(structure: Mapping[str, Any], face: Mapping[str, Any], turns: int) -> tuple[float, float]:
    width, height = _mapped_size(structure, face)
    return (height, width) if turns % 2 else (width, height)


def _turn_distance(left: int, right: int) -> int:
    delta = abs((left % 4) - (right % 4))
    return min(delta, 4 - delta)


def _turn_for_size(
    structure: Mapping[str, Any],
    face: Mapping[str, Any],
    expected: tuple[float, float],
    preferred: int,
    dimensions: DimensionPolicy,
) -> int:
    matches = [
        turns
        for turns in range(4)
        if all(
            dimensions.close(actual, target)
            for actual, target in zip(_turned_size(structure, face, turns), expected)
        )
    ]
    if not matches:
        raise StructureConfirmationError("structure_face_dimensions_mismatch", "完整盒型的相对面尺寸不一致。")
    return min(matches, key=lambda turns: (_turn_distance(turns, preferred), turns))


def _linear_vector(transform: list[float], vector: tuple[float, float]) -> tuple[float, float]:
    a, b, c, d, _e, _f = (float(value) for value in transform)
    return (a * vector[0] + c * vector[1], b * vector[0] + d * vector[1])


def _selected_fold_neighbors(
    structure: Mapping[str, Any],
    faces_by_id: Mapping[str, Mapping[str, Any]],
    selected_ids: set[str],
) -> dict[str, set[str]]:
    folds = _selected_fold_records(structure, faces_by_id, selected_ids)
    boundaries = {
        face_id: set(faces_by_id[face_id]["boundary"])
        for face_id in selected_ids
    }
    neighbors = {face_id: set() for face_id in selected_ids}
    for fold in folds:
        left = str(fold["left_face"])
        right = str(fold["right_face"])
        edge = str(fold["edge"])
        if edge not in boundaries[left] or edge not in boundaries[right]:
            raise StructureConfirmationError("structure_fold_graph_invalid", "折线没有同时属于相邻盒面。")
        neighbors[left].add(right)
        neighbors[right].add(left)
    return neighbors


def _selected_fold_records(
    structure: Mapping[str, Any],
    faces_by_id: Mapping[str, Mapping[str, Any]],
    selected_ids: set[str],
) -> list[dict[str, Any]]:
    """Resolve folds inside one complete-net selection.

    A stroke proposal exposes the union of candidates from every whole-net
    option.  Several alternative flap rectangles may therefore share the same
    physical fold edge.  Global edge cardinality is not a fold contract; once
    a net is selected, derive adjacency only from that net's face boundaries.
    Explicit semantic structures continue to use their declared folds.
    """
    if not is_stroke_proposal_source(structure.get("source")):
        return [
            dict(fold)
            for fold in structure["folds"]
            if str(fold["left_face"]) in selected_ids
            and str(fold["right_face"]) in selected_ids
        ]

    edges = {str(edge["id"]): edge for edge in structure["edges"]}
    edge_faces: dict[str, list[str]] = {}
    for face_id in sorted(selected_ids):
        for edge_id in {str(value) for value in faces_by_id[face_id]["boundary"]}:
            edge = edges.get(edge_id)
            if edge is not None and edge.get("assignment") in {"crease", "perforation"}:
                edge_faces.setdefault(edge_id, []).append(face_id)
    folds: list[dict[str, Any]] = []
    for edge_id, face_ids in sorted(edge_faces.items()):
        if len(face_ids) > 2:
            raise StructureConfirmationError(
                "structure_fold_graph_invalid",
                "所选完整盒型在同一折线上包含多个重叠盒面。",
            )
        if len(face_ids) == 2:
            folds.append(
                {
                    "edge": edge_id,
                    "left_face": face_ids[0],
                    "right_face": face_ids[1],
                    "angle_deg": 90.0,
                }
            )
    return folds


def _cap_body_neighbor(
    neighbors: Mapping[str, set[str]],
    cap_id: str,
    body_ids: set[str],
) -> str:
    body_neighbors = neighbors[cap_id] & body_ids
    if len(body_neighbors) != 1:
        raise StructureConfirmationError("structure_fold_graph_invalid", "每个顶部或底部必须只连接一个盒身面。")
    return next(iter(body_neighbors))


def _shared_fold_midpoint(
    structure: Mapping[str, Any],
    cap_face: Mapping[str, Any],
    body_face: Mapping[str, Any],
) -> tuple[float, float]:
    cap_id = str(cap_face["id"])
    body_id = str(body_face["id"])
    if is_stroke_proposal_source(structure.get("source")):
        edge_assignments = {
            str(edge["id"]): str(edge["assignment"])
            for edge in structure["edges"]
        }
        shared = sorted(
            set(str(edge_id) for edge_id in cap_face["boundary"])
            & set(str(edge_id) for edge_id in body_face["boundary"])
        )
        shared = [
            edge_id
            for edge_id in shared
            if edge_assignments.get(edge_id) in {"crease", "perforation"}
        ]
    else:
        shared = [
            str(fold["edge"])
            for fold in structure["folds"]
            if {str(fold["left_face"]), str(fold["right_face"])} == {cap_id, body_id}
        ]
    if len(shared) != 1:
        raise StructureConfirmationError("structure_fold_graph_invalid", "盒盖与盒身必须只共享一条折线。")
    edges = {str(edge["id"]): edge for edge in structure["edges"]}
    vertices = {
        str(vertex["id"]): (float(vertex["x"]), float(vertex["y"]))
        for vertex in structure["vertices"]
    }
    edge = edges.get(shared[0])
    if edge is None:
        raise StructureConfirmationError("structure_fold_graph_invalid", "盒盖折线不存在。")
    start = vertices.get(str(edge["start"]))
    end = vertices.get(str(edge["end"]))
    if start is None or end is None:
        raise StructureConfirmationError("structure_fold_graph_invalid", "盒盖折线端点不存在。")
    return ((start[0] + end[0]) / 2, (start[1] + end[1]) / 2)


def _direction_matches(actual: tuple[float, float], expected: tuple[int, int]) -> bool:
    if expected[0]:
        primary, secondary = actual[0] * expected[0], actual[1]
    else:
        primary, secondary = actual[1] * expected[1], actual[0]
    return primary > 0.1 and abs(secondary) <= max(0.1, abs(primary) * 0.03)


def _turn_for_cap(
    structure: Mapping[str, Any],
    cap_face: Mapping[str, Any],
    attached_body: Mapping[str, Any],
    *,
    role: str,
    attached_role: str,
    expected_size: tuple[float, float],
    dimensions: DimensionPolicy,
    assembly_member: bool,
) -> int:
    # The Blender role contract fixes each panel's texture axes.  Dimensions
    # alone cannot distinguish 90° from 270° (especially on square caps), so
    # use the actual fold attachment to map the flat net into that contract.
    expected_direction = CAP_OUTWARD_DIRECTIONS[role][attached_role]
    cap_center = _face_centroid(structure, cap_face)
    fold_center = _shared_fold_midpoint(structure, cap_face, attached_body)
    source_outward = (cap_center[0] - fold_center[0], cap_center[1] - fold_center[1])
    width, height = _mapped_size(structure, cap_face)
    size_matches = []
    for candidate in range(4):
        actual = _turned_size(structure, cap_face, candidate)
        fit = (
            fit_closure_member_dimensions(actual, expected_size, dimensions)
            if assembly_member
            else fit_closure_dimensions(actual, expected_size, dimensions)
        )
        if fit is not None:
            size_matches.append(candidate)
    if not size_matches:
        raise StructureConfirmationError(
            "structure_face_dimensions_mismatch",
            "盒盖尺寸与盒身宽深不一致，不能形成闭合盒。",
        )
    matches = []
    for candidate in size_matches:
        transform = _rotated_transform(
            list(cap_face["artwork_transform"]),
            width,
            height,
            candidate,
        )
        if _direction_matches(_linear_vector(transform, source_outward), expected_direction):
            matches.append(candidate)
    if len(matches) != 1:
        raise StructureConfirmationError("artwork_transform_invalid", "盒盖折线不能唯一确定贴图方向。")
    return matches[0]


def _align_closure_transform(
    structure: Mapping[str, Any],
    face: Mapping[str, Any],
    transform: list[float],
    expected_size: tuple[float, float],
    outward_direction: tuple[int, int],
) -> list[float]:
    """Align a main closure panel without scaling its printed artwork.

    A normal clearance or verified multi-flap closure leaves an uncovered strip
    on the erected footprint. Keep the fold edge fixed, center the perpendicular
    allowance, and let the renderer preserve it as an alpha mask until the
    physical layers are composited over the configured substrate.
    An isolated short dust flap never reaches this function because proposal,
    confirmation, and final resolution use the same dimensional policy.
    """
    minimum_x, minimum_y, maximum_x, maximum_y = _mapped_bounds(structure, face, transform)
    actual_width = maximum_x - minimum_x
    actual_height = maximum_y - minimum_y
    shift_x = (expected_size[0] - actual_width) / 2.0 - minimum_x
    shift_y = (expected_size[1] - actual_height) / 2.0 - minimum_y
    if outward_direction[0] > 0:
        shift_x = -minimum_x
    elif outward_direction[0] < 0:
        shift_x = expected_size[0] - maximum_x
    elif outward_direction[1] > 0:
        shift_y = -minimum_y
    else:
        shift_y = expected_size[1] - maximum_y
    a, b, c, d, e, f = transform
    return [
        round(a, 9),
        round(b, 9),
        round(c, 9),
        round(d, 9),
        round(e + shift_x, 9),
        round(f + shift_y, 9),
    ]


def _anchor_decisions(
    resolution: Mapping[str, Any],
    structure: Mapping[str, Any],
    anchor: Mapping[str, Any],
) -> tuple[list[FaceDecision], list[dict[str, Any]]]:
    dimensions = geometry_policy_for_source(structure.get("source")).dimensions
    proposal_id = str(anchor.get("proposal_id") or "")
    front_id = str(anchor.get("front_face_id") or "")
    turns = anchor.get("quarter_turns", 0)
    if isinstance(turns, bool) or not isinstance(turns, int) or turns not in {0, 1, 2, 3}:
        raise StructureConfirmationError("artwork_transform_invalid", "正面方向只能旋转 0/90/180/270 度。")
    topology = resolution.get("topology")
    raw_nets = topology.get("net_proposals") if isinstance(topology, Mapping) else None
    if not isinstance(raw_nets, list):
        raise StructureConfirmationError("structure_confirmation_stale", "这单还是旧版结构候选，请重新识别。")
    net = next(
        (
            item
            for item in raw_nets
            if isinstance(item, Mapping) and str(item.get("id") or "") == proposal_id
        ),
        None,
    )
    if net is None:
        raise StructureConfirmationError("structure_confirmation_stale", "所选完整盒型已经失效，请刷新后重试。")
    bound_hash = net.get("structure_hash")
    if not isinstance(bound_hash, str) or bound_hash != structure.get("structure_hash"):
        raise StructureConfirmationError("structure_confirmation_stale", "完整盒型与当前结构版本不一致，请重新识别。")
    body_ids = [str(value) for value in net.get("body_face_ids", [])]
    cap_ids = [str(value) for value in net.get("cap_face_ids", [])]
    face_ids = [str(value) for value in net.get("face_ids", [])]
    if (
        net.get("schema") != BOX_NET_PROPOSAL_SCHEMA
        or len(body_ids) != 4
        or len(set(body_ids)) != 4
        or len(cap_ids) != 2
        or len(set(cap_ids)) != 2
        or len(face_ids) < 6
        or len(set(face_ids)) != len(face_ids)
        or not set(body_ids + cap_ids) <= set(face_ids)
    ):
        raise StructureConfirmationError("structure_confirmation_invalid", "完整盒型提案格式不对。")
    raw_closures = net.get("closure_assemblies")
    if not isinstance(raw_closures, list) or len(raw_closures) != 2:
        raise StructureConfirmationError("structure_confirmation_invalid", "完整盒型封口提案格式不对。")
    closure_contracts: dict[str, dict[str, Any]] = {}
    closure_member_ids: set[str] = set()
    closure_sides: set[int] = set()
    for raw_closure in raw_closures:
        if not isinstance(raw_closure, Mapping):
            raise StructureConfirmationError("structure_confirmation_invalid", "完整盒型封口提案格式不对。")
        cap_id = str(raw_closure.get("primary_face_id") or "")
        coverage_ratio = raw_closure.get("coverage_ratio")
        closure_kind = str(raw_closure.get("closure_kind") or "")
        side = raw_closure.get("side")
        raw_members = raw_closure.get("members")
        if (
            cap_id not in cap_ids
            or cap_id in closure_contracts
            or isinstance(coverage_ratio, bool)
            or not isinstance(coverage_ratio, (int, float))
            or not 0 < float(coverage_ratio) <= 1.0
            or isinstance(side, bool)
            or side not in {-1, 1}
            or side in closure_sides
            or raw_closure.get("extent") not in {"full", "partial"}
            or closure_kind not in {"full", "clearance", "assembly"}
            or not isinstance(raw_members, list)
        ):
            raise StructureConfirmationError("structure_confirmation_invalid", "完整盒型封口提案格式不对。")
        expected_member_count = 2 if closure_kind == "assembly" else 1
        if len(raw_members) != expected_member_count:
            raise StructureConfirmationError("structure_confirmation_invalid", "完整盒型封口成员不完整。")
        members: list[dict[str, Any]] = []
        local_member_ids: set[str] = set()
        for raw_member in raw_members:
            if not isinstance(raw_member, Mapping):
                raise StructureConfirmationError("structure_confirmation_invalid", "完整盒型封口成员格式不对。")
            member_id = str(raw_member.get("face_id") or "")
            attached_id = str(raw_member.get("attached_body_face_id") or "")
            member_ratio = raw_member.get("coverage_ratio")
            if (
                member_id not in face_ids
                or member_id in body_ids
                or member_id in local_member_ids
                or member_id in closure_member_ids
                or attached_id not in body_ids
                or isinstance(member_ratio, bool)
                or not isinstance(member_ratio, (int, float))
                or not 0 < float(member_ratio) <= 1.0
                or raw_member.get("extent") not in {"full", "partial"}
            ):
                raise StructureConfirmationError("structure_confirmation_invalid", "完整盒型封口成员格式不对。")
            if closure_kind == "assembly" and not (
                raw_member.get("extent") == "partial"
                and MIN_CLOSURE_ASSEMBLY_MEMBER_RATIO
                <= float(member_ratio)
                <= MAX_CLOSURE_ASSEMBLY_MEMBER_RATIO
            ):
                raise StructureConfirmationError("structure_confirmation_invalid", "组合封口成员已经失效。")
            local_member_ids.add(member_id)
            closure_member_ids.add(member_id)
            members.append(
                {
                    "face_id": member_id,
                    "attached_body_face_id": attached_id,
                    "coverage_ratio": float(member_ratio),
                }
            )
        if cap_id not in local_member_ids:
            raise StructureConfirmationError("structure_confirmation_invalid", "完整盒型主封口不在成员集合中。")
        if closure_kind == "assembly" and (
            raw_closure.get("extent") not in {"full", "partial"}
            or float(coverage_ratio) < MIN_CLOSURE_ASSEMBLY_UNION_RATIO
            or sum(float(member["coverage_ratio"]) for member in members)
            > MAX_CLOSURE_ASSEMBLY_MEMBER_SUM_RATIO + 1e-6
            or float(coverage_ratio)
            > min(1.0, sum(float(member["coverage_ratio"]) for member in members)) + 1e-6
        ):
            raise StructureConfirmationError("structure_confirmation_invalid", "组合封口提案已经失效。")
        if closure_kind != "assembly" and abs(float(members[0]["coverage_ratio"]) - float(coverage_ratio)) > 1e-6:
            raise StructureConfirmationError("structure_confirmation_invalid", "单片封口覆盖率已经失效。")
        if closure_kind == "full" and abs(float(coverage_ratio) - 1.0) > 1e-6:
            raise StructureConfirmationError("structure_confirmation_invalid", "完整封口覆盖率已经失效。")
        closure_sides.add(int(side))
        closure_contracts[cap_id] = {
            "primary_face_id": cap_id,
            "side": int(side),
            "closure_kind": closure_kind,
            "coverage_ratio": float(coverage_ratio),
            "members": members,
        }
    if (
        set(closure_contracts) != set(cap_ids)
        or closure_sides != {-1, 1}
        or set(face_ids) != set(body_ids) | closure_member_ids
    ):
        raise StructureConfirmationError("structure_confirmation_invalid", "完整盒型封口提案不完整。")
    if front_id not in body_ids:
        raise StructureConfirmationError("structure_face_mapping_incomplete", "正面必须从四个盒身面中选择。")
    valid_anchors = net.get("valid_anchors")
    if isinstance(valid_anchors, list):
        allowed_turns = next(
            (
                item.get("quarter_turns")
                for item in valid_anchors
                if isinstance(item, Mapping) and item.get("front_face_id") == front_id
            ),
            None,
        )
        if not isinstance(allowed_turns, list) or turns not in allowed_turns:
            raise StructureConfirmationError("structure_confirmation_invalid", "这个正面方向未通过结构预检。")
    faces_by_id = {face["id"]: face for face in structure["faces"]}
    if any(face_id not in faces_by_id for face_id in face_ids):
        raise StructureConfirmationError("structure_confirmation_stale", "完整盒型引用的盒面已经失效。")
    first_center = _face_centroid(structure, faces_by_id[body_ids[0]])
    last_center = _face_centroid(structure, faces_by_id[body_ids[-1]])
    source_strip = (last_center[0] - first_center[0], last_center[1] - first_center[1])
    raw_basis = net.get("basis_transform")
    if isinstance(raw_basis, list) and len(raw_basis) == 6:
        basis_transform = [float(value) for value in raw_basis]
    else:
        # Backward compatibility for waiting-input records created before V2.1.
        basis_transform = list(faces_by_id[body_ids[0]]["artwork_transform"])
    proposal_strip = _linear_vector(basis_transform, source_strip)
    actual_strip_axis = "x" if abs(proposal_strip[0]) > abs(proposal_strip[1]) else "y"
    if net.get("strip_axis") not in {"x", "y"} or actual_strip_axis != net.get("strip_axis"):
        raise StructureConfirmationError("structure_confirmation_invalid", "完整盒型的盒身排列方向已经失效。")
    fold_neighbors = _selected_fold_neighbors(structure, faces_by_id, set(face_ids))
    if any(body_ids[index + 1] not in fold_neighbors[body_ids[index]] for index in range(3)):
        raise StructureConfirmationError("structure_fold_graph_invalid", "完整盒型的四个盒身面没有按折线连续连接。")

    front_face = faces_by_id[front_id]
    base_width, base_height = _mapped_size(structure, front_face)
    front_transform = _rotated_transform(
        list(front_face["artwork_transform"]),
        base_width,
        base_height,
        turns,
    )
    strip_vector = _linear_vector(
        front_transform,
        source_strip,
    )
    if abs(strip_vector[0]) <= abs(strip_vector[1]):
        raise StructureConfirmationError("artwork_transform_invalid", "正面朝向与盒身排列不一致，请旋转 90° 后重试。")
    step = 1 if strip_vector[0] > 0 else -1
    front_index = body_ids.index(front_id)
    role_ids = {
        role: body_ids[(front_index + step * offset) % 4]
        for role, offset in (("front", 0), ("right", 1), ("back", 2), ("left", 3))
    }

    body_centers = [_face_centroid(structure, faces_by_id[face_id]) for face_id in body_ids]
    body_center = (
        sum(point[0] for point in body_centers) / len(body_centers),
        sum(point[1] for point in body_centers) / len(body_centers),
    )
    cap_positions = []
    for face_id in cap_ids:
        center = _face_centroid(structure, faces_by_id[face_id])
        mapped = _linear_vector(front_transform, (center[0] - body_center[0], center[1] - body_center[1]))
        cap_positions.append((mapped[1], face_id))
    cap_positions.sort()
    if cap_positions[0][0] >= -0.1 or cap_positions[1][0] <= 0.1:
        raise StructureConfirmationError("structure_fold_graph_invalid", "顶部和底部没有位于盒身两侧。")
    role_ids["top"] = cap_positions[0][1]
    role_ids["bottom"] = cap_positions[1][1]

    width, height = _turned_size(structure, front_face, turns)
    right_face = faces_by_id[role_ids["right"]]
    right_turn = min(
        (
            candidate
            for candidate in range(4)
            if dimensions.close(_turned_size(structure, right_face, candidate)[1], height)
        ),
        key=lambda candidate: (_turn_distance(candidate, turns), candidate),
        default=-1,
    )
    if right_turn < 0:
        raise StructureConfirmationError("structure_face_dimensions_mismatch", "盒身高度无法形成一致的四个侧面。")
    depth = _turned_size(structure, right_face, right_turn)[0]
    provisional_sizes = {
        "front": (width, height),
        "back": (width, height),
        "left": (depth, height),
        "right": (depth, height),
    }
    face_turns = {"front": turns, "right": right_turn}
    for role in ("back", "left"):
        face_turns[role] = _turn_for_size(
            structure,
            faces_by_id[role_ids[role]],
            provisional_sizes[role],
            turns,
            dimensions,
        )
    solved_dimensions = solve_body_dimensions(
        {
            role: _turned_size(structure, faces_by_id[role_ids[role]], face_turns[role])
            for role in ("front", "right", "back", "left")
        },
        dimensions,
    )
    if solved_dimensions is None:
        raise StructureConfirmationError(
            "structure_face_dimensions_mismatch",
            "完整盒型的相对盒身面尺寸不一致。",
        )
    width = solved_dimensions["width"]
    depth = solved_dimensions["depth"]
    height = solved_dimensions["height"]
    expected_sizes = {
        "front": (width, height),
        "back": (width, height),
        "left": (depth, height),
        "right": (depth, height),
        "top": (width, depth),
        "bottom": (width, depth),
    }
    for role in ("front", "right", "back", "left"):
        actual = _turned_size(structure, faces_by_id[role_ids[role]], face_turns[role])
        if not all(dimensions.close(value, expected) for value, expected in zip(actual, expected_sizes[role])):
            raise StructureConfirmationError(
                "structure_face_dimensions_mismatch",
                "完整盒型的相对盒身面尺寸不一致。",
            )
    body_roles = {
        face_id: role
        for role, face_id in role_ids.items()
        if role in {"front", "right", "back", "left"}
    }
    normalized = [
        FaceDecision(
            face_id=role_ids[role],
            role=role,
            target_role=role,
            quarter_turns=face_turns[role],
            expected_size=expected_sizes[role],
        )
        for role in ("front", "right", "back", "left")
    ]
    normalized_closures: list[dict[str, Any]] = []
    for role in ("top", "bottom"):
        cap_id = role_ids[role]
        closure_contract = closure_contracts[cap_id]
        members: list[dict[str, Any]] = []
        for z_index, member in enumerate(closure_contract["members"]):
            member_id = str(member["face_id"])
            attached_id = _cap_body_neighbor(fold_neighbors, member_id, set(body_ids))
            if member["attached_body_face_id"] != attached_id:
                raise StructureConfirmationError("structure_confirmation_invalid", "完整盒型封口连接已经失效。")
            member_turn = _turn_for_cap(
                structure,
                faces_by_id[member_id],
                faces_by_id[attached_id],
                role=role,
                attached_role=body_roles[attached_id],
                expected_size=expected_sizes[role],
                dimensions=dimensions,
                assembly_member=closure_contract["closure_kind"] == "assembly",
            )
            normalized.append(
                FaceDecision(
                    face_id=member_id,
                    role=role if member_id == cap_id else "flap",
                    target_role=role,
                    quarter_turns=member_turn,
                    expected_size=expected_sizes[role],
                    closure_kind=str(closure_contract["closure_kind"]),
                    attached_body_face_id=attached_id,
                )
            )
            members.append(
                {
                    "face_id": member_id,
                    "attached_body_face_id": attached_id,
                    "coverage_ratio": float(member["coverage_ratio"]),
                    "z_index": z_index,
                }
            )
        normalized_closures.append(
            {
                "role": role,
                "primary_face_id": cap_id,
                "closure_kind": str(closure_contract["closure_kind"]),
                "coverage_ratio": float(closure_contract["coverage_ratio"]),
                "members": members,
            }
        )
    return normalized, normalized_closures


def _resolve_pouch_anchor(
    resolution: Mapping[str, Any],
    structure: Mapping[str, Any],
    anchor: Mapping[str, Any],
    net: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    front_id = str(anchor.get("front_face_id") or "")
    turns = anchor.get("quarter_turns", 0)
    if isinstance(turns, bool) or not isinstance(turns, int) or turns not in {0, 1, 2, 3}:
        raise StructureConfirmationError("artwork_transform_invalid", "正面方向只能旋转 0/90/180/270 度。")
    bound_hash = net.get("structure_hash")
    if not isinstance(bound_hash, str) or bound_hash != structure.get("structure_hash"):
        raise StructureConfirmationError("structure_confirmation_stale", "完整盒型与当前结构版本不一致，请重新识别。")
    body_ids = [str(value) for value in net.get("body_face_ids", [])]
    face_ids = [str(value) for value in net.get("face_ids", [])]
    if (
        len(body_ids) != 2
        or len(face_ids) != 2
        or set(body_ids) != set(face_ids)
        or front_id not in body_ids
    ):
        raise StructureConfirmationError("structure_confirmation_invalid", "膜袋正反面提案格式不对。")
    valid_anchors = net.get("valid_anchors")
    if isinstance(valid_anchors, list):
        allowed_turns = next(
            (
                item.get("quarter_turns")
                for item in valid_anchors
                if isinstance(item, Mapping) and str(item.get("front_face_id") or "") == front_id
            ),
            None,
        )
        if not isinstance(allowed_turns, list) or turns not in allowed_turns:
            raise StructureConfirmationError("structure_confirmation_invalid", "这个正面方向未通过结构预检。")
    faces_by_id = {face["id"]: face for face in structure["faces"]}
    back_id = next(face_id for face_id in body_ids if face_id != front_id)
    if front_id not in faces_by_id or back_id not in faces_by_id:
        raise StructureConfirmationError("structure_confirmation_stale", "膜袋引用的袋片已经失效。")
    approved = canonicalize_structure(structure)
    approved_faces = {face["id"]: face for face in approved["faces"]}
    front = approved_faces[front_id]
    back = approved_faces[back_id]
    width, height = _mapped_size(approved, front)
    front["artwork_transform"] = _rotated_transform(list(front["artwork_transform"]), width, height, turns)
    front["role"] = "front"
    back["role"] = "back"
    approved["faces"] = [front, back]
    approved["folds"] = []
    approved["root_face"] = front_id
    approved["packaging_family"] = "pouch"
    approved["validation"] = {"status": "accepted", "errors": [], "warnings": ["pouch_v1_thin_card"]}
    approved.pop("structure_hash", None)
    approved = canonicalize_structure(approved)
    resolved = resolve_structure_payload(approved)
    if resolved.status != "ready" or resolved.resolved is None:
        raise StructureConfirmationError(
            resolved.code or "structure_confirmation_invalid",
            resolved.message or "膜袋锚点不能形成受支持的袋片。",
        )
    return approved, resolved.resolved


def _resolve_anchor(
    resolution: Mapping[str, Any],
    structure: Mapping[str, Any],
    anchor: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Apply one anchor and require the final resolver to accept the result.

    Both proposal preflight and the persisted confirmation command use this
    exact path.  The preflight therefore cannot expose an option that later
    fails only after role assignment, dimension averaging, or cap alignment.
    """
    topology = resolution.get("topology")
    raw_nets = topology.get("net_proposals") if isinstance(topology, Mapping) else None
    proposal_id = str(anchor.get("proposal_id") or "")
    net = next(
        (
            item
            for item in (raw_nets or [])
            if isinstance(item, Mapping) and str(item.get("id") or "") == proposal_id
        ),
        None,
    )
    if isinstance(net, Mapping) and net.get("schema") == POUCH_NET_PROPOSAL_SCHEMA:
        return _resolve_pouch_anchor(resolution, structure, anchor, net)
    approved = canonicalize_structure(structure)
    faces_by_id = {face["id"]: face for face in approved["faces"]}
    normalized, closure_assemblies = _anchor_decisions(resolution, approved, anchor)
    roles_by_face_id = {decision.face_id: decision.role for decision in normalized}
    selected_face_ids = set(roles_by_face_id)
    body_face_ids = {
        decision.face_id
        for decision in normalized
        if decision.role in {"front", "right", "back", "left"}
    }
    approved.pop("structure_hash", None)
    for face in approved["faces"]:
        face["role"] = "unknown"
    closure_clearance = False
    closure_assembly = False
    for decision in normalized:
        face = faces_by_id[decision.face_id]
        width, height = _mapped_size(approved, face)
        transform = _rotated_transform(
            list(face["artwork_transform"]),
            width,
            height,
            decision.quarter_turns,
        )
        if decision.closure_kind is not None:
            actual_size = _turned_size(approved, face, decision.quarter_turns)
            policy = geometry_policy_for_source(approved.get("source")).dimensions
            fit = (
                fit_closure_member_dimensions(actual_size, decision.expected_size, policy)
                if decision.closure_kind == "assembly"
                else fit_closure_dimensions(actual_size, decision.expected_size, policy)
            )
            if fit is None:
                raise StructureConfirmationError(
                    "structure_face_dimensions_mismatch",
                    "盒盖成员尺寸与盒身宽深不一致，不能形成闭合盒。",
                )
            closure_clearance = closure_clearance or fit.kind == "clearance"
            closure_assembly = closure_assembly or decision.closure_kind == "assembly"
            attached_face_id = decision.attached_body_face_id
            if attached_face_id is None or attached_face_id not in body_face_ids:
                raise StructureConfirmationError("structure_confirmation_invalid", "完整盒型封口连接已经失效。")
            attached_role = roles_by_face_id[attached_face_id]
            transform = _align_closure_transform(
                approved,
                face,
                transform,
                decision.expected_size,
                CAP_OUTWARD_DIRECTIONS[decision.target_role][attached_role],
            )
        face["artwork_transform"] = transform
        face["role"] = decision.role
    approved["faces"] = [face for face in approved["faces"] if face["id"] in selected_face_ids]
    approved["folds"] = _selected_fold_records(
        approved,
        faces_by_id,
        selected_face_ids,
    )
    selected_edge_ids = {
        edge_id
        for face in approved["faces"]
        for edge_id in face["boundary"]
    }
    approved["edges"] = [edge for edge in approved["edges"] if edge["id"] in selected_edge_ids]
    selected_vertex_ids = {
        vertex_id
        for edge in approved["edges"]
        for vertex_id in (edge["start"], edge["end"])
    }
    approved["vertices"] = [
        vertex for vertex in approved["vertices"] if vertex["id"] in selected_vertex_ids
    ]
    approved["folds"] = [
        fold
        for fold in approved["folds"]
        if fold["edge"] in selected_edge_ids
        and fold["left_face"] in selected_face_ids
        and fold["right_face"] in selected_face_ids
    ]
    approved["root_face"] = next(decision.face_id for decision in normalized if decision.role == "front")
    approved["artwork_assemblies"] = {
        "schema": "packaging-artwork-assemblies/1",
        "closures": closure_assemblies,
    }
    warnings = []
    if closure_clearance:
        warnings.append("closure_clearance_masked")
    if closure_assembly:
        warnings.append("closure_assembly_composited")
    approved["validation"] = {
        "status": "accepted",
        "errors": [],
        "warnings": warnings,
    }
    approved = canonicalize_structure(approved)
    resolved = resolve_structure_payload(approved)
    if resolved.status != "ready" or resolved.resolved is None:
        raise StructureConfirmationError(
            resolved.code or "structure_confirmation_invalid",
            resolved.message or "完整盒型锚点不能形成受支持的闭合盒。",
        )
    return approved, resolved.resolved


def preflight_anchor_proposals(
    structure: Mapping[str, Any],
    proposals: list[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Expose only proposals that the exact confirmation engine can accept."""
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for raw in proposals:
        proposal = dict(raw)
        valid: list[dict[str, Any]] = []
        reasons: dict[str, int] = {}
        resolution = {"topology": {"net_proposals": [proposal]}}
        body_face_ids = [str(value) for value in proposal.get("body_face_ids", [])]
        for front_face_id in body_face_ids:
            turns: list[int] = []
            preferred_turn: int | None = None
            for quarter_turns in range(4):
                try:
                    approved, _resolved = _resolve_anchor(
                        resolution,
                        structure,
                        {
                            "proposal_id": proposal.get("id"),
                            "front_face_id": front_face_id,
                            "quarter_turns": quarter_turns,
                        },
                    )
                except StructureConfirmationError as error:
                    reasons[error.code] = reasons.get(error.code, 0) + 1
                else:
                    turns.append(quarter_turns)
                    # Hide CAD rotation from the operator while keeping a deterministic
                    # geometry choice: canonical body order advances to the physical right.
                    roles = {
                        str(face.get("role")): str(face.get("id"))
                        for face in approved.get("faces", [])
                        if isinstance(face, Mapping)
                    }
                    front_index = body_face_ids.index(front_face_id)
                    if (
                        len(body_face_ids) == 4
                        and roles.get("right") == body_face_ids[(front_index + 1) % 4]
                    ):
                        preferred_turn = quarter_turns
            if turns:
                valid.append({
                    "front_face_id": front_face_id,
                    "quarter_turns": turns,
                    "preferred_quarter_turns": preferred_turn if preferred_turn is not None else turns[0],
                })
        if valid:
            proposal["valid_anchors"] = valid
            accepted.append(proposal)
        else:
            rejected.append({"proposal_id": proposal.get("id"), "reasons": reasons})
    return accepted, rejected


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
    if not isinstance(decisions, Mapping) or not isinstance(decisions.get("anchor"), Mapping):
        raise StructureConfirmationError(
            "structure_confirmation_stale",
            "这单还是旧版逐面确认，请重新识别完整盒型。",
        )
    approved, resolved = _resolve_anchor(resolution, structure, decisions["anchor"])
    destination = Path(output_path).expanduser().resolve()
    _atomic_json(destination, approved)
    return {
        "ok": True,
        "sidecar": str(destination),
        "structure_hash": approved["structure_hash"],
        "dimensions_mm": resolved["dimensions_mm"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="确认 PackagingStructure V2 完整盒型锚点")
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
