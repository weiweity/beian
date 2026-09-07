"""白底静帧取景与地面放置。BOX_PANEL_GAP_MM 与 add_box 对齐，不改盒子几何。"""

from __future__ import annotations

import math


def camera_target_mm(width: float, depth: float, height: float) -> tuple[float, float, float]:
    return (0.0, 0.0, max(height, 1.0) / 2.0)


def camera_location_mm(width: float, depth: float, height: float) -> tuple[float, float, float]:
    longest = max(width, depth, height, 1.0)
    dist = longest * 2.35
    tx, ty, tz = camera_target_mm(width, depth, height)
    return (tx + dist * 0.52, ty - dist * 0.82, tz + dist * 0.38)


def camera_ortho_scale_mm(width: float, depth: float, height: float, margin: float = 1.36) -> float:
    """3/4 正交要同时罩住对角线和高度，不能只乘最长边。"""
    diag = math.hypot(width, depth)
    span = max(diag, height, width, depth, 1.0)
    return round(max(span * margin, 80.0), 1)


def aabb_after_z_rotation(width: float, depth: float, height: float, yaw_rad: float) -> tuple[float, float, float]:
    """绕 Z 转盒子后的轴对齐外框。180° 与 0° 相同；90° 宽深对调。"""
    c = abs(math.cos(yaw_rad))
    s = abs(math.sin(yaw_rad))
    return (width * c + depth * s, width * s + depth * c, height)


def camera_fit_after_yaw(
    width: float, depth: float, height: float, yaw_rad: float
) -> tuple[tuple[float, float, float], tuple[float, float, float], float]:
    span_w, span_d, span_h = aabb_after_z_rotation(width, depth, height, yaw_rad)
    return (
        camera_location_mm(span_w, span_d, span_h),
        camera_target_mm(span_w, span_d, span_h),
        camera_ortho_scale_mm(span_w, span_d, span_h),
    )


# Keep in sync with add_box panel gap. Do not rewrite add_box.
BOX_PANEL_GAP_MM = 0.065
GROUND_PLANE_OFFSET_MM = 0.2


def box_bottom_z_mm(gap: float = BOX_PANEL_GAP_MM) -> float:
    return 0.0 - float(gap)


def ground_plane_z(bottom_z: float, offset: float = GROUND_PLANE_OFFSET_MM) -> float:
    """Ground sits offset mm below the carton bottom panel."""
    return float(bottom_z) - float(offset)


def ground_plane_size(ortho_scale: float) -> float:
    """Cover the ortho frustum; never smaller than the legacy 600mm floor."""
    return max(600.0, 2.5 * float(ortho_scale))


def white_set_wall_y_mm(depth: float, ortho_scale: float) -> float:
    """Wall sits in +Y, behind the carton from the -Y camera, inside the frustum."""
    return max(float(depth) / 2.0 + 8.0, 0.22 * float(ortho_scale))


# Keep in sync with render_geometry._source_point UV charts. Artwork ppm is
# measured on this millimetre basis, not a second approximate camera box.
FACE_AXES = {
    "front": ("width", "height"),
    "right": ("depth", "height"),
    "back": ("width", "height"),
    "left": ("depth", "height"),
    "top": ("width", "depth"),
    "bottom": ("width", "depth"),
}
SHOT_YAW_FIELDS = {
    "front_right": "front_rotation_deg",
    "back_left": "back_rotation_deg",
}
PPM_DECIMALS = 6


