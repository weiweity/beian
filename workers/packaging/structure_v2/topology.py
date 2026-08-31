"""Topology diagnostics for semantic packaging linework.

GEOS performs snapping, noding, line merging, and polygonization.  The code
around it only preserves packaging assignments and converts diagnostics into
stable product error codes; it never guesses cut/crease semantics.
"""

from __future__ import annotations

from collections import defaultdict
import hashlib
import json
import math
from typing import Any, Iterable, Mapping

try:
    from shapely import STRtree, line_merge, polygonize_full, snap, unary_union
    from shapely.geometry import GeometryCollection, LineString, MultiLineString, MultiPoint, Point, Polygon
except ImportError as error:  # pragma: no cover - exercised by deployment probe
    raise RuntimeError("packaging_dependency_missing: 缺少 Shapely/GEOS") from error

from .model import canonicalize_structure
from .box_net import BoxNetProposalLimitError, derive_box_net_proposals
from .dimensions import STROKE_PROPOSAL_GEOMETRY


LINEWORK_ASSIGNMENTS = ("cut", "crease", "perforation")
DEFAULT_LIMITS = {"linework_edges": 20_000, "components": 4_096, "faces": 10_000}
PROPOSAL_COMPONENT_REVIEW_THRESHOLD = 100
MAX_PROPOSAL_CANDIDATE_COMPONENTS = 64
MAX_PROPOSAL_SPATIAL_LINKS = 100_000
MAX_PROPOSAL_WORK = 50_000


