from __future__ import annotations

from collections.abc import Mapping


def semantic_box(
    *,
    source_hash: str = "d" * 64,
    cap_body_role: str = "front",
    net_axis: str = "x",
    width: float = 30.0,
    depth: float = 20.0,
    height: float = 50.0,
    cap_clearance: float = 0.0,
    top_cap_depth: float | None = None,
    bottom_cap_depth: float | None = None,
    body_width_overrides: Mapping[str, float] | None = None,
) -> dict:
    if cap_body_role not in {"front", "right", "back", "left"}:
        raise ValueError(f"unsupported cap_body_role: {cap_body_role}")
    if net_axis not in {"x", "y"}:
        raise ValueError(f"unsupported net_axis: {net_axis}")
    body_widths = {"back": width, "left": depth, "front": width, "right": depth}
    if body_width_overrides:
        body_widths.update({role: float(value) for role, value in body_width_overrides.items()})
    if set(body_widths) != {"back", "left", "front", "right"} or any(value <= 0 for value in body_widths.values()):
        raise ValueError("body widths must define four positive panels")
    expected_cap_depth = depth if body_widths[cap_body_role] == width else width
    default_cap_depth = expected_cap_depth - cap_clearance
    top_depth = default_cap_depth if top_cap_depth is None else top_cap_depth
    bottom_depth = default_cap_depth if bottom_cap_depth is None else bottom_cap_depth
    if top_depth <= 0 or bottom_depth <= 0:
        raise ValueError("cap_clearance leaves no cap depth")
    body_top = bottom_depth
    rectangles = {}
    cursor = 0.0
    for role in ("back", "left", "front", "right"):
        panel_width = body_widths[role]
        rectangles[role] = (cursor, body_top, cursor + panel_width, body_top + height)
        cursor += panel_width
    cap_left, _body_y0, cap_right, body_bottom = rectangles[cap_body_role]
    rectangles.update({
        "top": (cap_left, body_bottom, cap_right, body_bottom + top_depth),
        "bottom": (cap_left, 0.0, cap_right, bottom_depth),
    })
    if net_axis == "y":
        rectangles = {
            role: (y0, x0, y1, x1)
            for role, (x0, y0, x1, y1) in rectangles.items()
        }
    vertex_ids: dict[tuple[float, float], str] = {}
    segment_faces: dict[tuple[tuple[float, float], tuple[float, float]], list[str]] = {}
    face_segments: dict[str, list[tuple[tuple[float, float], tuple[float, float]]]] = {}
    for role, (x0, y0, x1, y1) in rectangles.items():
        corners = ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
        face_segments[role] = []
        for point in corners:
            vertex_ids.setdefault(point, f"v-{len(vertex_ids) + 1}")
        for start, end in zip(corners, corners[1:] + corners[:1]):
            key = tuple(sorted((start, end)))
            segment_faces.setdefault(key, []).append(role)
            face_segments[role].append(key)
    edge_ids = {segment: f"e-{index}" for index, segment in enumerate(sorted(segment_faces), start=1)}
    faces = [
        {
            "id": f"face-{role}",
            "boundary": [edge_ids[segment] for segment in face_segments[role]],
            "role": role,
            "artwork_transform": [1, 0, 0, 1, -x0, -y0],
        }
        for role, (x0, y0, _x1, _y1) in rectangles.items()
    ]
    folds = [
        {
            "edge": edge_ids[segment],
            "left_face": f"face-{roles[0]}",
            "right_face": f"face-{roles[1]}",
            "angle_deg": 90,
        }
        for segment, roles in sorted(segment_faces.items())
        if len(roles) == 2
    ]
    return {
        "schema": "packaging-structure/1",
        "units": "mm",
        "source": {
            "sha256": source_hash,
            "adapter": "structural-sidecar/1",
            "adapter_version": "1.0.0",
            "coordinate_space": "artboard-top-left",
            "page_size": (
                [120, height + top_depth + bottom_depth]
                if net_axis == "x"
                else [height + top_depth + bottom_depth, 120]
            ),
        },
        "vertices": [
            {"id": identity, "x": point[0], "y": point[1]}
            for point, identity in vertex_ids.items()
        ],
        "edges": [
            {
                "id": edge_ids[segment],
                "start": vertex_ids[segment[0]],
                "end": vertex_ids[segment[1]],
                "assignment": "crease" if len(roles) == 2 else "cut",
                "source_refs": [f"fixture:{edge_ids[segment]}"],
            }
            for segment, roles in sorted(segment_faces.items())
        ],
        "faces": faces,
        "folds": folds,
        "root_face": "face-front",
        "validation": {"status": "accepted", "errors": [], "warnings": []},
    }