def _sub(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _scale(a: tuple[float, float, float], scalar: float) -> tuple[float, float, float]:
    return (a[0] * scalar, a[1] * scalar, a[2] * scalar)


def _dot(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _length(a: tuple[float, float, float]) -> float:
    return math.sqrt(_dot(a, a))


def _normalize(a: tuple[float, float, float]) -> tuple[float, float, float]:
    length = _length(a)
    if not math.isfinite(length) or length <= 1e-12:
        raise ValueError("camera_basis_invalid")
    return _scale(a, 1.0 / length)


def rotate_z(point: tuple[float, float, float], yaw_rad: float) -> tuple[float, float, float]:
    cosine = math.cos(yaw_rad)
    sine = math.sin(yaw_rad)
    return (
        point[0] * cosine - point[1] * sine,
        point[0] * sine + point[1] * cosine,
        point[2],
    )


def face_source_point(
    face: str,
    u: float,
    v: float,
    width: float,
    depth: float,
    height: float,
) -> tuple[float, float, float]:
    """Unit-UV point on the artwork chart, before the +height/2 seating shift."""

    if face == "front":
        return ((u - 0.5) * width, -depth / 2.0, (v - 0.5) * height)
    if face == "right":
        return (width / 2.0, (u - 0.5) * depth, (v - 0.5) * height)
    if face == "back":
        return ((0.5 - u) * width, depth / 2.0, (v - 0.5) * height)
    if face == "left":
        return (-width / 2.0, (0.5 - u) * depth, (v - 0.5) * height)
    if face == "top":
        return ((u - 0.5) * width, (v - 0.5) * depth, height / 2.0)
    if face == "bottom":
        return ((u - 0.5) * width, (0.5 - v) * depth, -height / 2.0)
    raise ValueError("face_basis_invalid")


def face_world_point(
    face: str,
    u_mm: float,
    v_mm: float,
    width: float,
    depth: float,
    height: float,
) -> tuple[float, float, float]:
    axes = FACE_AXES[face]
    sizes = {"width": width, "depth": depth, "height": height}
    span_u = float(sizes[axes[0]])
    span_v = float(sizes[axes[1]])
    if span_u <= 0.0 or span_v <= 0.0:
        raise ValueError("face_basis_invalid")
    source = face_source_point(face, u_mm / span_u, v_mm / span_v, width, depth, height)
    return (source[0], source[1], source[2] + height / 2.0)


def blender_camera_axes(
    location: tuple[float, float, float],
    target: tuple[float, float, float],
) -> tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]:
    """Match render_job.look_at: track -Z toward target, local Y up, world Z up."""

    z_axis = _normalize(_sub(location, target))
    world_up = (0.0, 0.0, 1.0)
    x_axis = _cross(world_up, z_axis)
    if _length(x_axis) <= 1e-8:
        x_axis = _cross((0.0, 1.0, 0.0), z_axis)
    x_axis = _normalize(x_axis)
    y_axis = _cross(z_axis, x_axis)
    return x_axis, y_axis, z_axis


def ortho_frustum_mm(ortho_scale: float, res_x: int, res_y: int) -> tuple[float, float]:
    """Blender ortho_scale is the largest rendered edge, in millimetres."""

    scale = float(ortho_scale)
    width_px = int(res_x)
    height_px = int(res_y)
    if scale <= 0.0 or width_px <= 0 or height_px <= 0:
        raise ValueError("camera_frustum_invalid")
    if width_px >= height_px:
        return scale, scale * height_px / width_px
    return scale * width_px / height_px, scale


def project_world_to_pixels(
    point: tuple[float, float, float],
    location: tuple[float, float, float],
    axes: tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]],
    frustum_mm: tuple[float, float],
    resolution_px: tuple[int, int],
) -> tuple[float, float]:
    rel = _sub(point, location)
    cam_x = _dot(rel, axes[0])
    cam_y = _dot(rel, axes[1])
    res_x, res_y = resolution_px
    width_mm, height_mm = frustum_mm
    pixel_x = (cam_x / width_mm + 0.5) * res_x
    pixel_y = (0.5 - cam_y / height_mm) * res_y
    return pixel_x, pixel_y


