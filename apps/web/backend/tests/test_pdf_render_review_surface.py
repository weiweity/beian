from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest

from app import pdf_render
from app.pdf_render import render_pdf_pages
from app.svg_render_worker import WHITE_PAGE
from app.compare_core import _page_urls


def _vector_pdf(path: Path) -> Path:
    doc = pymupdf.open()
    page = doc.new_page(width=640, height=360)
    page.draw_rect(pymupdf.Rect(30, 30, 610, 330), color=(0.2, 0.1, 0.3))
    page.insert_text((48, 96), "Review vector surface", fontsize=28)
    doc.save(path)
    doc.close()
    return path


def test_review_surface_keeps_ocr_png_and_adds_vector_svg(tmp_path: Path):
    pages = render_pdf_pages(_vector_pdf(tmp_path / "source.pdf"), tmp_path / "pages")

    assert len(pages) == 1
    page = pages[0]
    assert Path(page["path"]).name == "page_01.png"
    assert Path(page["path"]).is_file()
    assert Path(page["review_path"]).name == "page_01.svg"
    svg = Path(page["review_path"]).read_text(encoding="utf-8")
    assert "<svg" in svg
    assert WHITE_PAGE in svg
    assert svg.index(WHITE_PAGE) < svg.index("<path")
    assert page["review_format"] == "svg"
    assert page["width"] > 0 and page["height"] > 0


def test_review_surface_falls_back_to_png_when_svg_exceeds_budget(tmp_path: Path):
    pages = render_pdf_pages(
        _vector_pdf(tmp_path / "source.pdf"),
        tmp_path / "pages",
        review_svg_max_bytes=32,
    )

    assert "review_path" not in pages[0]
    assert Path(pages[0]["path"]).is_file()
    assert not (tmp_path / "pages" / "page_01.svg").exists()


def test_review_surface_falls_back_to_png_when_svg_generation_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    def broken_svg(*_args, **_kwargs):
        return False

    monkeypatch.setattr(pdf_render, "_render_review_svg", broken_svg)
    pages = render_pdf_pages(_vector_pdf(tmp_path / "source.pdf"), tmp_path / "pages")

    assert "review_path" not in pages[0]
    assert Path(pages[0]["path"]).is_file()
    assert not (tmp_path / "pages" / "page_01.svg").exists()


def test_review_surface_timeout_is_contained_and_keeps_png(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    def timed_out(*_args, **_kwargs):
        raise pdf_render.subprocess.TimeoutExpired("svg worker", 0.01)

    monkeypatch.setattr(pdf_render.subprocess, "run", timed_out)
    pages = render_pdf_pages(_vector_pdf(tmp_path / "source.pdf"), tmp_path / "pages")

    assert "review_path" not in pages[0]
    assert Path(pages[0]["path"]).is_file()
    assert not (tmp_path / "pages" / "page_01.svg").exists()
    assert "review-svg fallback: worker timeout" in capsys.readouterr().err


def test_review_surface_records_a_bounded_worker_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
):
    failure = pdf_render.subprocess.CompletedProcess(
        args=["svg worker"],
        returncode=9,
        stderr="render failed " + ("x" * 800),
    )
    monkeypatch.setattr(pdf_render.subprocess, "run", lambda *_args, **_kwargs: failure)

    pages = render_pdf_pages(_vector_pdf(tmp_path / "source.pdf"), tmp_path / "pages")
    logged = capsys.readouterr().err

    assert "review_path" not in pages[0]
    assert "review-svg fallback: worker exit 9 · render failed" in logged
    assert len(logged) < 500


def test_page_urls_display_svg_but_keep_raster_fallback():
    pages = _page_urls(
        "abc123",
        [
            {
                "name": "page_01.png",
                "review_name": "page_01.svg",
                "review_format": "svg",
                "page": 1,
                "width": 5600,
                "height": 3210,
            }
        ],
    )

    assert pages[0]["url"] == "/api/tasks/abc123/pages/page_01.svg"
    assert pages[0]["raster_url"] == "/api/tasks/abc123/pages/page_01.png"
    assert pages[0]["width"] == 5600


def test_side_page_urls_display_svg_but_keep_raster_fallback():
    pages = _page_urls(
        "abc123",
        [
            {
                "name": "page_01.png",
                "review_name": "page_01.svg",
                "review_format": "svg",
                "page": 1,
                "width": 5600,
                "height": 3210,
            }
        ],
        side="b",
    )

    assert pages[0]["url"] == "/api/tasks/abc123/pages/b/page_01.svg"
    assert pages[0]["raster_url"] == "/api/tasks/abc123/pages/b/page_01.png"
