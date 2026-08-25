"""白底静帧取景。不碰 add_box。给 render_job 和测试共用。"""

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