def resolved_shot_camera(
    width: float,
    depth: float,
    height: float,
    yaw_rad: float,
    shots: dict,
) -> dict:
    """Same placement as render_job.apply_camera_fit for one product yaw."""

    span_w, span_d, span_h = aabb_after_z_rotation(width, depth, height, yaw_rad)
    location = camera_location_mm(span_w, span_d, span_h)
    target = camera_target_mm(span_w, span_d, span_h)
    fitted = camera_ortho_scale_mm(span_w, span_d, span_h)
    pinned = shots.get("camera_ortho_scale_mm")
    if (
        shots.get("camera_mode") == "legacy-pinned"
        and pinned not in (None, 0, 0.0)
        and abs(span_w - width) < 1e-6
        and abs(span_d - depth) < 1e-6
    ):
        scale = float(pinned)
    else:
        scale = fitted
    resolution = shots["master_resolution_px"]
    res_x, res_y = int(resolution[0]), int(resolution[1])
    return {
        "view": None,
        "yaw_rad": float(yaw_rad),
        "location_mm": location,
        "target_mm": target,
        "ortho_scale_mm": scale,
        "axes": blender_camera_axes(location, target),
        "frustum_mm": ortho_frustum_mm(scale, res_x, res_y),
        "resolution_px": (res_x, res_y),
    }


def _svd2_singular_values(j00: float, j01: float, j10: float, j11: float) -> tuple[float, float]:
    gram_a = j00 * j00 + j10 * j10
    gram_b = j00 * j01 + j10 * j11
    gram_c = j01 * j01 + j11 * j11
    trace = gram_a + gram_c
    discriminant = math.sqrt(max(0.0, (gram_a - gram_c) * (gram_a - gram_c) + 4.0 * gram_b * gram_b))
    eig_max = max(0.0, (trace + discriminant) / 2.0)
    eig_min = max(0.0, (trace - discriminant) / 2.0)
    return math.sqrt(eig_max), math.sqrt(eig_min)


def face_jacobian_ppm(
    face: str,
    dimensions: dict,
    camera: dict,
) -> dict:
    width = float(dimensions["width"])
    depth = float(dimensions["depth"])
    height = float(dimensions["height"])
    span_u = float(dimensions[FACE_AXES[face][0]])
    span_v = float(dimensions[FACE_AXES[face][1]])
    if not all(math.isfinite(value) and value > 0.0 for value in (width, depth, height, span_u, span_v)):
        raise ValueError("face_basis_invalid")
    step_u = min(1.0, span_u * 0.25)
    step_v = min(1.0, span_v * 0.25)
    if step_u <= 0.0 or step_v <= 0.0:
        raise ValueError("face_basis_invalid")
    center_u = span_u / 2.0
    center_v = span_v / 2.0
    yaw = float(camera["yaw_rad"])

    def projected(u_mm: float, v_mm: float) -> tuple[float, float]:
        world = rotate_z(
            face_world_point(face, u_mm, v_mm, width, depth, height),
            yaw,
        )
        return project_world_to_pixels(
            world,
            camera["location_mm"],
            camera["axes"],
            camera["frustum_mm"],
            camera["resolution_px"],
        )

    origin = projected(center_u, center_v)
    plus_u = projected(center_u + step_u, center_v)
    plus_v = projected(center_u, center_v + step_v)
    j00 = (plus_u[0] - origin[0]) / step_u
    j10 = (plus_u[1] - origin[1]) / step_u
    j01 = (plus_v[0] - origin[0]) / step_v
    j11 = (plus_v[1] - origin[1]) / step_v
    if not all(math.isfinite(value) for value in (j00, j01, j10, j11)):
        raise ValueError("face_jacobian_invalid")
    max_ppm, min_ppm = _svd2_singular_values(j00, j01, j10, j11)
    return {
        "projected_max_ppm": max_ppm,
        "projected_min_ppm": min_ppm,
        "jacobian": [[j00, j01], [j10, j11]],
    }


def round_ppm(value: float) -> float:
    return round(float(value), PPM_DECIMALS)


def face_pixel_size(face: str, dimensions: dict, ppm: float) -> tuple[int, int]:
    horizontal, vertical = FACE_AXES[face]
    width_px = max(8, math.ceil(float(dimensions[horizontal]) * float(ppm)))
    height_px = max(8, math.ceil(float(dimensions[vertical]) * float(ppm)))
    return width_px, height_px


