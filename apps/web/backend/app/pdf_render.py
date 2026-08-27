"""PDF → machine raster + human review surface.

OCR consumes the bounded PNG.  Reviewers consume a generated SVG when the PDF
page can be represented safely within the size budget.  Keeping those two
surfaces separate avoids asking one full-page raster to serve both OCR and 6×
human zoom.
"""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys

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
DEFAULT_REVIEW_SVG_MAX_BYTES = 16 * 1024 * 1024
DEFAULT_REVIEW_SVG_TIMEOUT_S = 12.0
DEFAULT_REVIEW_SVG_MEMORY_MB = 768


def _render_review_svg(
    pdf_path: Path,
    page_index: int,
    review_path: Path,
    max_bytes: int,
    *,
    timeout_s: float = DEFAULT_REVIEW_SVG_TIMEOUT_S,
    memory_mb: int = DEFAULT_REVIEW_SVG_MEMORY_MB,
) -> bool:
    """Generate an optional SVG outside the OCR worker's process.

    PyMuPDF exposes SVG as one in-memory string, so checking its size after
    ``get_svg_image`` does not protect the long-running comparison process.
    A short-lived worker contains that peak, enforces a timeout, and applies an
    address-space limit where the OS supports it. Any failure keeps the PNG.
    """
    review_path.unlink(missing_ok=True)
    worker = Path(__file__).with_name("svg_render_worker.py")
    command = [
        sys.executable,
        str(worker),
        "--pdf",
        str(pdf_path),
        "--page-index",
        str(page_index),
        "--output",
        str(review_path),
        "--max-bytes",
        str(max(0, int(max_bytes))),
        "--memory-mb",
        str(max(0, int(memory_mb))),
    ]
    try:
        completed = subprocess.run(
            command,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=max(0.1, float(timeout_s)),
        )
    except subprocess.TimeoutExpired:
        print("review-svg fallback: worker timeout", file=sys.stderr)
        review_path.unlink(missing_ok=True)
        return False
    except (OSError, ValueError) as exc:
        print(
            f"review-svg fallback: worker start failed ({type(exc).__name__})",
            file=sys.stderr,
        )
        review_path.unlink(missing_ok=True)
        return False
    valid = (
        completed.returncode == 0
        and review_path.is_file()
        and 0 < review_path.stat().st_size <= max(0, int(max_bytes))
    )
    if not valid:
        detail = " ".join(str(completed.stderr or "").split())[:400]
        suffix = f" · {detail}" if detail else ""
        print(
            f"review-svg fallback: worker exit {completed.returncode}{suffix}",
            file=sys.stderr,
        )
        review_path.unlink(missing_ok=True)
    return valid


def render_pdf_pages(
    pdf_path: str | Path,
    out_dir: str | Path,
    max_pages: int = 3,
    dpi: int = DEFAULT_DPI,
    max_side: int = DEFAULT_MAX_SIDE,
    *,
    quality: str = "high",
    review_svg_max_bytes: int = DEFAULT_REVIEW_SVG_MAX_BYTES,
) -> list[dict]:
    """
    返回 [{path, width, height, page, name, dpi, review_path?, review_name?}]

    ``path`` 永远是 OCR 使用的 PNG。``review_path`` 只指向本函数生成、且
    通过大小闸门的 SVG；生成失败时省略，调用方自然回退 PNG。

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
    for i, page in enumerate(doc):
        if i >= max_pages:
            break
        zoom = dpi / 72.0
        width = float(page.rect.width)
        height = float(page.rect.height)
        if width > 1 and height > 1:
            side = max(width, height) * zoom
            if side > max_side:
                zoom *= max_side / side
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        if max(pix.width, pix.height) > max_side:
            scale = max_side / max(pix.width, pix.height)
            pix = page.get_pixmap(
                matrix=pymupdf.Matrix(zoom * scale, zoom * scale), alpha=False
            )
        # PNG 无损；大图用优化压缩级别
        p = out_dir / f"page_{i+1:02d}.png"
        p.write_bytes(pix.tobytes("png"))
        meta = {
            "path": str(p),
            "name": p.name,
            "width": pix.width,
            "height": pix.height,
            "page": i + 1,
            "dpi": dpi,
        }
        review_path = out_dir / f"page_{i+1:02d}.svg"
        if _render_review_svg(
            Path(pdf_path),
            i,
            review_path,
            review_svg_max_bytes,
        ):
            meta["review_path"] = str(review_path)
            meta["review_name"] = review_path.name
            meta["review_format"] = "svg"
        results.append(meta)
    doc.close()
    return results


def image_size(path: str | Path) -> tuple[int, int]:
    with Image.open(path) as im:
        return im.size
