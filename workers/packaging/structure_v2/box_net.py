"""Find complete rectangular-carton nets inside untrusted face candidates.

The input rectangles are still only geometry.  This module does not assign
cut/crease semantics or accept a structure.  It groups four alternating body
panels plus two opposite caps so the UI can ask for one front-face anchor
instead of exposing every nested or partial rectangle.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .dimensions import DimensionPolicy, GeometryPolicy, STROKE_PROPOSAL_GEOMETRY


MAX_BOX_NET_PROPOSALS = 24
MAX_BOX_NET_SEARCH_STATES = 4096


class BoxNetProposalLimitError(RuntimeError):
    pass


def _boundary_close(left: float, right: float, tolerance: float) -> bool:
    return abs(left - right) <= tolerance


def _bounds(candidate: Mapping[str, Any]) -> tuple[float, float, float, float]:
    raw = candidate["local_bounds"]
    return tuple(float(value) for value in raw)  # type: ignore[return-value]


def _along_size(candidate: Mapping[str, Any], axis: str) -> float:
    left, top, right, bottom = _bounds(candidate)
    return right - left if axis == "x" else bottom - top


def _cross_size(candidate: Mapping[str, Any], axis: str) -> float:
    left, top, right, bottom = _bounds(candidate)
    return bottom - top if axis == "x" else right - left


def _same_cross_span(left: Mapping[str, Any], right: Mapping[str, Any], axis: str, tolerance: float) -> bool:
    a = _bounds(left)
    b = _bounds(right)
    if axis == "x":
        return _boundary_close(a[1], b[1], tolerance) and _boundary_close(a[3], b[3], tolerance)
    return _boundary_close(a[0], b[0], tolerance) and _boundary_close(a[2], b[2], tolerance)


def _follows(left: Mapping[str, Any], right: Mapping[str, Any], axis: str, tolerance: float) -> bool:
    a = _bounds(left)
    b = _bounds(right)
    boundary_matches = (
        _boundary_close(a[2], b[0], tolerance)
        if axis == "x"
        else _boundary_close(a[3], b[1], tolerance)
    )
    return boundary_matches and _same_cross_span(left, right, axis, tolerance)


def _body_paths(
    candidates: Sequence[Mapping[str, Any]],
    axis: str,
    tolerance: float,
    dimensions: DimensionPolicy,
    search_state: list[int],
) -> list[list[Mapping[str, Any]]]:
    ordered = sorted(candidates, key=lambda item: (_bounds(item)[0 if axis == "x" else 1], str(item["id"])))
    followers = {
        str(candidate["id"]): [other for other in ordered if _follows(candidate, other, axis, tolerance)]
        for candidate in ordered
    }
    paths: list[list[Mapping[str, Any]]] = []

    def visit(path: list[Mapping[str, Any]]) -> None:
        search_state[0] += 1
        if search_state[0] > MAX_BOX_NET_SEARCH_STATES:
            raise BoxNetProposalLimitError(
                f"完整盒型搜索超过上限：{MAX_BOX_NET_SEARCH_STATES}"
            )
        if len(path) == 4:
            along = [_along_size(item, axis) for item in path]
            cross = [_cross_size(item, axis) for item in path]
            if (
                all(dimensions.close(cross[0], value) for value in cross[1:])
                and dimensions.close(along[0], along[2])
                and dimensions.close(along[1], along[3])
            ):
                paths.append(path)
            return
        for candidate in followers[str(path[-1]["id"])]:
            if candidate not in path:
                visit([*path, candidate])

    for candidate in ordered:
        visit([candidate])
    return paths


def _cap_side(
    cap: Mapping[str, Any],
    body: Mapping[str, Any],
    axis: str,
    tolerance: float,
) -> int | None:
    cap_bounds = _bounds(cap)
    body_bounds = _bounds(body)
    if axis == "x":
        if not (
            _boundary_close(cap_bounds[0], body_bounds[0], tolerance)
            and _boundary_close(cap_bounds[2], body_bounds[2], tolerance)
        ):
            return None
        if _boundary_close(cap_bounds[3], body_bounds[1], tolerance):
            return -1
        if _boundary_close(cap_bounds[1], body_bounds[3], tolerance):
            return 1
        return None
    if not (
        _boundary_close(cap_bounds[1], body_bounds[1], tolerance)
        and _boundary_close(cap_bounds[3], body_bounds[3], tolerance)
    ):
        return None
    if _boundary_close(cap_bounds[2], body_bounds[0], tolerance):
        return -1
    if _boundary_close(cap_bounds[0], body_bounds[2], tolerance):
        return 1
    return None


def _cap_options(
    candidates: Sequence[Mapping[str, Any]],
    body_path: Sequence[Mapping[str, Any]],
    axis: str,
    tolerance: float,
    dimensions: DimensionPolicy,
) -> dict[int, list[Mapping[str, Any]]]:
    body_ids = {str(item["id"]) for item in body_path}
    body_along = [_along_size(item, axis) for item in body_path]
    first, second = body_along[0], body_along[1]
    options: dict[int, list[Mapping[str, Any]]] = {-1: [], 1: []}
    for candidate in candidates:
        if str(candidate["id"]) in body_ids:
            continue
        for body in body_path:
            side = _cap_side(candidate, body, axis, tolerance)
            if side is None:
                continue
            along = _along_size(candidate, axis)
            cross = _cross_size(candidate, axis)
            attached = _along_size(body, axis)
            expected_cross = second if dimensions.close(attached, first) else first
            if dimensions.close(along, attached) and dimensions.close(cross, expected_cross):
                options[side].append(candidate)
                break
    for side in options:
        options[side].sort(key=lambda item: (-_along_size(item, axis) * _cross_size(item, axis), str(item["id"])))
    return options


def _proposal_bounds(faces: Sequence[Mapping[str, Any]]) -> list[float]:
    bounds = [_bounds(face) for face in faces]
    return [
        round(min(item[0] for item in bounds), 6),
        round(min(item[1] for item in bounds), 6),
        round(max(item[2] for item in bounds), 6),
        round(max(item[3] for item in bounds), 6),
    ]


def _deduplicated_candidates(
    candidates: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    unique: dict[tuple[float, float, float, float], Mapping[str, Any]] = {}
    for candidate in sorted(candidates, key=lambda item: str(item["id"])):
        key = tuple(round(value, 6) for value in _bounds(candidate))
        unique.setdefault(key, candidate)
    return list(unique.values())


def derive_box_net_proposals(
    candidates: Sequence[Mapping[str, Any]],
    *,
    policy: GeometryPolicy = STROKE_PROPOSAL_GEOMETRY,
) -> list[dict[str, Any]]:
    """Return bounded whole-net proposals; never return raw rectangle guesses."""
    if policy.boundary_mm is None:
        raise ValueError("box-net proposal policy requires a boundary tolerance")
    tolerance_mm = policy.boundary_mm
    dimensions = policy.dimensions
    unique_candidates = _deduplicated_candidates(candidates)
    proposals: dict[tuple[str, ...], dict[str, Any]] = {}
    search_state = [0]
    for axis in ("x", "y"):
        for body_path in _body_paths(
            unique_candidates,
            axis,
            tolerance_mm,
            dimensions,
            search_state,
        ):
            caps = _cap_options(unique_candidates, body_path, axis, tolerance_mm, dimensions)
            for negative in caps[-1]:
                for positive in caps[1]:
                    face_items = [*body_path, negative, positive]
                    face_ids = tuple(sorted(str(item["id"]) for item in face_items))
                    if len(set(face_ids)) != 6:
                        continue
                    area = sum(_along_size(item, axis) * _cross_size(item, axis) for item in face_items)
                    candidate = {
                        "face_ids": list(face_ids),
                        "body_face_ids": [str(item["id"]) for item in body_path],
                        "cap_face_ids": [str(negative["id"]), str(positive["id"])],
                        "strip_axis": axis,
                        "bounds_mm": _proposal_bounds(face_items),
                        "_rank": round(area, 6),
                    }
                    existing = proposals.get(face_ids)
                    if existing is None or candidate["_rank"] > existing["_rank"]:
                        proposals[face_ids] = candidate
                    if len(proposals) > MAX_BOX_NET_PROPOSALS:
                        raise BoxNetProposalLimitError(
                            f"完整盒型方案超过上限：{len(proposals)}"
                        )
    ordered = sorted(
        proposals.values(),
        key=lambda item: (-float(item["_rank"]), tuple(item["face_ids"])),
    )
    for index, proposal in enumerate(ordered, start=1):
        proposal["id"] = f"box-net-{index:04d}"
        proposal.pop("_rank", None)
    return ordered
