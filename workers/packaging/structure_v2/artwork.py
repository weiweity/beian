"""Render exact face textures from object-clean artwork and affine mappings."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Mapping

from PIL import Image


PT_TO_MM = 25.4 / 72.0
MAX_ARTWORK_RASTER_PIXELS = 32_000_000
MIN_FACE_TEXTURE_PIXELS_PER_MM = 20.0
SOURCE_CLIP_PADDING_PIXELS = 2.0
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
    try:
        if right > left and bottom > top:
            cropped = rgba.crop((left, top, right, bottom))
            try:
                masked.alpha_composite(cropped, (left, top))
            finally:
                cropped.close()
    except Exception:
        masked.close()
        raise
    finally:
        rgba.close()
    return masked


def _source_clip_bounds(
    corners: list[tuple[float, float]],
    page_width_mm: float,
    page_height_mm: float,
    pixels_per_mm: float,
) -> tuple[float, float, float, float]:
    padding_mm = SOURCE_CLIP_PADDING_PIXELS / pixels_per_mm
    return (
        max(0.0, min(x for x, _y in corners) - padding_mm),
        max(0.0, min(y for _x, y in corners) - padding_mm),
        min(page_width_mm, max(x for x, _y in corners) + padding_mm),
        min(page_height_mm, max(y for _x, y in corners) + padding_mm),
    )


def _sampling_plan(
    width_mm: float,
    height_mm: float,
    page_width_mm: float,
    page_height_mm: float,
    layer_corners: list[list[tuple[float, float]]],
    pixels_per_mm: float,
    minimum_pixels_per_mm: float,
) -> tuple[tuple[int, int], int, list[tuple[tuple[float, float, float, float], int]]]:
    # Preserve legacy rounding above the floor; only the minimum is a hard lower
    # bound. PDF page-coordinate noise must not add a pixel to every larger grid.
    output_size = (
        max(8, round(width_mm * pixels_per_mm), math.ceil(width_mm * minimum_pixels_per_mm)),
        max(8, round(height_mm * pixels_per_mm), math.ceil(height_mm * minimum_pixels_per_mm)),
    )
    clips: list[tuple[tuple[float, float, float, float], int]] = []
    for corners in layer_corners:
        bounds = _source_clip_bounds(
            corners,
            page_width_mm,
            page_height_mm,
            pixels_per_mm,
        )
        source_left, source_top, source_right, source_bottom = bounds
        predicted_pixels = (
            max(1, math.ceil((source_right - source_left) * pixels_per_mm) + 2)
            * max(1, math.ceil((source_bottom - source_top) * pixels_per_mm) + 2)
        )
        clips.append((bounds, predicted_pixels))
    return output_size, output_size[0] * output_size[1], clips


def _plan_fits(
    plan: tuple[tuple[int, int], int, list[tuple[tuple[float, float, float, float], int]]],
    max_raster_pixels: int,
) -> bool:
    _output_size, output_pixels, clips = plan
    return output_pixels <= max_raster_pixels and all(
        predicted_pixels <= max_raster_pixels for _bounds, predicted_pixels in clips
    )


def _bounded_pixels_per_mm(
    width_mm: float,
    height_mm: float,
    page_width_mm: float,
    page_height_mm: float,
    layer_corners: list[list[tuple[float, float]]],
    desired_pixels_per_mm: float,
    minimum_pixels_per_mm: float,
    max_raster_pixels: int,
) -> tuple[
    float,
    tuple[tuple[int, int], int, list[tuple[tuple[float, float, float, float], int]]],
]:
    minimum_plan = _sampling_plan(
        width_mm,
        height_mm,
        page_width_mm,
        page_height_mm,
        layer_corners,
        minimum_pixels_per_mm,
        minimum_pixels_per_mm,
    )
    if not _plan_fits(minimum_plan, max_raster_pixels):
        return minimum_pixels_per_mm, minimum_plan
    desired_plan = _sampling_plan(
        width_mm,
        height_mm,
        page_width_mm,
        page_height_mm,
        layer_corners,
        desired_pixels_per_mm,
        minimum_pixels_per_mm,
    )
    if _plan_fits(desired_plan, max_raster_pixels):
        return desired_pixels_per_mm, desired_plan

    low = minimum_pixels_per_mm
    high = desired_pixels_per_mm
    for _attempt in range(48):
        candidate = (low + high) / 2.0
        candidate_plan = _sampling_plan(
            width_mm,
            height_mm,
            page_width_mm,
            page_height_mm,
            layer_corners,
            candidate,
            minimum_pixels_per_mm,
        )
        if _plan_fits(candidate_plan, max_raster_pixels):
            low = candidate
        else:
            high = candidate
    return low, _sampling_plan(
        width_mm,
        height_mm,
        page_width_mm,
        page_height_mm,
        layer_corners,
        low,
        minimum_pixels_per_mm,
    )


def render_face_assets(
    artwork_pdf: Path | str,
    resolved: Mapping[str, Any],
    output_dir: Path | str,
    *,
    raster_width_px: int = 10_000,
    max_raster_pixels: int = MAX_ARTWORK_RASTER_PIXELS,
    minimum_face_pixels_per_mm: float = MIN_FACE_TEXTURE_PIXELS_PER_MM,
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
    if (
        isinstance(minimum_face_pixels_per_mm, bool)
        or not isinstance(minimum_face_pixels_per_mm, (int, float))
        or not math.isfinite(float(minimum_face_pixels_per_mm))
        or not 1.0 <= float(minimum_face_pixels_per_mm) <= 64.0
    ):
        raise ArtworkMappingError(
            "structure_limit_exceeded",
            "minimum_face_pixels_per_mm 必须位于 1–64",
        )
    source = Path(artwork_pdf).expanduser().resolve()
    if not source.is_file():
        raise ArtworkMappingError("artwork_source_missing", f"找不到对象清理后的 artwork PDF：{source}")
    try:
        import pymupdf
    except ImportError as error:  # pragma: no cover - deployment dependency gate
        raise ArtworkMappingError("packaging_dependency_missing", "缺少 pymupdf") from error

    dimensions = resolved.get("dimensions_mm") or {}
    faces = resolved.get("faces") or {}
    destination = Path(output_dir).expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)
    sizes: dict[str, list[int]] = {}
    document = pymupdf.open(str(source))
    try:
        if document.page_count != 1:
            raise ArtworkMappingError("artwork_page_invalid", f"artwork PDF 必须是单页，实际={document.page_count}")
        page = document[0]
        # The structure IR is bound to the unrotated Illustrator artboard basis.
        # PyMuPDF otherwise applies PDF /Rotate during get_pixmap while mediabox
        # coordinates remain unrotated, silently sampling the wrong source area.
        try:
            page.set_rotation(0)
            media_box = page.mediabox
            # PyMuPDF exposes CropBox y-coordinates relative to MediaBox.y0.
            # Passing MediaBox back verbatim fails for legal non-zero origins.
            page.set_cropbox(
                pymupdf.Rect(
                    media_box.x0,
                    0.0,
                    media_box.x1,
                    media_box.height,
                )
            )
        except (RuntimeError, ValueError) as error:
            raise ArtworkMappingError("artwork_page_invalid", "artwork PDF 页框无效") from error
        page_width_mm = float(page.mediabox.width) * PT_TO_MM
        page_height_mm = float(page.mediabox.height) * PT_TO_MM
        if (
            not math.isfinite(page_width_mm)
            or not math.isfinite(page_height_mm)
            or page_width_mm <= 0.0
            or page_height_mm <= 0.0
        ):
            raise ArtworkMappingError("artwork_page_invalid", "artwork PDF 画板尺寸无效")
        desired_pixels_per_mm = max(
            float(minimum_face_pixels_per_mm),
            raster_width_px / page_width_mm,
        )

        for role, keys in ROLE_SIZE_KEYS.items():
            face = faces.get(role)
            if not isinstance(face, Mapping):
                raise ArtworkMappingError("structure_face_mapping_incomplete", f"缺少 {role} 面")
            width_mm = float(dimensions[keys[0]])
            height_mm = float(dimensions[keys[1]])
            raw_layers = face.get("artwork_layers")
            if face.get("paper_only") is True and not raw_layers:
                pixels_per_mm = float(minimum_face_pixels_per_mm)
                output_size = (
                    max(8, math.ceil(width_mm * pixels_per_mm)),
                    max(8, math.ceil(height_mm * pixels_per_mm)),
                )
                paper = Image.new("RGBA", output_size, (0, 0, 0, 0))
                try:
                    output = destination / f"panel_{role}.png"
                    paper.save(output, compress_level=3)
                    sizes[role] = [paper.width, paper.height]
                finally:
                    paper.close()
                continue
            if not isinstance(raw_layers, list) or not raw_layers:
                raise ArtworkMappingError("artwork_transform_invalid", f"{role} 面缺少贴图图层")
            layers = sorted(
                (layer for layer in raw_layers if isinstance(layer, Mapping)),
                key=lambda layer: int(layer.get("z_index", -1)),
            )
            if len(layers) != len(raw_layers) or [layer.get("z_index") for layer in layers] != list(range(len(layers))):
                raise ArtworkMappingError("artwork_transform_invalid", f"{role} 面贴图层级无效")
            layer_mappings: list[
                tuple[
                    tuple[float, float, float, float],
                    tuple[float, float, float, float, float, float],
                    list[tuple[float, float]],
                ]
            ] = []
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
                layer_mappings.append((coverage, inverse, corners))

            pixels_per_mm, plan = _bounded_pixels_per_mm(
                width_mm,
                height_mm,
                page_width_mm,
                page_height_mm,
                [corners for _coverage, _inverse_transform, corners in layer_mappings],
                desired_pixels_per_mm,
                float(minimum_face_pixels_per_mm),
                max_raster_pixels,
            )
            output_size, output_pixels, clips = plan
            oversized_clip = next(
                (predicted_pixels for _bounds, predicted_pixels in clips if predicted_pixels > max_raster_pixels),
                None,
            )
            if output_pixels > max_raster_pixels or oversized_clip is not None:
                source_limited = oversized_clip is not None and output_pixels <= max_raster_pixels
                required_pixels = oversized_clip if source_limited else output_pixels
                raise ArtworkMappingError(
                    "structure_limit_exceeded",
                    (
                        f"{role} 面的矢量取样范围在最低清晰度下仍需要过多像素"
                        if source_limited
                        else f"{role} 面在最低清晰度下仍需要过多像素"
                    ),
                    details={
                        "role": role,
                        "required_pixels": required_pixels,
                        "max_pixels": max_raster_pixels,
                        "pixels_per_mm": round(pixels_per_mm, 4),
                    },
                )
            output_ppm_x = output_size[0] / width_mm
            output_ppm_y = output_size[1] / height_mm
            zoom = pixels_per_mm * PT_TO_MM
            # Keep missing physical artwork transparent. Blender places this mask
            # over the opaque paperboard core, so kraft/deep-colour substrates show
            # through instead of becoming a baked white rectangle.
            face_image = Image.new("RGBA", output_size, (0, 0, 0, 0))
            try:
                for (coverage, inverse, _corners), (clip_bounds, _predicted_pixels) in zip(
                    layer_mappings,
                    clips,
                    strict=True,
                ):
                    source_left, source_top, source_right, source_bottom = clip_bounds
                    clip = pymupdf.Rect(
                        source_left / PT_TO_MM,
                        source_top / PT_TO_MM,
                        source_right / PT_TO_MM,
                        source_bottom / PT_TO_MM,
                    )
                    # Rasterize only the source region used by this physical face.
                    # A wide dieline no longer consumes the shared pixel budget or
                    # forces every glyph through a low-resolution full-page bitmap.
                    pixmap = page.get_pixmap(
                        matrix=pymupdf.Matrix(zoom, zoom),
                        colorspace=pymupdf.csRGB,
                        alpha=True,
                        clip=clip,
                    )
                    actual_source_pixels = pixmap.width * pixmap.height
                    if actual_source_pixels > max_raster_pixels:
                        raise ArtworkMappingError(
                            "structure_limit_exceeded",
                            f"{role} 面的实际矢量取样范围超过像素上限",
                            details={
                                "role": role,
                                "required_pixels": actual_source_pixels,
                                "max_pixels": max_raster_pixels,
                                "pixels_per_mm": round(pixels_per_mm, 4),
                            },
                        )
                    if pixmap.n != 4 or not pixmap.alpha:
                        raise ArtworkMappingError(
                            "artwork_render_invalid",
                            f"artwork 必须渲染为 RGBA，实际通道={pixmap.n}",
                        )
                    source_image = Image.frombytes("RGBA", (pixmap.width, pixmap.height), pixmap.samples)
                    ia, ic, ie, ib, id_, if_ = inverse
                    pillow_inverse = (
                        ia * pixels_per_mm / output_ppm_x,
                        ic * pixels_per_mm / output_ppm_y,
                        ie * pixels_per_mm - pixmap.x,
                        ib * pixels_per_mm / output_ppm_x,
                        id_ * pixels_per_mm / output_ppm_y,
                        if_ * pixels_per_mm - pixmap.y,
                    )
                    try:
                        layer_image = source_image.transform(
                            output_size,
                            Image.Transform.AFFINE,
                            pillow_inverse,
                            resample=Image.Resampling.BICUBIC,
                            fillcolor=(0, 0, 0, 0),
                        )
                    finally:
                        source_image.close()
                    try:
                        masked_layer = _alpha_mask_unprinted_area(layer_image, coverage, width_mm, height_mm)
                        try:
                            face_image.alpha_composite(masked_layer)
                        finally:
                            masked_layer.close()
                    finally:
                        layer_image.close()
                output = destination / f"panel_{role}.png"
                face_image.save(output, compress_level=3)
                sizes[role] = [face_image.width, face_image.height]
            finally:
                face_image.close()
    finally:
        document.close()
    return sizes