def project_face_sampling(
    dimensions: dict,
    shots: dict,
    sampling: dict,
) -> dict:
    """Per-face 2x2 Jacobian sampling from the actual two-shot camera.

    ``untruncated_target_ppm`` is projected_max * oversample_ratio, floored
    by minimum ppm.  It is never clamped down to maximum ppm here.
    """

    width = float(dimensions["width"])
    depth = float(dimensions["depth"])
    height = float(dimensions["height"])
    if not all(math.isfinite(value) and value > 0.0 for value in (width, depth, height)):
        raise ValueError("face_basis_invalid")
    oversample = float(sampling["oversample_ratio"])
    minimum = float(sampling["minimum_face_pixels_per_mm"])
    maximum = float(sampling["maximum_face_pixels_per_mm"])
    allowed_pixels = int(sampling["maximum_face_pixels"])
    if not math.isfinite(oversample) or oversample < 1.0:
        raise ValueError("oversample_ratio_invalid")
    views = list(shots.get("views") or ())
    if not views:
        raise ValueError("shots_missing")
    faces: dict[str, dict] = {}
    violations: list[dict] = []
    targets: dict[str, float] = {}
    for face in FACE_AXES:
        shot_rows = {}
        max_ppm = 0.0
        min_ppm = math.inf
        for view in views:
            field = SHOT_YAW_FIELDS.get(str(view))
            if field is None:
                raise ValueError("shot_view_invalid")
            yaw = math.radians(float(shots[field]))
            camera = resolved_shot_camera(width, depth, height, yaw, shots)
            camera["view"] = str(view)
            row = face_jacobian_ppm(face, dimensions, camera)
            shot_rows[str(view)] = {
                "projected_max_ppm": row["projected_max_ppm"],
                "projected_min_ppm": row["projected_min_ppm"],
                "ortho_scale_mm": camera["ortho_scale_mm"],
                "resolution_px": list(camera["resolution_px"]),
            }
            max_ppm = max(max_ppm, row["projected_max_ppm"])
            min_ppm = min(min_ppm, row["projected_min_ppm"])
        if not math.isfinite(max_ppm) or max_ppm <= 0.0:
            raise ValueError("face_jacobian_invalid")
        untruncated = max(minimum, max_ppm * oversample)
        width_px, height_px = face_pixel_size(face, dimensions, untruncated)
        required_pixels = width_px * height_px
        exceeds_ppm = untruncated > maximum
        exceeds_pixels = required_pixels > allowed_pixels
        if exceeds_ppm or exceeds_pixels:
            violations.append(
                {
                    "face": face,
                    "required_pixels_per_mm": round_ppm(untruncated),
                    "allowed_pixels_per_mm": round_ppm(maximum),
                    "required_pixels": required_pixels,
                    "allowed_pixels": allowed_pixels,
                    "required_size_px": [width_px, height_px],
                    "projected_max_ppm": round_ppm(max_ppm),
                    "oversample_ratio": oversample,
                }
            )
        target = round_ppm(untruncated)
        targets[face] = target
        faces[face] = {
            "projected_max_ppm": round_ppm(max_ppm),
            "projected_min_ppm": round_ppm(min_ppm if math.isfinite(min_ppm) else 0.0),
            "untruncated_target_ppm": target,
            "target_pixels_per_mm": target,
            "shots": {
                view: {
                    "projected_max_ppm": round_ppm(row["projected_max_ppm"]),
                    "projected_min_ppm": round_ppm(row["projected_min_ppm"]),
                    "ortho_scale_mm": row["ortho_scale_mm"],
                    "resolution_px": row["resolution_px"],
                }
                for view, row in shot_rows.items()
            },
        }
    return {
        "faces": faces,
        "per_face_target_pixels_per_mm": targets,
        "budget_violations": violations,
    }
