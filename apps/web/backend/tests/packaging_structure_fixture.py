from __future__ import annotations


def semantic_box(*, source_hash: str = "d" * 64) -> dict:
    width, depth, height = 30.0, 20.0, 50.0
    rectangles = {
        "back": (0.0, depth, width, depth + height),
        "left": (width, depth, width + depth, depth + height),
        "front": (width + depth, depth, 2 * width + depth, depth + height),
        "right": (2 * width + depth, depth, 2 * width + 2 * depth, depth + height),
        "top": (width + depth, depth + height, 2 * width + depth, 2 * depth + height),
        "bottom": (width + depth, 0.0, 2 * width + depth, depth),
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
            "page_size": [120, 90],
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
