"""PDF → PNG pages (+ size meta)"""
from __future__ import annotations

from pathlib import Path

import pymupdf
from PIL import Image

# 审稿默认：高清，便于 6× CSS 放大看小字/脚注。不上矢量看图器。
DEFAULT_DPI = 400
DEFAULT_MAX_SIDE = 5600
# 双 PDF / 内双页：小刀版要更高 DPI（物理尺寸小时 220 只有 ~1000px）
COMPARE_DPI = 400
COMPARE_MAX_SIDE = 5600
# 仅预览/极速
FAST_DPI = 200
FAST_MAX_SIDE = 2400


def render_pdf_pages(
    pdf_path: str | Path,
    out_dir: str | Path,
    max_pages: int = 3,
    dpi: int = DEFAULT_DPI,
    max_side: int = DEFAULT_MAX_SIDE,
    *,
    quality: str = "high",
) -> list[dict]:
    """
    返回 [{path, width, height, page, name, dpi}]

    quality:
      - high: Excel↔包装
      - compare: 跨规格/内双页（更高清）
      - fast: 仅预览
    """
    if quality == "fast":
        dpi = min(dpi, FAST_DPI) if dpi >= DEFAULT_DPI else dpi
        max_side = min(max_side, FAST_MAX_SIDE) if max_side >= DEFAULT_MAX_SIDE else max_side
    elif quality == "compare":
        dpi = max(dpi, COMPARE_DPI)
        max_side = max(max_side, COMPARE_MAX_SIDE)
    elif quality == "high":
        dpi = max(dpi, DEFAULT_DPI)
        max_side = max(max_side, DEFAULT_MAX_SIDE)

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(pdf_path)
    results: list[dict] = []
    zoom = dpi / 72.0
    for i, page in enumerate(doc):
        if i >= max_pages:
            break
        mat = pymupdf.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        if max(pix.width, pix.height) > max_side:
            scale = max_side / max(pix.width, pix.height)
            pix = page.get_pixmap(
                matrix=pymupdf.Matrix(zoom * scale, zoom * scale), alpha=False
            )
        # PNG 无损；大图用优化压缩级别
        p = out_dir / f"page_{i+1:02d}.png"
        p.write_bytes(pix.tobytes("png"))
        results.append(
            {
                "path": str(p),
                "name": p.name,
                "width": pix.width,
                "height": pix.height,
                "page": i + 1,
                "dpi": dpi,
            }
        )
    doc.close()
    return results


def image_size(path: str | Path) -> tuple[int, int]:
    with Image.open(path) as im:
        return im.size
