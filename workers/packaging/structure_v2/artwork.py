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


def _coverage_bounds(
    face: Mapping[str, Any],
    width_mm: float,
    height_mm: float,
    tolerance_mm: float,
) -> tuple[float, float, float, float]:
    raw = face.get("artwork_coverage_bounds_mm")
    if raw is None:
        return (0.0, 0.0, width_mm, height_mm)
    if not isinstance(raw, list) or len(raw) != 4:
        raise ArtworkMappingError("artwork_transform_invalid", "贴图覆盖范围格式无效")
    try:
        left, top, right, bottom = (float(value) for value in raw)
    except (TypeError, ValueError) as error:
        raise ArtworkMappingError("artwork_transform_invalid", "贴图覆盖范围格式无效") from error
    if (
        not all(math.isfinite(value) for value in (left, top, right, bottom))
        or right <= left
        or bottom <= top
        or left < -tolerance_mm
        or top < -tolerance_mm
        or right > width_mm + tolerance_mm
        or bottom > height_mm + tolerance_mm
    ):
        raise ArtworkMappingError("artwork_transform_invalid", "贴图覆盖范围超出盒面")
    return (
        max(0.0, left),
        max(0.0, top),
        min(width_mm, right),
        min(height_mm, bottom),
    )


def _alpha_mask_unprinted_area(
    image: Image.Image,
    coverage: tuple[float, float, float, float],
    width_mm: float,
    height_mm: float,
) -> Image.Image:
    rgba = image.convert("RGBA")
    if coverage == (0.0, 0.0, width_mm, height_mm):
        return rgba
    left = max(0, min(image.width, math.floor(coverage[0] / width_mm * image.width)))
    top = max(0, min(image.height, math.floor(coverage[1] / height_mm * image.height)))
    right = max(left, min(image.width, math.ceil(coverage[2] / width_mm * image.width)))
    bottom = max(top, min(image.height, math.ceil(coverage[3] / height_mm * image.height)))
    masked = Image.new("RGBA", image.size, (0, 0, 0, 0))
    if right > left and bottom > top:
        masked.alpha_composite(rgba.crop((left, top, right, bottom)), (left, top))
    return masked


def render_face_assets(
    artwork_pdf: Path | str,
    resolved: Mapping[str, Any],
    output_dir: Path | str,
    *,
    raster_width_px: int = 10_000,
    max_raster_pixels: int = MAX_ARTWORK_RASTER_PIXELS,
    bounds_tolerance_mm: float = 0.2,
) -> dict[str, list[int]]:
    if resolved.get("schema") != "resolved-packaging-job/3":
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
        # Render against a transparent page.  Rendering with ``alpha=False``
        # bakes every unpainted PDF pixel into opaque white before the physical
        # coverage mask is applied, so kraft/deep-colour paper can never show
        # through.  Explicit white artwork remains opaque; only genuinely
        # unpainted PDF regions retain alpha=0.
        pixmap = page.get_pixmap(
            matrix=pymupdf.Matrix(zoom, zoom),
            colorspace=pymupdf.csRGB,
            alpha=True,
        )
        if pixmap.n != 4 or not pixmap.alpha:
            raise ArtworkMappingError("artwork_render_invalid", f"artwork 必须渲染为 RGBA，实际通道={pixmap.n}")
        page_image = Image.frombytes("RGBA", (pixmap.width, pixmap.height), pixmap.samples)
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
        width_mm = float(dimensions[keys[0]])
        height_mm = float(dimensions[keys[1]])
        raw_layers = face.get("artwork_layers")
        if not isinstance(raw_layers, list) or not raw_layers:
            raise ArtworkMappingError("artwork_transform_invalid", f"{role} 面缺少贴图图层")
        layers = sorted(
            (layer for layer in raw_layers if isinstance(layer, Mapping)),
            key=lambda layer: int(layer.get("z_index", -1)),
        )
        if len(layers) != len(raw_layers) or [layer.get("z_index") for layer in layers] != list(range(len(layers))):
            raise ArtworkMappingError("artwork_transform_invalid", f"{role} 面贴图层级无效")
        output_size = (
            max(8, round(width_mm * pixels_per_mm)),
            max(8, round(height_mm * pixels_per_mm)),
        )
        # Keep missing physical artwork transparent. Blender places this mask
        # over the opaque paperboard core, so kraft/deep-colour substrates show
        # through instead of becoming a baked white rectangle.
        face_image = Image.new("RGBA", output_size, (0, 0, 0, 0))
        for layer in layers:
            transform = layer.get("artwork_transform")
            if not isinstance(transform, list) or len(transform) != 6:
                raise ArtworkMappingError("artwork_transform_invalid", f"{role} 面贴图成员缺少仿射变换")
            coverage = _coverage_bounds(layer, width_mm, height_mm, bounds_tolerance_mm)
            inverse = _inverse(transform)
            left, top, right, bottom = coverage
            corners = [
                (
                    inverse[0] * x + inverse[1] * y + inverse[2],
                    inverse[3] * x + inverse[4] * y + inverse[5],
                )
                for x, y in ((left, top), (right, top), (right, bottom), (left, bottom))
            ]
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
            ia, ic, ie, ib, id_, if_ = inverse
            pillow_inverse = (
                ia,
                ic,
                ie * pixels_per_mm,
                ib,
                id_,
                if_ * pixels_per_mm,
            )
            layer_image = page_image.transform(
                output_size,
                Image.Transform.AFFINE,
                pillow_inverse,
                resample=Image.Resampling.BICUBIC,
                fillcolor=(0, 0, 0, 0),
            )
            face_image.alpha_composite(
                _alpha_mask_unprinted_area(layer_image, coverage, width_mm, height_mm)
            )
        output = destination / f"panel_{role}.png"
        face_image.save(output, compress_level=3)
        sizes[role] = [face_image.width, face_image.height]
    return sizes
