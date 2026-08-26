"""Render exact face textures from object-clean artwork and affine mappings."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Mapping

from PIL import Image


PT_TO_MM = 25.4 / 72.0
MAX_ARTWORK_RASTER_PIXELS = 32_000_000
ROLE_SIZE_KEYS = {
    "front": ("width", "height"),
    "back": ("width", "height"),
    "left": ("depth", "height"),
    "right": ("depth", "height"),
    "top": ("width", "depth"),
    "bottom": ("width", "depth"),
}


class ArtworkMappingError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: Mapping[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": str(self), "details": self.details}


def _inverse(transform: list[float]) -> tuple[float, float, float, float, float, float]:
    a, b, c, d, e, f = (float(value) for value in transform)
    determinant = a * d - b * c
    if not math.isfinite(determinant) or abs(determinant) < 1e-12:
        raise ArtworkMappingError("artwork_transform_invalid", "贴图变换不可逆")
    return (
        d / determinant,
        -c / determinant,
        (c * f - d * e) / determinant,
        -b / determinant,
        a / determinant,
        (b * e - a * f) / determinant,
    )


def _source_corners(
    inverse: tuple[float, float, float, float, float, float],
    width_mm: float,
    height_mm: float,
) -> list[tuple[float, float]]:
    ia, ic, ie, ib, id_, if_ = inverse
    return [
        (ia * x + ic * y + ie, ib * x + id_ * y + if_)
        for x, y in ((0.0, 0.0), (width_mm, 0.0), (width_mm, height_mm), (0.0, height_mm))
    ]


def render_face_assets(
    artwork_pdf: Path | str,
    resolved: Mapping[str, Any],
    output_dir: Path | str,
    *,
    raster_width_px: int = 10_000,
    max_raster_pixels: int = MAX_ARTWORK_RASTER_PIXELS,
    bounds_tolerance_mm: float = 0.2,
) -> dict[str, list[int]]:
    if resolved.get("schema") != "resolved-packaging-job/1":
        raise ArtworkMappingError("structure_schema_unsupported", "不是受支持的 ResolvedPackagingJob")
    if isinstance(raster_width_px, bool) or not isinstance(raster_width_px, int) or not 256 <= raster_width_px <= 30_000:
        raise ArtworkMappingError("structure_limit_exceeded", "raster_width_px 必须位于 256–30000")
    if (
        isinstance(max_raster_pixels, bool)
        or not isinstance(max_raster_pixels, int)
        or max_raster_pixels < 256 * 256
    ):
        raise ArtworkMappingError("structure_limit_exceeded", "max_raster_pixels 必须至少为 65536")
    source = Path(artwork_pdf).expanduser().resolve()
    if not source.is_file():
        raise ArtworkMappingError("artwork_source_missing", f"找不到对象清理后的 artwork PDF：{source}")
    try:
        import pymupdf
    except ImportError as error:  # pragma: no cover - deployment dependency gate
        raise ArtworkMappingError("packaging_dependency_missing", "缺少 pymupdf") from error

    document = pymupdf.open(str(source))
    try:
        if document.page_count != 1:
            raise ArtworkMappingError("artwork_page_invalid", f"artwork PDF 必须是单页，实际={document.page_count}")
        page = document[0]
        page.set_cropbox(page.mediabox)
        page_width_mm = float(page.mediabox.width) * PT_TO_MM
        page_height_mm = float(page.mediabox.height) * PT_TO_MM
        page_width_points = float(page.mediabox.width)
        page_height_points = float(page.mediabox.height)
        target_width = raster_width_px
        target_height = max(1, math.ceil(target_width * page_height_points / page_width_points))
        if target_width * target_height > max_raster_pixels:
            target_width = math.floor(math.sqrt(max_raster_pixels * page_width_points / page_height_points))
            if target_width < 256:
                raise ArtworkMappingError(
                    "structure_limit_exceeded",
                    "artwork 画板比例过大，无法在像素上限内安全出图",
                )
        zoom = target_width / page_width_points
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        mode = "RGB" if pixmap.n == 3 else "CMYK" if pixmap.n == 4 else None
        if mode is None:
            raise ArtworkMappingError("artwork_render_invalid", f"不支持的 artwork 像素通道：{pixmap.n}")
        page_image = Image.frombytes(mode, (pixmap.width, pixmap.height), pixmap.samples).convert("RGB")
    finally:
        document.close()

    pixels_per_mm = page_image.width / page_width_mm
    dimensions = resolved.get("dimensions_mm") or {}
    faces = resolved.get("faces") or {}
    destination = Path(output_dir).expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)
    sizes: dict[str, list[int]] = {}
    for role, keys in ROLE_SIZE_KEYS.items():
        face = faces.get(role)
        if not isinstance(face, Mapping):
            raise ArtworkMappingError("structure_face_mapping_incomplete", f"缺少 {role} 面")
        transform = face.get("artwork_transform")
        if not isinstance(transform, list) or len(transform) != 6:
            raise ArtworkMappingError("artwork_transform_invalid", f"{role} 面缺少仿射变换")
        width_mm = float(dimensions[keys[0]])
        height_mm = float(dimensions[keys[1]])
        inverse = _inverse(transform)
        corners = _source_corners(inverse, width_mm, height_mm)
        if any(
            x < -bounds_tolerance_mm
            or y < -bounds_tolerance_mm
            or x > page_width_mm + bounds_tolerance_mm
            or y > page_height_mm + bounds_tolerance_mm
            for x, y in corners
        ):
            raise ArtworkMappingError(
                "artwork_transform_invalid",
                f"{role} 面贴图映射超出画板",
                details={"role": role, "corners_mm": corners, "page_mm": [page_width_mm, page_height_mm]},
            )
        output_size = (
            max(8, round(width_mm * pixels_per_mm)),
            max(8, round(height_mm * pixels_per_mm)),
        )
        ia, ic, ie, ib, id_, if_ = inverse
        pillow_inverse = (
            ia,
            ic,
            ie * pixels_per_mm,
            ib,
            id_,
            if_ * pixels_per_mm,
        )
        face_image = page_image.transform(
            output_size,
            Image.Transform.AFFINE,
            pillow_inverse,
            resample=Image.Resampling.BICUBIC,
            fillcolor=(255, 255, 255),
        )
        output = destination / f"panel_{role}.png"
        face_image.save(output, compress_level=3)
        sizes[role] = [face_image.width, face_image.height]
    return sizes