class TopologyError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: Mapping[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": str(self), "details": self.details}


def _extract_lines(geometry: Any) -> list[LineString]:
    if geometry is None or geometry.is_empty:
        return []
    if isinstance(geometry, LineString):
        return [geometry]
    if isinstance(geometry, (MultiLineString, GeometryCollection)):
        result: list[LineString] = []
        for child in geometry.geoms:
            result.extend(_extract_lines(child))
        return result
    return []


def _collection_items(geometry: Any) -> list[Any]:
    if geometry is None or geometry.is_empty:
        return []
    return list(geometry.geoms) if hasattr(geometry, "geoms") else [geometry]


class _DisjointSet:
    def __init__(self, size: int):
        self.parents = list(range(size))

    def find(self, item: int) -> int:
        parent = self.parents[item]
        while parent != self.parents[parent]:
            self.parents[parent] = self.parents[self.parents[parent]]
            parent = self.parents[parent]
        while item != parent:
            next_item = self.parents[item]
            self.parents[item] = parent
            item = next_item
        return parent

    def union(self, left: int, right: int) -> None:
        a, b = self.find(left), self.find(right)
        if a != b:
            self.parents[max(a, b)] = min(a, b)


def _cluster_representatives(lines: list[LineString], tolerance: float) -> list[tuple[float, float]]:
    coordinates = [tuple(line.coords[0]) for line in lines] + [tuple(line.coords[-1]) for line in lines]
    if not coordinates:
        return []
    points = [Point(coordinate) for coordinate in coordinates]
    groups = _DisjointSet(len(points))
    if tolerance > 0:
        tree = STRtree(points)
        for index, point in enumerate(points):
            for candidate in tree.query(point, predicate="dwithin", distance=tolerance):
                groups.union(index, int(candidate))
    members: dict[int, list[tuple[float, float]]] = defaultdict(list)
    for index, coordinate in enumerate(coordinates):
        members[groups.find(index)].append((float(coordinate[0]), float(coordinate[1])))
    # Lexicographic representatives make the same source deterministic across runs.
    return [min(values) for _, values in sorted(members.items())]


def _snap_same_assignment(lines: list[LineString], tolerance: float) -> list[LineString]:
    if not lines or tolerance <= 0:
        return lines
    representatives = _cluster_representatives(lines, tolerance)
    if not representatives:
        return lines
    snapped = snap(MultiLineString([list(line.coords) for line in lines]), MultiPoint(representatives), tolerance)
    return _extract_lines(snapped)


def _connected_components(lines: list[LineString]) -> int:
    if not lines:
        return 0
    endpoints: dict[tuple[float, float], int] = {}
    groups = _DisjointSet(len(lines))
    for index, line in enumerate(lines):
        for raw in (line.coords[0], line.coords[-1]):
            key = (round(float(raw[0]), 9), round(float(raw[1]), 9))
            previous = endpoints.setdefault(key, index)
            groups.union(index, previous)
    return len({groups.find(index) for index in range(len(lines))})


def _component_sort_key(lines: list[LineString]) -> tuple[float, float, float, float, float]:
    bounds = [line.bounds for line in lines]
    return (
        -sum(float(line.length) for line in lines),
        min(float(item[0]) for item in bounds),
        min(float(item[1]) for item in bounds),
        max(float(item[2]) for item in bounds),
        max(float(item[3]) for item in bounds),
    )


def _partition_line_components(lines: list[LineString]) -> list[list[LineString]]:
    """Partition already-noded linework by shared coordinates."""
    if not lines:
        return []
    coordinates: dict[tuple[float, float], int] = {}
    groups = _DisjointSet(len(lines))
    for index, line in enumerate(lines):
        for raw in line.coords:
            key = (round(float(raw[0]), 9), round(float(raw[1]), 9))
            previous = coordinates.setdefault(key, index)
            groups.union(index, previous)
    members: dict[int, list[LineString]] = defaultdict(list)
    for index, line in enumerate(lines):
        members[groups.find(index)].append(line)
    return sorted(members.values(), key=_component_sort_key)


def _partition_spatial_line_components(
    lines: list[LineString],
    tolerance: float,
) -> list[list[LineString]]:
    """Partition raw strokes before any global noding or polygonization.

    Annotation boxes and reference diagrams are common in Illustrator files.
    A global GEOS union lets thousands of unrelated marks consume the topology
    budget before the real carton is considered.  STRtree only links strokes
    that touch or lie within the adapter tolerance; each resulting component is
    then snapped and noded independently.
    """
    if not lines:
        return []
    groups = _DisjointSet(len(lines))
    tree = STRtree(lines)
    links = 0
    for index, line in enumerate(lines):
        for candidate in tree.query(line, predicate="dwithin", distance=tolerance):
            other = int(candidate)
            if other <= index:
                continue
            links += 1
            if links > MAX_PROPOSAL_SPATIAL_LINKS:
                raise TopologyError(
                    "structure_limit_exceeded",
                    "结构线邻接关系超过候选扫描预算",
                    details={"links": links, "limit": MAX_PROPOSAL_SPATIAL_LINKS},
                )
            groups.union(index, other)
    members: dict[int, list[LineString]] = defaultdict(list)
    for index, line in enumerate(lines):
        members[groups.find(index)].append(line)
    return sorted(members.values(), key=_component_sort_key)


def _diagnostic(geometry: Any) -> dict[str, Any]:
    items = _collection_items(geometry)
    return {
        "count": len(items),
        "total_length_mm": round(sum(float(getattr(item, "length", 0.0)) for item in items), 6),
        "bounds_mm": [
            [round(float(value), 6) for value in item.bounds]
            for item in items[:20]
        ],
    }


def _rectangle_metrics(polygon: Any) -> dict[str, Any] | None:
    # GEOS simplify removes harmless collinear boundary points while preserving
    # a rotated rectangle; direct edge checks avoid axis-aligned bbox guesses.
    coordinates = list(polygon.simplify(1e-9, preserve_topology=True).exterior.coords)
    if len(coordinates) != 5:
        return None
    ordered_lengths = [
        math.hypot(
            float(coordinates[index + 1][0]) - float(coordinates[index][0]),
            float(coordinates[index + 1][1]) - float(coordinates[index][1]),
        )
        for index in range(4)
    ]
    if any(length <= 0 for length in ordered_lengths):
        return None
    right_angle_error = 0.0
    for index in range(4):
        before = coordinates[(index - 1) % 4]
        current = coordinates[index]
        after = coordinates[(index + 1) % 4]
        left_vector = (float(before[0]) - float(current[0]), float(before[1]) - float(current[1]))
        right_vector = (float(after[0]) - float(current[0]), float(after[1]) - float(current[1]))
        denominator = math.hypot(*left_vector) * math.hypot(*right_vector)
        right_angle_error = max(
            right_angle_error,
            abs(left_vector[0] * right_vector[0] + left_vector[1] * right_vector[1]) / denominator,
        )
    opposite_error = max(
        abs(ordered_lengths[0] - ordered_lengths[2]),
        abs(ordered_lengths[1] - ordered_lengths[3]),
    )
    first = (ordered_lengths[0] + ordered_lengths[2]) / 2.0
    second = (ordered_lengths[1] + ordered_lengths[3]) / 2.0
    short, long = sorted((first, second))
    if short <= 0 or long <= 0:
        return None
    area_ratio = float(polygon.area) / (short * long)
    return {
        "size_mm": [round(short, 6), round(long, 6)],
        "area_mm2": round(float(polygon.area), 6),
        "minimum_rectangle_area_ratio": round(area_ratio, 9),
        "opposite_edge_error_mm": round(opposite_error, 6),
        "right_angle_cosine_error": round(right_angle_error, 9),
        "bounds_mm": [round(float(value), 6) for value in polygon.bounds],
    }


def analyze_declared_faces(
    payload: Mapping[str, Any],
    *,
    face_ids: set[str] | None = None,
) -> dict[str, Any]:
    """Validate each declared face boundary and return rectangular metrics."""
    structure = canonicalize_structure(payload)
    vertices = {item["id"]: (float(item["x"]), float(item["y"])) for item in structure["vertices"]}
    edges = {item["id"]: item for item in structure["edges"]}
    metrics: dict[str, dict[str, Any]] = {}
    errors: list[dict[str, Any]] = []
    for face in structure["faces"]:
        if face_ids is not None and face["id"] not in face_ids:
            continue
        lines = [
            LineString([vertices[edges[edge]["start"]], vertices[edges[edge]["end"]]])
            for edge in face["boundary"]
        ]
        noded = unary_union(lines)
        merged = line_merge(noded)
        polygons, cuts, dangles, invalids = polygonize_full(_extract_lines(merged))
        polygon_items = _collection_items(polygons)
        diagnostics = {
            "cut_edges": _diagnostic(cuts),
            "dangles": _diagnostic(dangles),
            "invalid_rings": _diagnostic(invalids),
        }
        if (
            len(polygon_items) != 1
            or diagnostics["cut_edges"]["count"]
            or diagnostics["dangles"]["count"]
            or diagnostics["invalid_rings"]["count"]
        ):
            errors.append(
                {
                    "code": "structure_face_mapping_incomplete",
                    "face": face["id"],
                    "diagnostics": diagnostics,
                }
            )
            continue
        rectangle = _rectangle_metrics(polygon_items[0])
        if (
            rectangle is None
            or rectangle["minimum_rectangle_area_ratio"] < 0.999
            or rectangle["right_angle_cosine_error"] > 0.001
        ):
            errors.append(
                {
                    "code": "structure_face_not_rectangular",
                    "face": face["id"],
                    "metrics": rectangle,
                }
            )
            continue
        metrics[face["id"]] = rectangle
    return {"status": "accepted" if not errors else "review_required", "faces": metrics, "errors": errors}


def _segment_key(left: tuple[float, float], right: tuple[float, float]) -> tuple[tuple[float, float], tuple[float, float]]:
    a = (round(float(left[0]), 6), round(float(left[1]), 6))
    b = (round(float(right[0]), 6), round(float(right[1]), 6))
    return tuple(sorted((a, b)))  # type: ignore[return-value]


def _segment_assignment(
    segment: LineString,
    assignment_geometries: Mapping[str, Any],
    tolerance: float,
) -> str | None:
    threshold = max(1e-7, min(float(segment.length) * 1e-5, max(tolerance, 1e-6)))
    matches: list[str] = []
    for assignment, geometry in assignment_geometries.items():
        if geometry is None or geometry.is_empty:
            continue
        overlap = float(segment.intersection(geometry.buffer(threshold, cap_style=2)).length)
        if overlap >= float(segment.length) - threshold:
            matches.append(assignment)
    return matches[0] if len(matches) == 1 else None


def _segment_source_refs(
    segment: LineString,
    records: list[tuple[LineString, list[str]]],
    tree: Any,
    tolerance: float,
) -> list[str]:
    if not records:
        return []
    threshold = max(1e-7, min(float(segment.length) * 1e-5, max(tolerance, 1e-6)))
    search = segment.buffer(threshold, cap_style=2)
    refs: set[str] = set()
    for raw_index in tree.query(search, predicate="intersects"):
        line, source_refs = records[int(raw_index)]
        overlap = float(segment.intersection(line.buffer(threshold, cap_style=2)).length)
        if overlap >= float(segment.length) - threshold:
            refs.update(source_refs)
    return sorted(refs)[:100]


def _face_transform(polygon: Any) -> tuple[list[float], list[float]] | None:
    rectangle = _rectangle_metrics(polygon)
    if rectangle is None:
        return None
    coordinates = list(polygon.simplify(1e-9, preserve_topology=True).exterior.coords)[:-1]
    if len(coordinates) != 4:
        return None
    start_index = min(range(4), key=lambda index: (round(float(coordinates[index][1]), 9), round(float(coordinates[index][0]), 9)))
    start = coordinates[start_index]
    before = coordinates[(start_index - 1) % 4]
    after = coordinates[(start_index + 1) % 4]
    candidates = [before, after]
    # In artboard top-left coordinates, prefer the neighbor pointing right as
    # local X.  This is deterministic; the confirmation step may rotate it.
    candidates.sort(
        key=lambda point: (
            float(point[0]) - float(start[0]),
            -(float(point[1]) - float(start[1])),
        ),
        reverse=True,
    )
    x_point, y_point = candidates
    x_vector = (float(x_point[0]) - float(start[0]), float(x_point[1]) - float(start[1]))
    y_vector = (float(y_point[0]) - float(start[0]), float(y_point[1]) - float(start[1]))
    x_length = math.hypot(*x_vector)
    y_length = math.hypot(*y_vector)
    if x_length <= 0 or y_length <= 0:
        return None
    ux = (x_vector[0] / x_length, x_vector[1] / x_length)
    uy = (y_vector[0] / y_length, y_vector[1] / y_length)
    if ux[0] * uy[1] - ux[1] * uy[0] < 0:
        ux, uy = uy, ux
        x_length, y_length = y_length, x_length
    transform = [
        round(ux[0], 9),
        round(uy[0], 9),
        round(ux[1], 9),
        round(uy[1], 9),
        round(-(ux[0] * float(start[0]) + ux[1] * float(start[1])), 6),
        round(-(uy[0] * float(start[0]) + uy[1] * float(start[1])), 6),
    ]
    return transform, [round(x_length, 6), round(y_length, 6)]


def _dominant_orthogonal_angle(lines: list[LineString]) -> float:
    """Return the dominant carton-grid angle, modulo 90 degrees.

    Old Illustrator dielines frequently contain duplicate cut/crease strokes
    and separate reference diagrams.  Their useful panel edges still share an
    orthogonal basis.  A fourth-angle mean lets horizontal and vertical edges
    vote for the same basis without assuming that the net is axis-aligned.
    """
    cosine = 0.0
    sine = 0.0
    for line in lines:
        coordinates = list(line.coords)
        if len(coordinates) < 2 or line.length <= 1e-9:
            continue
        left, right = coordinates[0], coordinates[-1]
        angle = math.atan2(float(right[1]) - float(left[1]), float(right[0]) - float(left[0]))
        cosine += float(line.length) * math.cos(4.0 * angle)
        sine += float(line.length) * math.sin(4.0 * angle)
    if abs(cosine) + abs(sine) <= 1e-9:
        return 0.0
    return math.atan2(sine, cosine) / 4.0


def _rotate_coordinate(point: tuple[float, float], angle: float) -> tuple[float, float]:
    cosine = math.cos(angle)
    sine = math.sin(angle)
    x, y = point
    return (cosine * x - sine * y, sine * x + cosine * y)


def _cluster_axis_coordinates(
    values: list[tuple[float, float]],
    tolerance: float,
) -> list[float]:
    if not values:
        return []
    groups: list[list[tuple[float, float]]] = []
    for value, weight in sorted(values):
        if not groups or value - groups[-1][-1][0] > tolerance:
            groups.append([(value, weight)])
        else:
            groups[-1].append((value, weight))
    result: list[float] = []
    for group in groups:
        total = sum(max(weight, 1e-9) for _value, weight in group)
        result.append(sum(value * max(weight, 1e-9) for value, weight in group) / total)
    return result


def _basis_transform(angle: float) -> list[float]:
    cosine = math.cos(angle)
    sine = math.sin(angle)
    # Affine convention: x'=a*x+c*y+e, y'=b*x+d*y+f.
    return [
        round(cosine, 9),
        round(-sine, 9),
        round(sine, 9),
        round(cosine, 9),
        0.0,
        0.0,
    ]


def _candidate_identity(source_hash: str, points: list[tuple[float, float]]) -> str:
    material = {
        "source_sha256": source_hash,
        "points_mm": sorted(
            [[round(float(x), 6), round(float(y), 6)] for x, y in points]
        ),
    }
    encoded = json.dumps(material, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "rect-face-" + hashlib.sha256(encoded).hexdigest()[:16]


def _rectangular_candidates_for_component(
    lines: list[LineString],
    *,
    source_hash: str,
    tolerance: float,
    work_state: list[int],
) -> tuple[list[dict[str, Any]], list[float]]:
    basis_angle = _dominant_orthogonal_angle(lines)
    local_lines = [
        LineString([_rotate_coordinate(tuple(point), -basis_angle) for point in line.coords])
        for line in lines
    ]
    minimum_axis_length = 5.0
    angular_error = math.sin(math.radians(3.0))
    horizontal: list[LineString] = []
    vertical: list[LineString] = []
    for line in local_lines:
        left, right = list(line.coords)[0], list(line.coords)[-1]
        dx = float(right[0]) - float(left[0])
        dy = float(right[1]) - float(left[1])
        length = math.hypot(dx, dy)
        if length < minimum_axis_length:
            continue
        if abs(dy) <= length * angular_error:
            horizontal.append(line)
        elif abs(dx) <= length * angular_error:
            vertical.append(line)
    x_values = _cluster_axis_coordinates(
        [((float(line.coords[0][0]) + float(line.coords[-1][0])) / 2.0, float(line.length)) for line in vertical],
        tolerance,
    )
    y_values = _cluster_axis_coordinates(
        [((float(line.coords[0][1]) + float(line.coords[-1][1])) / 2.0, float(line.length)) for line in horizontal],
        tolerance,
    )
    if len(x_values) > 40 or len(y_values) > 40:
        raise TopologyError(
            "structure_limit_exceeded",
            "结构组件坐标轴超过候选扫描预算",
            details={"x_axes": len(x_values), "y_axes": len(y_values), "limit": 40},
        )
    if len(x_values) < 2 or len(y_values) < 2:
        return [], _basis_transform(basis_angle)

    maximum_axis_gap = 12

    def pair_count(size: int) -> int:
        return sum(min(maximum_axis_gap, size - index - 1) for index in range(size - 1))

    estimated_work = pair_count(len(x_values)) * pair_count(len(y_values))
    if work_state[0] + estimated_work > MAX_PROPOSAL_WORK:
        raise TopologyError(
            "structure_limit_exceeded",
            "结构候选计算超过全局工作预算",
            details={
                "work": work_state[0],
                "estimated_component_work": estimated_work,
                "limit": MAX_PROPOSAL_WORK,
            },
        )

    covered = unary_union(local_lines).buffer(tolerance, cap_style=2)
    coverage_cache: dict[tuple[float, float, float, float], float] = {}

    def coverage(left: tuple[float, float], right: tuple[float, float]) -> float:
        key = tuple(round(value, 6) for value in (*left, *right))
        cached = coverage_cache.get(key)
        if cached is not None:
            return cached
        line = LineString([left, right])
        ratio = min(1.0, float(line.intersection(covered).length) / max(float(line.length), 1e-9))
        coverage_cache[key] = ratio
        return ratio

    candidates: list[dict[str, Any]] = []
    for x_index, x1 in enumerate(x_values):
        for x2 in x_values[x_index + 1 : x_index + 1 + maximum_axis_gap]:
            width = x2 - x1
            if width < 5.0:
                continue
            for y_index, y1 in enumerate(y_values):
                for y2 in y_values[y_index + 1 : y_index + 1 + maximum_axis_gap]:
                    work_state[0] += 1
                    if work_state[0] > MAX_PROPOSAL_WORK:
                        raise TopologyError(
                            "structure_limit_exceeded",
                            "结构候选计算超过全局工作预算",
                            details={"work": work_state[0], "limit": MAX_PROPOSAL_WORK},
                        )
                    height = y2 - y1
                    if height < 5.0 or max(width, height) / min(width, height) > 20.0:
                        continue
                    sides = [
                        coverage((x1, y1), (x2, y1)),
                        coverage((x2, y1), (x2, y2)),
                        coverage((x2, y2), (x1, y2)),
                        coverage((x1, y2), (x1, y1)),
                    ]
                    # A finished body panel may contain dimension or annotation
                    # strokes.  Those internal strokes do not split the physical
                    # panel, so candidate identity is determined by its outer
                    # frame only.  A closure flap may also have a curved or
                    # notched free edge; retain that three-sided frame as an
                    # auditable closure candidate, but mark the missing side so
                    # box_net can never use it as one of the four body panels.
                    strong_sides = [index for index, value in enumerate(sides) if value >= 0.88]
                    open_sides = [index for index, value in enumerate(sides) if value < 0.52]
                    if len(strong_sides) < 3 or len(open_sides) > 1:
                        continue
                    local_points = [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]
                    points = [_rotate_coordinate(point, basis_angle) for point in local_points]
                    polygon = Polygon(points)
                    frame = _face_transform(polygon)
                    if frame is None:
                        continue
                    candidates.append(
                        {
                            "id": _candidate_identity(source_hash, points),
                            "local_bounds": (x1, y1, x2, y2),
                            "points": points,
                            "polygon": polygon,
                            "transform": frame[0],
                            "size_mm": [round(width, 6), round(height, 6)],
                            "coverage": [round(value, 6) for value in sides],
                            "open_sides": open_sides,
                        }
                    )
    candidates.sort(key=lambda item: tuple(round(float(value), 9) for value in item["local_bounds"]))
    return candidates, _basis_transform(basis_angle)


def derive_rectangular_face_proposal(
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    """Build human-selectable finished-face rectangles from legacy strokes.

    This is deliberately a proposal adapter, not an automatic dieline parser.
    It rectifies the *finished panel area* (including non-rectangular closing
    flaps), groups only complete dimensionally coherent six-face nets, and
    drops nested or unrelated rectangles before presenting the result.  No
    result from this function can be accepted without ``confirm_structure``.
    """
    structure = canonicalize_structure(payload)
    vertices = {item["id"]: (float(item["x"]), float(item["y"])) for item in structure["vertices"]}
    source_lines = [
        LineString([vertices[edge["start"]], vertices[edge["end"]]])
        for edge in structure["edges"]
        if edge["assignment"] in LINEWORK_ASSIGNMENTS
    ]
    source_lines = [line for line in source_lines if line.length >= 1e-6]
    if not source_lines:
        raise TopologyError("structure_semantics_missing", "结构线没有形成可确认的盒面候选")

    tolerance = STROKE_PROPOSAL_GEOMETRY.boundary_mm
    if tolerance is None:
        raise TopologyError("structure_contract_invalid", "旧刀线候选缺少边界容差策略")
    # Partition before GEOS noding.  Thousands of detached annotation marks
    # must not force a global union/polygonization or hide a valid carton.
    source_components = _partition_spatial_line_components(source_lines, tolerance)
    components: list[list[LineString]] = []
    ignored_open_components = 0
    for source_component in source_components:
        if len(source_component) < 4:
            ignored_open_components += 1
            continue
        # Illustrator commonly exports the same finished edge more than once
        # (appearance stroke, dieline stroke, or a nearly coincident duplicate).
        # Normalize only inside one spatial component before GEOS nodes it.
        normalized = _snap_same_assignment(source_component, tolerance)
        for noded_component in _partition_line_components(_extract_lines(unary_union(normalized))):
            if len(noded_component) < 4:
                ignored_open_components += 1
                continue
            components.append(noded_component)
    candidates_by_id: dict[str, dict[str, Any]] = {}
    net_proposals: list[dict[str, Any]] = []
    work_state = [0]
    candidate_components = 0
    for component_index, component_lines in enumerate(components, start=1):
        if len(component_lines) < 4:
            continue
        component_candidates, basis_transform = _rectangular_candidates_for_component(
            component_lines,
            source_hash=structure["source"]["sha256"],
            tolerance=tolerance,
            work_state=work_state,
        )
        if len(component_candidates) < 6:
            continue
        candidate_components += 1
        if candidate_components > MAX_PROPOSAL_CANDIDATE_COMPONENTS:
            raise TopologyError(
                "structure_limit_exceeded",
                "可成盒结构组件超过人工确认预算",
                details={
                    "count": candidate_components,
                    "limit": MAX_PROPOSAL_CANDIDATE_COMPONENTS,
                },
            )
        try:
            component_proposals = derive_box_net_proposals(
                component_candidates,
                policy=STROKE_PROPOSAL_GEOMETRY,
                binding_seed=f'{structure["source"]["sha256"]}:component:{component_index}',
                basis_transform=basis_transform,
            )
        except BoxNetProposalLimitError as error:
            raise TopologyError(
                "structure_limit_exceeded",
                "完整盒型方案过多，不能安全交给人工确认",
                details={"component": component_index, "cause": str(error)},
            ) from error
        if not component_proposals:
            continue
        for candidate in component_candidates:
            candidates_by_id[str(candidate["id"])] = candidate
        net_proposals.extend(component_proposals)
        if len(net_proposals) > 24:
            raise TopologyError(
                "structure_limit_exceeded",
                "完整盒型方案超过人工确认上限",
                details={"count": len(net_proposals), "limit": 24},
            )
    if not net_proposals:
        raise TopologyError(
            "structure_box_net_missing",
            "候选线没有形成尺寸自洽、可确认的闭合盒型",
        )
    net_proposals.sort(
        key=lambda item: (
            -float(item["dimensions_mm"]["width"] * item["dimensions_mm"]["depth"] * item["dimensions_mm"]["height"]),
            str(item["id"]),
        )
    )
    exposed_ids = {
        face_id
        for proposal in net_proposals
        for face_id in proposal["face_ids"]
    }
    candidates = sorted(
        (candidate for face_id, candidate in candidates_by_id.items() if face_id in exposed_ids),
        key=lambda item: str(item["id"]),
    )

    point_keys = sorted(
        {
            (round(float(point[0]), 6), round(float(point[1]), 6))
            for candidate in candidates
            for point in candidate["points"]
        }
    )
    vertex_ids = {point: f"rv-{index:04d}" for index, point in enumerate(point_keys, start=1)}
    segment_keys = sorted(
        {
            _segment_key(tuple(points[index]), tuple(points[(index + 1) % 4]))
            for candidate in candidates
            for points in [candidate["points"]]
            for index in range(4)
        }
    )
    edge_ids = {key: f"re-{index:04d}" for index, key in enumerate(segment_keys, start=1)}
    face_payload: list[dict[str, Any]] = []
    preview: list[dict[str, Any]] = []
    edge_faces: dict[str, list[str]] = defaultdict(list)
    for candidate in candidates:
        identity = str(candidate["id"])
        points = candidate["points"]
        boundary = [
            edge_ids[_segment_key(tuple(points[item]), tuple(points[(item + 1) % 4]))]
            for item in range(4)
        ]
        face_payload.append(
            {
                "id": identity,
                "boundary": boundary,
                "role": "unknown",
                "artwork_transform": candidate["transform"],
            }
        )
        for edge_id in boundary:
            edge_faces[edge_id].append(identity)
        polygon = candidate["polygon"]
        preview.append(
            {
                "id": identity,
                "bounds_mm": [round(float(value), 6) for value in polygon.bounds],
                "centroid_mm": [round(float(polygon.centroid.x), 6), round(float(polygon.centroid.y), 6)],
                "area_mm2": round(float(polygon.area), 6),
                "rectangular": True,
                "size_mm": candidate["size_mm"],
                "points_mm": [[round(float(x), 6), round(float(y), 6)] for x, y in points],
                "boundary_coverage": candidate["coverage"],
            }
        )
    edge_payload = [
        {
            "id": edge_ids[key],
            "start": vertex_ids[key[0]],
            "end": vertex_ids[key[1]],
            "assignment": "crease",
            "source_refs": ["illustrator-stroke-proposal:grid"],
        }
        for key in segment_keys
    ]
    folds = [
        {
            "edge": edge_id,
            "left_face": faces[0],
            "right_face": faces[1],
            "angle_deg": 90.0,
        }
        for edge_id, faces in sorted(edge_faces.items())
        if len(faces) == 2
    ]
    proposal = {
        "schema": structure["schema"],
        "units": "mm",
        "source": structure["source"],
        "vertices": [
            {"id": vertex_ids[point], "x": point[0], "y": point[1]}
            for point in point_keys
        ],
        "edges": edge_payload,
        "faces": face_payload,
        "folds": folds,
        "root_face": None,
        "validation": {
            "status": "review_required",
            "errors": ["structure_face_mapping_incomplete"],
            "warnings": ["legacy_stroke_proposal_requires_human_confirmation"],
        },
    }
    normalized_proposal = canonicalize_structure(proposal)
    for net in net_proposals:
        net["structure_hash"] = normalized_proposal["structure_hash"]
    return {
        "structure": normalized_proposal,
        "faces": preview,
        "net_proposals": net_proposals,
        "topology_counts": {
            "linework_edges": len(source_lines),
            "faces": len(candidates),
            "components": len(source_components),
        },
        "proposal_diagnostics": {
            "errors": [
                *(["structure_open_boundary"] if ignored_open_components else []),
                *(["structure_multiple_components"] if len(source_components) > 1 else []),
            ],
            "warnings": (
                ["structure_many_components_partitioned"]
                if len(source_components) > PROPOSAL_COMPONENT_REVIEW_THRESHOLD
                else []
            ),
            "diagnostics": {
                "ignored_open_components": ignored_open_components,
            },
            "components_seen": len(source_components),
            "components_noded": len(components),
            "candidate_components": candidate_components,
            "work_units": work_state[0],
        },
    }


def derive_face_proposal(
    payload: Mapping[str, Any],
    *,
    snap_tolerance_mm: float = 0.1,
    allow_partial: bool = False,
) -> dict[str, Any]:
    """Derive planar faces for diagnostics without assigning box roles.

    This is the compatibility path for explicit semantic input that lacks face
    declarations.  Its raw polygons are never a product-level confirmation
    contract: the UI may only offer proposals that also contain a validated
    complete box net.  Legacy callers can still submit six explicit roles, and
    the strict resolver remains the final acceptance gate.
    """
    structure = canonicalize_structure(payload)
    topology = analyze_topology(structure, snap_tolerance_mm=snap_tolerance_mm)
    if topology["status"] != "accepted" and not allow_partial:
        raise TopologyError(
            topology["errors"][0] if topology["errors"] else "structure_face_mapping_incomplete",
            "结构线尚不能形成闭合面提案",
            details={"topology": topology},
        )
    if not topology.get("faces"):
        raise TopologyError(
            topology["errors"][0] if topology.get("errors") else "structure_face_mapping_incomplete",
            "结构线没有形成可确认的闭合面",
            details={"topology": topology},
        )
    vertices = {item["id"]: (float(item["x"]), float(item["y"])) for item in structure["vertices"]}
    source_lines: dict[str, list[LineString]] = defaultdict(list)
    source_records: dict[str, list[tuple[LineString, list[str]]]] = defaultdict(list)
    for edge in structure["edges"]:
        if edge["assignment"] not in LINEWORK_ASSIGNMENTS:
            continue
        line = LineString([vertices[edge["start"]], vertices[edge["end"]]])
        source_lines[edge["assignment"]].append(line)
        source_records[edge["assignment"]].append((line, list(edge.get("source_refs") or [])))
    snapped = {
        assignment: _snap_same_assignment(lines, snap_tolerance_mm)
        for assignment, lines in source_lines.items()
    }
    assignment_geometries = {
        assignment: unary_union(lines) if lines else GeometryCollection()
        for assignment, lines in snapped.items()
    }
    source_trees = {
        assignment: STRtree([record[0] for record in records])
        for assignment, records in source_records.items()
        if records
    }
    noded = unary_union([line for lines in snapped.values() for line in lines])
    segments: dict[tuple[tuple[float, float], tuple[float, float]], str] = {}
    segment_refs: dict[tuple[tuple[float, float], tuple[float, float]], set[str]] = defaultdict(set)
    for line in _extract_lines(noded):
        coordinates = list(line.coords)
        for left, right in zip(coordinates, coordinates[1:]):
            segment = LineString([left, right])
            if segment.length <= 1e-9:
                continue
            assignment = _segment_assignment(segment, assignment_geometries, snap_tolerance_mm)
            if assignment is None:
                raise TopologyError(
                    "structure_semantics_conflict",
                    "结构线重叠或语义冲突，不能生成面提案",
                    details={"bounds_mm": [round(float(value), 6) for value in segment.bounds]},
                )
            key = _segment_key(tuple(left), tuple(right))
            previous = segments.get(key)
            if previous is not None and previous != assignment:
                raise TopologyError("structure_semantics_conflict", "同一结构边存在多个语义")
            segments[key] = assignment
            tree = source_trees.get(assignment)
            if tree is not None:
                segment_refs[key].update(
                    _segment_source_refs(
                        segment,
                        source_records[assignment],
                        tree,
                        snap_tolerance_mm,
                    )
                )

    sorted_vertices = sorted({point for key in segments for point in key})
    vertex_ids = {point: f"pv-{index:04d}" for index, point in enumerate(sorted_vertices, start=1)}
    sorted_segments = sorted(segments)
    edge_ids = {key: f"pe-{index:04d}" for index, key in enumerate(sorted_segments, start=1)}
    edge_payload = [
        {
            "id": edge_ids[key],
            "start": vertex_ids[key[0]],
            "end": vertex_ids[key[1]],
            "assignment": segments[key],
            "source_refs": sorted(segment_refs[key])[:100] or [f"derived:{edge_ids[key]}"],
        }
        for key in sorted_segments
    ]
    polygon_lines = [LineString(key) for key in sorted_segments]
    polygons, cuts, dangles, invalids = polygonize_full(polygon_lines)
    if not allow_partial and any(_collection_items(item) for item in (cuts, dangles, invalids)):
        raise TopologyError("structure_open_boundary", "面提案仍有未闭合结构边")
    polygon_items = sorted(
        _collection_items(polygons),
        key=lambda polygon: tuple(round(float(value), 9) for value in polygon.bounds),
    )
    face_payload: list[dict[str, Any]] = []
    preview: list[dict[str, Any]] = []
    edge_faces: dict[str, list[str]] = defaultdict(list)
    for index, polygon in enumerate(polygon_items, start=1):
        coordinates = list(polygon.exterior.coords)
        boundary: list[str] = []
        for left, right in zip(coordinates, coordinates[1:]):
            key = _segment_key(tuple(left), tuple(right))
            edge_id = edge_ids.get(key)
            if edge_id is None:
                raise TopologyError("structure_face_mapping_incomplete", "面边界无法映射回结构边")
            boundary.append(edge_id)
        identity = f"proposal-face-{index:04d}"
        frame = _face_transform(polygon)
        face: dict[str, Any] = {"id": identity, "boundary": boundary, "role": "unknown"}
        if frame is not None:
            face["artwork_transform"] = frame[0]
        face_payload.append(face)
        for edge_id in boundary:
            edge_faces[edge_id].append(identity)
        preview.append(
            {
                "id": identity,
                "bounds_mm": [round(float(value), 6) for value in polygon.bounds],
                "centroid_mm": [round(float(polygon.centroid.x), 6), round(float(polygon.centroid.y), 6)],
                "area_mm2": round(float(polygon.area), 6),
                "rectangular": frame is not None,
                "size_mm": frame[1] if frame is not None else None,
                "points_mm": [
                    [round(float(point[0]), 6), round(float(point[1]), 6)]
                    for point in list(polygon.exterior.coords)[:-1]
                ] if len(polygon.exterior.coords) - 1 <= 128 else None,
            }
        )
    edge_by_id = {edge["id"]: edge for edge in edge_payload}
    folds = [
        {
            "edge": edge_id,
            "left_face": faces[0],
            "right_face": faces[1],
            "angle_deg": 90.0,
        }
        for edge_id, faces in sorted(edge_faces.items())
        if len(faces) == 2 and edge_by_id[edge_id]["assignment"] in {"crease", "perforation"}
    ]
    proposal = {
        "schema": structure["schema"],
        "units": "mm",
        "source": structure["source"],
        "vertices": [
            {"id": vertex_ids[point], "x": point[0], "y": point[1]}
            for point in sorted_vertices
        ],
        "edges": edge_payload,
        "faces": face_payload,
        "folds": folds,
        "root_face": None,
        "validation": {
            "status": "review_required",
            "errors": ["structure_face_mapping_incomplete"],
            "warnings": [],
        },
    }
    return {"structure": canonicalize_structure(proposal), "faces": preview, "topology": topology}


def analyze_topology(
    payload: Mapping[str, Any],
    *,
    snap_tolerance_mm: float = 0.1,
    limits: Mapping[str, int] | None = None,
) -> dict[str, Any]:
    if isinstance(snap_tolerance_mm, bool) or not isinstance(snap_tolerance_mm, (int, float)):
        raise TopologyError("structure_contract_invalid", "snap_tolerance_mm 必须是数值")
    tolerance = float(snap_tolerance_mm)
    if not math.isfinite(tolerance) or tolerance < 0 or tolerance > 2.0:
        raise TopologyError("structure_contract_invalid", "snap_tolerance_mm 必须位于 0–2 mm")
    configured_limits = {**DEFAULT_LIMITS, **dict(limits or {})}
    structure = canonicalize_structure(payload)
    vertices = {item["id"]: (float(item["x"]), float(item["y"])) for item in structure["vertices"]}
    by_assignment: dict[str, list[LineString]] = defaultdict(list)
    for edge in structure["edges"]:
        if edge["assignment"] in LINEWORK_ASSIGNMENTS:
            by_assignment[edge["assignment"]].append(
                LineString([vertices[edge["start"]], vertices[edge["end"]]])
            )
    edge_count = sum(len(lines) for lines in by_assignment.values())
    if edge_count == 0:
        return {
            "status": "review_required",
            "errors": ["structure_semantics_missing"],
            "warnings": [],
            "counts": {"linework_edges": 0, "faces": 0, "components": 0},
            "faces": [],
            "diagnostics": {
                "dangles": {"count": 0, "total_length_mm": 0.0, "bounds_mm": []},
                "cut_edges": {"count": 0, "total_length_mm": 0.0, "bounds_mm": []},
                "invalid_rings": {"count": 0, "total_length_mm": 0.0, "bounds_mm": []},
            },
        }
    if edge_count > configured_limits["linework_edges"]:
        raise TopologyError(
            "structure_limit_exceeded",
            "结构线数量超过拓扑上限",
            details={"count": edge_count, "limit": configured_limits["linework_edges"]},
        )

    assignment_lines: dict[str, list[LineString]] = {}
    for assignment in LINEWORK_ASSIGNMENTS:
        assignment_lines[assignment] = _snap_same_assignment(by_assignment.get(assignment, []), tolerance)
    all_lines = [line for assignment in LINEWORK_ASSIGNMENTS for line in assignment_lines[assignment]]
    noded = unary_union(all_lines)
    merged = line_merge(noded)
    merged_lines = _extract_lines(merged)
    polygons, cut_edges, dangles, invalid_rings = polygonize_full(merged_lines)
    polygon_items = sorted(
        _collection_items(polygons),
        key=lambda polygon: tuple(round(float(value), 9) for value in polygon.bounds),
    )
    if len(polygon_items) > configured_limits["faces"]:
        raise TopologyError(
            "structure_limit_exceeded",
            "拓扑面数量超过上限",
            details={"count": len(polygon_items), "limit": configured_limits["faces"]},
        )
    components = _connected_components(_extract_lines(noded))
    if components > configured_limits["components"]:
        raise TopologyError(
            "structure_limit_exceeded",
            "结构连通分量超过上限",
            details={"count": components, "limit": configured_limits["components"]},
        )

    errors: list[str] = []
    warnings: list[str] = []
    dangle_info = _diagnostic(dangles)
    cut_info = _diagnostic(cut_edges)
    invalid_info = _diagnostic(invalid_rings)
    if dangle_info["count"] or cut_info["count"]:
        errors.append("structure_open_boundary")
    if invalid_info["count"]:
        errors.append("structure_invalid_ring")
    if components > 1:
        errors.append("structure_multiple_components")
    if components > PROPOSAL_COMPONENT_REVIEW_THRESHOLD:
        warnings.append("structure_many_components_partitioned")
    if not polygon_items:
        errors.append("structure_face_mapping_incomplete")

    faces = [
        {
            "id": f"derived-face-{index:04d}",
            "area_mm2": round(float(polygon.area), 6),
            "bounds_mm": [round(float(value), 6) for value in polygon.bounds],
            "centroid_mm": [round(float(polygon.centroid.x), 6), round(float(polygon.centroid.y), 6)],
        }
        for index, polygon in enumerate(polygon_items, start=1)
    ]
    return {
        "status": "accepted" if not errors else "review_required",
        "errors": errors,
        "warnings": warnings,
        "counts": {
            "linework_edges": edge_count,
            "cut_edges": len(assignment_lines["cut"]),
            "crease_edges": len(assignment_lines["crease"]),
            "perforation_edges": len(assignment_lines["perforation"]),
            "faces": len(faces),
            "components": components,
        },
        "faces": faces,
        "diagnostics": {
            "dangles": dangle_info,
            "cut_edges": cut_info,
            "invalid_rings": invalid_info,
        },
    }
