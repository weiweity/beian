"""Shared dimensional policy for PackagingStructure V2.

Exact semantic structure and Illustrator stroke proposals have different
measurement guarantees. Keep that distinction in one place so proposal,
human confirmation, and final resolution cannot accept and reject the same
carton with different tolerances.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any


STROKE_PROPOSAL_ADAPTER = "illustrator-stroke-proposal/1"
MEASUREMENT_DECIMALS = 3
MIN_ASSEMBLED_CLOSURE_RATIO = 0.60


def normalized_mm(value: float) -> float:
    """Remove sub-micron coordinate noise before dimensions cross a boundary."""
    result = round(float(value), MEASUREMENT_DECIMALS)
    return 0.0 if result == -0.0 else result


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
    *,
    allow_assembled: bool = False,
) -> ClosureDimensionFit | None:
    """Classify a main closure without stretching it into a full box face.

    Exact and normal-clearance panels remain the default. A shorter main flap
    is accepted only when its fold dimension matches, its perpendicular reach
    covers at least 60% of the erected face, and the caller has independently
    proved that other flaps form the same closure assembly.
    """
    if len(actual) != 2 or len(expected) != 2:
        return None
    actual_values = [float(value) for value in actual]
    expected_values = [float(value) for value in expected]
    if any(value <= 0 for value in (*actual_values, *expected_values)):
        return None

    close = [
        policy.close(actual_value, expected_value)
        for actual_value, expected_value in zip(actual_values, expected_values)
    ]
    ratios = [
        actual_value / expected_value
        for actual_value, expected_value in zip(actual_values, expected_values)
    ]
    if all(close):
        exact = all(
            normalized_mm(actual_value) == normalized_mm(expected_value)
            for actual_value, expected_value in zip(actual_values, expected_values)
        )
        return ClosureDimensionFit(
            kind="full" if exact else "clearance",
            coverage_ratio=round(min(1.0, min(ratios)), 6),
        )
    if not allow_assembled or sum(close) != 1:
        return None

    partial_index = 0 if not close[0] else 1
    actual_partial = actual_values[partial_index]
    expected_partial = expected_values[partial_index]
    ratio = actual_partial / expected_partial
    if actual_partial >= expected_partial or ratio < MIN_ASSEMBLED_CLOSURE_RATIO:
        return None
    # A dimensional tolerance may describe a small overshoot on the fold axis,
    # but a real closure assembly cannot extend materially past its footprint.
    matched_index = 1 - partial_index
    if (
        actual_values[matched_index] > expected_values[matched_index]
        and not policy.close(actual_values[matched_index], expected_values[matched_index])
    ):
        return None
    return ClosureDimensionFit(kind="assembly", coverage_ratio=round(ratio, 6))


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
        "width": [float(face_sizes["front"][0]), float(face_sizes["back"][0])],
        "depth": [float(face_sizes["left"][0]), float(face_sizes["right"][0])],
        "height": [float(face_sizes[role][1]) for role in ("front", "right", "back", "left")],
    }
    dimensions: dict[str, float] = {}
    for name, values in groups.items():
        anchor = values[0]
        if not all(policy.close(anchor, value) for value in values[1:]):
            return None
        dimensions[name] = normalized_mm(sum(values) / len(values))
    return dimensions
