"""Find confirmable rectangular-carton nets inside untrusted face candidates.

The input rectangles are still only geometry.  This module does not assign
cut/crease semantics or accept a structure. It groups four alternating body
panels plus two opposite closure assemblies so the UI can ask for one
front-face anchor instead of exposing every nested or partial rectangle.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
import hashlib
from itertools import combinations
import json
from typing import Any

from .dimensions import (
    DimensionPolicy,
    GeometryPolicy,
    MAX_CLOSURE_ASSEMBLY_MEMBER_SUM_RATIO,
    MIN_CLOSURE_ASSEMBLY_UNION_RATIO,
    STROKE_PROPOSAL_GEOMETRY,
    conservative_coverage_ratio,
    fit_closure_dimensions,
    fit_closure_member_dimensions,
    rectangular_coverage_ratio,
    solve_body_dimensions,
)


MAX_BOX_NET_PROPOSALS = 24
MAX_BOX_NET_SEARCH_STATES = 4096
BOX_NET_PROPOSAL_SCHEMA = "box-net-proposal/3"


class BoxNetProposalLimitError(RuntimeError):
    pass


def _boundary_close(left: float, right: float, tolerance: float) -> bool:
    return abs(left - right) <= tolerance


def _bounds(candidate: Mapping[str, Any]) -> tuple[float, float, float, float]:
    raw = candidate["local_bounds"]
    return tuple(float(value) for value in raw)  # type: ignore[return-value]


def _open_sides(candidate: Mapping[str, Any]) -> tuple[int, ...]:
    raw = candidate.get("open_sides", [])
    if not isinstance(raw, list):
        return ()
    values = sorted(
        {
            int(value)
            for value in raw
            if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 3
        }
    )
    return tuple(values)


def _outer_side_index(axis: str, side: int) -> int:
    # Candidate side order is top, right, bottom, left.
    if axis == "x":
        return 0 if side < 0 else 2
    return 3 if side < 0 else 1


def _along_size(candidate: Mapping[str, Any], axis: str) -> float:
    size = candidate.get("size_mm")
    if (
        isinstance(size, list)
        and len(size) == 2
        and all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in size)
    ):
        return float(size[0 if axis == "x" else 1])
    left, top, right, bottom = _bounds(candidate)
    return right - left if axis == "x" else bottom - top


def _cross_size(candidate: Mapping[str, Any], axis: str) -> float:
    size = candidate.get("size_mm")
    if (
        isinstance(size, list)
        and len(size) == 2
        and all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in size)
    ):
        return float(size[1 if axis == "x" else 0])
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
    # Three-sided rectification is reserved for closure flaps.  Letting one of
    # those candidates into the body strip would manufacture a side wall that
    # is not bounded by source linework.
    ordered = sorted(
        (candidate for candidate in candidates if not _open_sides(candidate)),
        key=lambda item: (_bounds(item)[0 if axis == "x" else 1], str(item["id"])),
    )
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


def _closure_options(
    candidates: Sequence[Mapping[str, Any]],
    body_path: Sequence[Mapping[str, Any]],
    axis: str,
    tolerance: float,
    dimensions: DimensionPolicy,
    solved_dimensions: Mapping[str, float],
) -> dict[int, list[dict[str, Any]]]:
    body_ids = {str(item["id"]) for item in body_path}
    first = float(solved_dimensions["width"])
    second = float(solved_dimensions["depth"])
    attached_candidates: dict[int, list[dict[str, Any]]] = {-1: [], 1: []}
    for candidate in candidates:
        if str(candidate["id"]) in body_ids:
            continue
        for body_index, body in enumerate(body_path):
            side = _cap_side(candidate, body, axis, tolerance)
            if side is None:
                continue
            along = _along_size(candidate, axis)
            cross = _cross_size(candidate, axis)
            expected_attached = first if body_index in (0, 2) else second
            expected_cross = second if body_index in (0, 2) else first
            open_sides = _open_sides(candidate)
            if (
                not dimensions.close(along, expected_attached)
                or expected_cross <= 0
                or (open_sides and open_sides != (_outer_side_index(axis, side),))
            ):
                continue
            attached_candidates[side].append(
                {
                    "face": candidate,
                    "body_index": body_index,
                    "attached_body_face_id": str(body["id"]),
                    "attached_along": expected_attached,
                    "along": along,
                    "cross": cross,
                    "expected_cross": expected_cross,
                }
            )
            break

    options: dict[int, list[dict[str, Any]]] = {-1: [], 1: []}
    for side in options:
        records = attached_candidates[side]
        single_options: list[dict[str, Any]] = []
        for item in records:
            cross = float(item["cross"])
            expected_cross = float(item["expected_cross"])
            fit = fit_closure_dimensions(
                (_along_size(item["face"], axis), cross),
                (float(item["attached_along"]), expected_cross),
                dimensions,
            )
            if fit is None:
                continue
            contract_ratio = conservative_coverage_ratio(fit.coverage_ratio)
            member = {
                "face": item["face"],
                "face_id": str(item["face"]["id"]),
                "attached_body_face_id": str(item["attached_body_face_id"]),
                "coverage_ratio": contract_ratio,
                "extent": "full" if not fit.padded else "partial",
            }
            single_options.append(
                {
                    "primary_face": item["face"],
                    "primary_face_id": str(item["face"]["id"]),
                    "members": [member],
                    "coverage_ratio": contract_ratio,
                    "extent": "full" if not fit.padded else "partial",
                    "closure_kind": fit.kind,
                }
            )

        assembly_options: list[dict[str, Any]] = []
        for left, right in combinations(records, 2):
            left_index = int(left["body_index"])
            right_index = int(right["body_index"])
            if (left_index - right_index) % 4 != 2:
                continue
            member_items: list[tuple[dict[str, Any], Any]] = []
            for item in (left, right):
                fit = fit_closure_member_dimensions(
                    (_along_size(item["face"], axis), float(item["cross"])),
                    (float(item["attached_along"]), float(item["expected_cross"])),
                    dimensions,
                )
                if fit is None:
                    break
                member_items.append((item, fit))
            if len(member_items) != 2:
                continue
            member_ratio_sum = sum(float(fit.coverage_ratio) for _item, fit in member_items)
            if not (
                MIN_CLOSURE_ASSEMBLY_UNION_RATIO
                <= member_ratio_sum
                <= MAX_CLOSURE_ASSEMBLY_MEMBER_SUM_RATIO
            ):
                # A material overlap needs an explicit stacking-order decision;
                # do not manufacture one from Illustrator enumeration order.
                continue
            coverage_bounds: list[list[float]] = []
            for item, _fit in member_items:
                body_index = int(item["body_index"])
                reach = min(float(item["cross"]), float(item["expected_cross"]))
                fold_extent = min(float(item["along"]), float(item["attached_along"]))
                if body_index in (0, 2):
                    left_edge = (first - fold_extent) / 2.0
                    top = 0.0 if body_index == 0 else second - reach
                    coverage_bounds.append([left_edge, top, left_edge + fold_extent, top + reach])
                else:
                    top = (second - fold_extent) / 2.0
                    left_edge = 0.0 if body_index == 1 else first - reach
                    coverage_bounds.append([left_edge, top, left_edge + reach, top + fold_extent])
            union_ratio = rectangular_coverage_ratio(coverage_bounds, (first, second))
            if union_ratio < MIN_CLOSURE_ASSEMBLY_UNION_RATIO:
                continue
            members = sorted(
                (
                    {
                        "face": item["face"],
                        "face_id": str(item["face"]["id"]),
                        "attached_body_face_id": str(item["attached_body_face_id"]),
                        "coverage_ratio": conservative_coverage_ratio(fit.coverage_ratio),
                        "extent": "partial",
                    }
                    for item, fit in member_items
                ),
                key=lambda member: str(member["face_id"]),
            )
            # Equal-area members use lexical order so proposal identities stay
            # stable across Illustrator enumeration order.
            largest_area = max(
                _along_size(member["face"], axis) * _cross_size(member["face"], axis)
                for member in members
            )
            primary = min(
                (
                    member
                    for member in members
                    if abs(
                        _along_size(member["face"], axis) * _cross_size(member["face"], axis)
                        - largest_area
                    ) <= 1e-6
                ),
                key=lambda member: str(member["face_id"]),
            )
            contract_union_ratio = min(
                conservative_coverage_ratio(union_ratio),
                sum(float(member["coverage_ratio"]) for member in members),
            )
            # The proposal is a public confirmation contract, not a raw
            # geometry diagnostic.  Conservative quantization can move a
            # borderline raw fit below the minimum that confirmation and the
            # final resolver enforce.  Never publish an option that the shared
            # acceptance path is guaranteed to reject.
            if contract_union_ratio < MIN_CLOSURE_ASSEMBLY_UNION_RATIO:
                continue
            assembly_options.append(
                {
                    "primary_face": primary["face"],
                    "primary_face_id": str(primary["face_id"]),
                    "members": members,
                    "coverage_ratio": contract_union_ratio,
                    "extent": "full" if contract_union_ratio == 1.0 else "partial",
                    "closure_kind": "assembly",
                }
            )

        # If source linework contains a fully bounded main cap, do not expose
        # a larger three-sided frame built from crossing annotation lines.  The
        # open-frame path exists only for real multi-flap closure assemblies.
        closed_full = [
            option
            for option in single_options
            if not _open_sides(option["primary_face"])
        ]
        options[side] = closed_full if closed_full else assembly_options
        options[side].sort(
            key=lambda item: (
                -float(item["coverage_ratio"]),
                -sum(
                    _along_size(member["face"], axis) * _cross_size(member["face"], axis)
                    for member in item["members"]
                ),
                str(item["primary_face_id"]),
            )
        )
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


def _stable_proposal_id(
    *,
    binding_seed: str,
    axis: str,
    body_path: Sequence[Mapping[str, Any]],
    closures: Sequence[Mapping[str, Any]],
    basis_transform: Sequence[float],
) -> str:
    material = {
        "proposal_schema": BOX_NET_PROPOSAL_SCHEMA,
        "binding_seed": binding_seed,
        "axis": axis,
        "basis_transform": [round(float(value), 9) for value in basis_transform],
        "body_bounds": [[round(value, 6) for value in _bounds(item)] for item in body_path],
        "closure_bounds": [
            [
                [round(value, 6) for value in _bounds(member["face"])]
                for member in closure["members"]
            ]
            for closure in closures
        ],
    }
    encoded = json.dumps(material, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "box-net-" + hashlib.sha256(encoded).hexdigest()[:16]


def derive_box_net_proposals(
    candidates: Sequence[Mapping[str, Any]],
    *,
    policy: GeometryPolicy = STROKE_PROPOSAL_GEOMETRY,
    binding_seed: str = "geometry-only",
    basis_transform: Sequence[float] = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0),
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
            body_along = [_along_size(item, axis) for item in body_path]
            body_cross = [_cross_size(item, axis) for item in body_path]
            solved_dimensions = solve_body_dimensions(
                {
                    "front": (body_along[0], body_cross[0]),
                    "right": (body_along[1], body_cross[1]),
                    "back": (body_along[2], body_cross[2]),
                    "left": (body_along[3], body_cross[3]),
                },
                dimensions,
            )
            if solved_dimensions is None:
                continue
            closures = _closure_options(
                unique_candidates,
                body_path,
                axis,
                tolerance_mm,
                dimensions,
                solved_dimensions,
            )
            for negative in closures[-1]:
                for positive in closures[1]:
                    negative_face = negative["primary_face"]
                    positive_face = positive["primary_face"]
                    face_items = [
                        *body_path,
                        *(member["face"] for member in negative["members"]),
                        *(member["face"] for member in positive["members"]),
                    ]
                    face_ids = tuple(sorted(str(item["id"]) for item in face_items))
                    if len(set(face_ids)) < 6:
                        continue
                    area = sum(_along_size(item, axis) * _cross_size(item, axis) for item in face_items)
                    candidate = {
                        "schema": BOX_NET_PROPOSAL_SCHEMA,
                        "id": _stable_proposal_id(
                            binding_seed=binding_seed,
                            axis=axis,
                            body_path=body_path,
                            closures=(negative, positive),
                            basis_transform=basis_transform,
                        ),
                        "face_ids": list(face_ids),
                        "body_face_ids": [str(item["id"]) for item in body_path],
                        "cap_face_ids": [str(negative_face["id"]), str(positive_face["id"])],
                        "closure_assemblies": [
                            {
                                "primary_face_id": str(option["primary_face_id"]),
                                "side": side,
                                "extent": str(option["extent"]),
                                "closure_kind": str(option["closure_kind"]),
                                "coverage_ratio": float(option["coverage_ratio"]),
                                "members": [
                                    {
                                        "face_id": str(member["face_id"]),
                                        "attached_body_face_id": str(member["attached_body_face_id"]),
                                        "coverage_ratio": float(member["coverage_ratio"]),
                                        "extent": str(member["extent"]),
                                    }
                                    for member in option["members"]
                                ],
                            }
                            for side, option in ((-1, negative), (1, positive))
                        ],
                        "strip_axis": axis,
                        "basis_transform": [round(float(value), 9) for value in basis_transform],
                        "dimensions_mm": solved_dimensions,
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
    for proposal in ordered:
        proposal.pop("_rank", None)
    return ordered
