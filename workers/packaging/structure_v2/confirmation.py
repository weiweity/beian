"""Apply an explicit human face-role decision to a V2 structure proposal."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Mapping

from .adapters import sha256_file
from .dimensions import (
    DimensionPolicy,
    geometry_policy_for_source,
    normalized_mm,
    solve_body_dimensions,
)
from .model import canonicalize_structure
from .resolver import BOX_ROLES, resolve_structure_payload


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
    boundaries = {
        face_id: set(faces_by_id[face_id]["boundary"])
        for face_id in selected_ids
    }
    neighbors = {face_id: set() for face_id in selected_ids}
    for fold in structure["folds"]:
        left = str(fold["left_face"])
        right = str(fold["right_face"])
        if left not in selected_ids or right not in selected_ids:
            continue
        edge = str(fold["edge"])
        if edge not in boundaries[left] or edge not in boundaries[right]:
            raise StructureConfirmationError("structure_fold_graph_invalid", "折线没有同时属于相邻盒面。")
        neighbors[left].add(right)
        neighbors[right].add(left)
    return neighbors


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
        if all(dimensions.close(value, expected) for value, expected in zip(actual, expected_size)):
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

    A normal manufacturing clearance leaves a narrow uncovered strip on the
    erected footprint.  Keep the fold edge fixed, center the perpendicular
    allowance, and let the renderer pad only the uncovered area with white.
    Short dust/tuck flaps never reach this function because proposal and
    confirmation use the same dimensional policy.
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
) -> list[tuple[str, str, int, tuple[float, float]]]:
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
    if bound_hash is not None and bound_hash != structure.get("structure_hash"):
        raise StructureConfirmationError("structure_confirmation_stale", "完整盒型与当前结构版本不一致，请重新识别。")
    body_ids = [str(value) for value in net.get("body_face_ids", [])]
    cap_ids = [str(value) for value in net.get("cap_face_ids", [])]
    face_ids = [str(value) for value in net.get("face_ids", [])]
    if len(body_ids) != 4 or len(cap_ids) != 2 or len(set(face_ids)) != 6 or set(face_ids) != set(body_ids + cap_ids):
        raise StructureConfirmationError("structure_confirmation_invalid", "完整盒型提案格式不对。")
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
    for role in ("top", "bottom"):
        cap_id = role_ids[role]
        attached_id = _cap_body_neighbor(fold_neighbors, cap_id, set(body_ids))
        face_turns[role] = _turn_for_cap(
            structure,
            faces_by_id[cap_id],
            faces_by_id[attached_id],
            role=role,
            attached_role=body_roles[attached_id],
            expected_size=expected_sizes[role],
            dimensions=dimensions,
        )
    normalized = []
    for role in ("front", "right", "back", "left", "top", "bottom"):
        face_id = role_ids[role]
        normalized.append((face_id, role, face_turns[role], expected_sizes[role]))
    return normalized


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
    approved = canonicalize_structure(structure)
    faces_by_id = {face["id"]: face for face in approved["faces"]}
    normalized = _anchor_decisions(resolution, approved, anchor)
    roles_by_face_id = {face_id: role for face_id, role, _turns, _expected in normalized}
    selected_face_ids = set(roles_by_face_id)
    selected_neighbors = _selected_fold_neighbors(approved, faces_by_id, selected_face_ids)
    body_face_ids = {
        face_id
        for face_id, role in roles_by_face_id.items()
        if role in {"front", "right", "back", "left"}
    }
    approved.pop("structure_hash", None)
    for face in approved["faces"]:
        face["role"] = "unknown"
    closure_padded = False
    for face_id, role, turns, expected_size in normalized:
        face = faces_by_id[face_id]
        width, height = _mapped_size(approved, face)
        transform = _rotated_transform(
            list(face["artwork_transform"]),
            width,
            height,
            turns,
        )
        if role in {"top", "bottom"}:
            actual_size = _turned_size(approved, face, turns)
            policy = geometry_policy_for_source(approved.get("source")).dimensions
            if not all(policy.close(actual, expected) for actual, expected in zip(actual_size, expected_size)):
                raise StructureConfirmationError(
                    "structure_face_dimensions_mismatch",
                    "盒盖主面尺寸与盒身宽深不一致，不能形成闭合盒。",
                )
            closure_padded = closure_padded or any(
                normalized_mm(actual) != normalized_mm(expected)
                for actual, expected in zip(actual_size, expected_size)
            )
            attached_face_id = _cap_body_neighbor(selected_neighbors, face_id, body_face_ids)
            attached_role = roles_by_face_id[attached_face_id]
            transform = _align_closure_transform(
                approved,
                face,
                transform,
                expected_size,
                CAP_OUTWARD_DIRECTIONS[role][attached_role],
            )
        face["artwork_transform"] = transform
        face["role"] = role
    approved["faces"] = [face for face in approved["faces"] if face["id"] in selected_face_ids]
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
    approved["root_face"] = next(
        face_id for face_id, role, _turns, _expected in normalized if role == "front"
    )
    approved["validation"] = {
        "status": "accepted",
        "errors": [],
        "warnings": ["closure_clearance_padded"] if closure_padded else [],
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
        for front_face_id in [str(value) for value in proposal.get("body_face_ids", [])]:
            turns: list[int] = []
            for quarter_turns in range(4):
                try:
                    _resolve_anchor(
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
            if turns:
                valid.append({"front_face_id": front_face_id, "quarter_turns": turns})
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
