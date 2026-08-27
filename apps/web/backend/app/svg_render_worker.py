"""Resource-contained PDF page to white-paper SVG renderer.

This process is intentionally disposable. The caller always has a bounded PNG
fallback, so a path-dense Illustrator page must fail closed without taking the
comparison worker down with it.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import pymupdf


WHITE_PAGE = '<rect width="100%" height="100%" fill="#ffffff"/>'


def _limit_address_space(memory_mb: int) -> None:
    if memory_mb <= 0:
        return
    try:
        import resource

        limit = memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except (ImportError, OSError, ValueError):
        # Windows has no resource module. Process isolation and the parent
        # timeout still prevent a stuck SVG expansion from blocking the job.
        return


def _white_paper(svg: str) -> str:
    start = svg.find("<svg")
    end = svg.find(">", start)
    if start < 0 or end < 0:
        raise ValueError("invalid SVG root")
    return svg[: end + 1] + WHITE_PAGE + svg[end + 1 :]


def render_page(
    pdf_path: Path,
    page_index: int,
    output: Path,
    max_bytes: int,
    memory_mb: int,
) -> int:
    output.unlink(missing_ok=True)
    temp = output.with_name(output.name + ".tmp")
    temp.unlink(missing_ok=True)
    _limit_address_space(memory_mb)
    document = pymupdf.open(pdf_path)
    try:
        if page_index < 0 or page_index >= document.page_count:
            return 2
        svg = document[page_index].get_svg_image(text_as_path=True)
        # Most generated SVG is ASCII. Reject a clearly oversized expansion
        # before creating a second bytes copy; verify the exact byte size next.
        if not svg or len(svg) + len(WHITE_PAGE) > max_bytes:
            return 3
        payload = _white_paper(svg).encode("utf-8")
        if len(payload) > max_bytes:
            return 3
        output.parent.mkdir(parents=True, exist_ok=True)
        temp.write_bytes(payload)
        os.replace(temp, output)
        return 0
    finally:
        document.close()
        temp.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--page-index", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-bytes", type=int, required=True)
    parser.add_argument("--memory-mb", type=int, default=768)
    args = parser.parse_args()
    return render_page(
        args.pdf,
        args.page_index,
        args.output,
        max(0, args.max_bytes),
        max(0, args.memory_mb),
    )


if __name__ == "__main__":
    raise SystemExit(main())
