"""Shared dimensional policy for PackagingStructure V2.

Exact semantic structure and Illustrator stroke proposals have different
measurement guarantees. Keep that distinction in one place so proposal,
human confirmation, and final resolution cannot accept and reject the same
carton with different tolerances.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any


STROKE_PROPOSAL_ADAPTER = "illustrator-stroke-proposal/1"
MEASUREMENT_DECIMALS = 3
# Regular slotted containers (FEFCO 0201 / RSC) commonly close with two
# opposing major flaps.  Each flap reaches roughly half of the opening; the
# physical closure is the union of both flaps, not either flap stretched to a
# full face.  Keep the member and assembled-footprint contracts separate.
MIN_CLOSURE_ASSEMBLY_MEMBER_RATIO = 0.45
MAX_CLOSURE_ASSEMBLY_MEMBER_RATIO = 0.55
MIN_CLOSURE_ASSEMBLY_UNION_RATIO = 0.94
MAX_CLOSURE_ASSEMBLY_MEMBER_SUM_RATIO = 1.02
# Coverage is a dimensionless public contract already serialized at six
# decimals.  It must not inherit the millimetre measurement precision: doing
# so can turn a physically valid 94.02% opposing-flap union into 93.9%.
COVERAGE_CONTRACT_DECIMALS = 6


def normalized_mm(value: float) -> float:
    """Remove sub-micron coordinate noise before dimensions cross a boundary."""
    result = round(float(value), MEASUREMENT_DECIMALS)
    return 0.0 if result == -0.0 else result


def conservative_coverage_ratio(value: float) -> float:
    """Publish a lower bound at the same precision as public geometry."""
    scale = 10**COVERAGE_CONTRACT_DECIMALS
    bounded = min(1.0, max(0.0, float(value)))
    return math.floor(bounded * scale + 1e-9) / scale


@dataclass(frozen=True)
class DimensionPolicy:
    absolute_mm: float
    relative: float

    def close(self, left: float, right: float) -> bool:
        return abs(left - right) <= max(
            self.absolute_mm,
            max(abs(left), abs(right)) * self.relative,
        )


@dataclass(frozen=True)
class GeometryPolicy:
    """One adapter-owned policy for proposal geometry and final dimensions."""

    boundary_mm: float | None
    dimensions: DimensionPolicy


@dataclass(frozen=True)
class ClosureDimensionFit:
    """Describe how one source closure covers the erected top/bottom face."""

    kind: str
    coverage_ratio: float

    @property
    def padded(self) -> bool:
        return self.kind != "full"


STRICT_GEOMETRY = GeometryPolicy(
    boundary_mm=None,
    dimensions=DimensionPolicy(absolute_mm=0.1, relative=0.001),
)
# Illustrator dielines commonly contain duplicated cut/crease strokes or flap
# clearance in the 0.5-1.5 mm range. This policy is intentionally restricted
# to the human-confirmed stroke proposal adapter.
STROKE_PROPOSAL_GEOMETRY = GeometryPolicy(
    boundary_mm=1.5,
    dimensions=DimensionPolicy(absolute_mm=1.5, relative=0.03),
)


def is_stroke_proposal_source(source: Mapping[str, Any] | None) -> bool:
    return bool(source and source.get("adapter") == STROKE_PROPOSAL_ADAPTER)


def geometry_policy_for_source(source: Mapping[str, Any] | None) -> GeometryPolicy:
    return STROKE_PROPOSAL_GEOMETRY if is_stroke_proposal_source(source) else STRICT_GEOMETRY


def fit_closure_dimensions(
    actual: Sequence[float],
    expected: Sequence[float],
    policy: DimensionPolicy,
) -> ClosureDimensionFit | None:
    """Classify one closure that independently covers an erected box face."""
    if len(actual) != 2 or len(expected) != 2:
        return None
    actual_values = [normalized_mm(value) for value in actual]
    expected_values = [normalized_mm(value) for value in expected]
    if any(value <= 0 for value in (*actual_values, *expected_values)):
        return None

    close = [
        policy.close(actual_value, expected_value)
        for actual_value, expected_value in zip(actual_values, expected_values)
    ]
    ratios = [
        min(1.0, actual_value / expected_value)
        for actual_value, expected_value in zip(actual_values, expected_values)
    ]
    if all(close):
        coverage_ratio = round(ratios[0] * ratios[1], COVERAGE_CONTRACT_DECIMALS)
        covers_footprint = all(
            actual_value >= expected_value
            for actual_value, expected_value in zip(actual_values, expected_values)
        )
        return ClosureDimensionFit(
            kind="full" if covers_footprint else "clearance",
            coverage_ratio=coverage_ratio,
        )
    return None


def fit_closure_member_dimensions(
    actual: Sequence[float],
    expected: Sequence[float],
    policy: DimensionPolicy,
) -> ClosureDimensionFit | None:
    """Classify one member of a symmetric opposing-flap closure.

    This deliberately does not accept the member as a complete closure.  The
    caller must still prove that members attach to opposite body panels and
    that their clipped union covers the erected footprint.
    """
    if len(actual) != 2 or len(expected) != 2:
        return None
    actual_values = [normalized_mm(value) for value in actual]
    expected_values = [normalized_mm(value) for value in expected]
    if any(value <= 0 for value in (*actual_values, *expected_values)):
        return None
    close = [
        policy.close(actual_value, expected_value)
        for actual_value, expected_value in zip(actual_values, expected_values)
    ]
    if sum(close) != 1:
        return None
    reach_index = 0 if not close[0] else 1
    fold_index = 1 - reach_index
    if actual_values[reach_index] >= expected_values[reach_index]:
        return None
    if (
        actual_values[fold_index] > expected_values[fold_index]
        and not policy.close(actual_values[fold_index], expected_values[fold_index])
    ):
        return None
    reach_ratio = actual_values[reach_index] / expected_values[reach_index]
    fold_ratio = min(1.0, actual_values[fold_index] / expected_values[fold_index])
    ratio = reach_ratio * fold_ratio
    if not (
        MIN_CLOSURE_ASSEMBLY_MEMBER_RATIO
        <= ratio
        <= MAX_CLOSURE_ASSEMBLY_MEMBER_RATIO
    ):
        return None
    return ClosureDimensionFit(kind="assembly", coverage_ratio=round(ratio, 6))


def rectangular_coverage_ratio(
    bounds: Sequence[Sequence[float]],
    footprint: Sequence[float],
) -> float:
    """Return the clipped union area of axis-aligned layers over a footprint."""
    if len(footprint) != 2:
        return 0.0
    width, height = (float(value) for value in footprint)
    if width <= 0 or height <= 0:
        return 0.0
    clipped: list[tuple[float, float, float, float]] = []
    for raw in bounds:
        if len(raw) != 4:
            continue
        left, top, right, bottom = (float(value) for value in raw)
        left, top = max(0.0, left), max(0.0, top)
        right, bottom = min(width, right), min(height, bottom)
        if right > left and bottom > top:
            clipped.append((left, top, right, bottom))
    if not clipped:
        return 0.0
    x_values = sorted({0.0, width, *(value for item in clipped for value in (item[0], item[2]))})
    union_area = 0.0
    for x0, x1 in zip(x_values, x_values[1:]):
        if x1 <= x0:
            continue
        intervals = sorted(
            (top, bottom)
            for left, top, right, bottom in clipped
            if left < x1 and right > x0
        )
        covered_y = 0.0
        current_top: float | None = None
        current_bottom: float | None = None
        for top, bottom in intervals:
            if current_top is None:
                current_top, current_bottom = top, bottom
            elif top <= float(current_bottom):
                current_bottom = max(float(current_bottom), bottom)
            else:
                covered_y += float(current_bottom) - current_top
                current_top, current_bottom = top, bottom
        if current_top is not None:
            covered_y += float(current_bottom) - current_top
        union_area += (x1 - x0) * covered_y
    return round(min(1.0, union_area / (width * height)), 6)


def solve_body_dimensions(
    face_sizes: Mapping[str, Sequence[float]],
    policy: DimensionPolicy,
) -> dict[str, float] | None:
    """Solve one physical box size from four oriented body panels.

    Proposal grouping, human-anchor confirmation, and the final resolver all
    call this function.  Keeping the opposite-face averages here prevents a
    proposal from advertising one size while the approved GLB uses another.
    """
    if set(face_sizes) != {"front", "right", "back", "left"}:
        return None
    if any(len(face_sizes[role]) != 2 for role in ("front", "right", "back", "left")):
        return None
    groups = {
        "width": [normalized_mm(face_sizes["front"][0]), normalized_mm(face_sizes["back"][0])],
        "depth": [normalized_mm(face_sizes["left"][0]), normalized_mm(face_sizes["right"][0])],
        "height": [normalized_mm(face_sizes[role][1]) for role in ("front", "right", "back", "left")],
    }
    dimensions: dict[str, float] = {}
    for name, values in groups.items():
        anchor = values[0]
        if not all(policy.close(anchor, value) for value in values[1:]):
            return None
        dimensions[name] = normalized_mm(sum(values) / len(values))
    return dimensions
