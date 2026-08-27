from __future__ import annotations

from pathlib import Path

import pymupdf
import pytest
from PIL import Image, ImageDraw

from app.pdf_ingest import (
    WARNING_IMAGE,
    WARNING_OUTLINED,
    classify_document,
    classify_page,
    ingest_pdf,
    live_char_count,
    public_ingest,
)
from app.pdf_render import render_pdf_pages
from app.text_verify import merge_text_sources

REPO = Path(__file__).resolve().parents[4]


def _zhuanqu_pdfs() -> list[Path]:
    roots = [REPO / "测试" / "审稿台"]
    out: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.pdf")):
            if "转曲" not in path.name:
                continue
            key = str(path.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(path)
    return out


def _live_text_pdf(path: Path) -> Path:
    doc = pymupdf.open()
    page = doc.new_page(width=420, height=300)
    page.insert_text(
        (36, 72),
        "Product Name Helvetica Live Text Sample for Cosmetics Label Review 12345",
        fontsize=12,
        fontname="helv",
    )
    page.insert_text(
        (36, 108),
        "INCI Water Glycerin Niacinamide more selectable characters on this carton.",
        fontsize=11,
        fontname="helv",
    )
    doc.save(str(path))
    doc.close()
    return path


def _outlined_pdf(path: Path) -> Path:
    doc = pymupdf.open()
    page = doc.new_page(width=420, height=300)
    for i in range(450):
        x = 12.0 + (i % 45) * 8.0
        y = 12.0 + (i // 45) * 14.0
        page.draw_line(
            pymupdf.Point(x, y),
            pymupdf.Point(x + 5.0, y + 9.0),
            color=(0, 0, 0),
            width=0.4,
        )
    page.insert_text((24, 280), "29.35", fontsize=8, fontname="helv")
    page.insert_text((72, 280), "56", fontsize=8, fontname="helv")
    doc.save(str(path))
    doc.close()
    return path


def _image_pdf(path: Path) -> Path:
    raster = path.with_suffix(".png")
    im = Image.new("RGB", (800, 600), (18, 92, 54))
    draw = ImageDraw.Draw(im)
    draw.rectangle((40, 40, 760, 560), outline=(240, 240, 240), width=6)
    draw.ellipse((220, 160, 580, 440), fill=(200, 40, 40))
    im.save(raster)
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=300)
    page.insert_image(page.rect, filename=str(raster))
    doc.save(str(path))
    doc.close()
    return path


def test_classify_thresholds():
    assert classify_page(80, 0) == "live_text"
    assert classify_page(0, 400) == "outlined"
    assert classify_page(20, 399) == "image"
    assert classify_page(50, 10) == "live_text"
    assert classify_page(50, 400) == "outlined"
    assert classify_document(["live_text", "outlined"]) == "mixed"
    assert classify_document(["live_text", "image"]) == "mixed"
    assert classify_document(["outlined", "image"]) == "mixed"


def test_dieline_numbers_are_not_live_chars():
    assert live_char_count("29.35 56 30 186.35") == 0
    assert live_char_count("达肤妍保湿喷雾 30ml") >= 8


def test_live_text_helvetica(tmp_path: Path):
    """带 Helvetica 活字的单页 PDF → live_text。"""
    pdf = _live_text_pdf(tmp_path / "live.pdf")
    result = ingest_pdf(pdf, max_pages=1)
    assert result["mode"] == "live_text"
    assert result["pages"][0]["mode"] == "live_text"
    assert result["live_chars"] >= 80
    assert result["warning"] is None
    assert len(result["warning"] or "") <= 80


def test_outlined_path_drawings(tmp_path: Path):
    """大量 path、几乎无 text object → outlined。刀版数字不算活字。"""
    pdf = _outlined_pdf(tmp_path / "outlined.pdf")
    result = ingest_pdf(pdf, max_pages=1)
    assert result["mode"] == "outlined"
    assert result["pages"][0]["mode"] == "outlined"
    assert result["pages"][0]["live_chars"] < 40
    assert result["drawings"] >= 400
    assert result["warning"] == WARNING_OUTLINED
    assert len(result["warning"]) <= 80


def test_full_page_image(tmp_path: Path):
    """一张大图页 → image。"""
    pdf = _image_pdf(tmp_path / "image.pdf")
    result = ingest_pdf(pdf, max_pages=1)
    assert result["mode"] == "image"
    assert result["pages"][0]["mode"] == "image"
    assert result["pages"][0]["live_chars"] == 0
    assert result["warning"] == WARNING_IMAGE
    assert len(result["warning"]) <= 80


def test_zhuanqu_artwork_is_outlined():
    """工作区审稿台转曲真稿（不 copy 进 git）。"""
    pdfs = _zhuanqu_pdfs()
    if not pdfs:
        pytest.skip("工作区没有 测试/审稿台/**/转曲*.pdf")
    for pdf in pdfs:
        result = ingest_pdf(pdf, max_pages=1)
        assert result["mode"] == "outlined", (
            f"{pdf.name}: mode={result['mode']} "
            f"live_chars={result['live_chars']} drawings={result['drawings']}"
        )
        assert result["pages"][0]["live_chars"] < 40
        assert result["drawings"] >= 400


def test_live_span_maps_inside_png_pixels(tmp_path: Path):
    pdf = _live_text_pdf(tmp_path / "live.pdf")
    metas = render_pdf_pages(pdf, tmp_path / "pages", max_pages=1, quality="high")
    result = ingest_pdf(pdf, metas, max_pages=1)
    assert result["spans"]
    meta = metas[0]
    w, h = int(meta["width"]), int(meta["height"])
    assert w > 0 and h > 0
    for span in result["spans"]:
        assert span["source"] == "pdf_layer"
        assert 0 <= span["left"] < w
        assert 0 <= span["top"] < h
        assert span["left"] + span["width"] <= w
        assert span["top"] + span["height"] <= h
        assert span["width"] >= 1
        assert span["height"] >= 1
        assert span["text"]


def test_mixed_page_sources_keep_live_and_ocr_evidence():
    layer_text = "Live page selectable product name and filing content with enough characters"
    ocr_text = "转曲页文案"
    layer_words = [
        {
            "text": "Live page product name",
            "page": 1,
            "location": {"left": 1, "top": 1, "width": 80, "height": 20},
        }
    ]
    ocr_words = [
        {
            "text": "转曲页文案",
            "page": 2,
            "location": {"left": 2, "top": 2, "width": 90, "height": 20},
        }
    ]
    text, words, source = merge_text_sources(
        layer_text,
        ocr_text,
        layer_words,
        ocr_words,
        prefer_layer=True,
    )
    assert layer_text in text
    assert ocr_text in text
    assert {int(w["page"]) for w in words} == {1, 2}
    assert source == "pdf_text+ocr"


def test_public_ingest_drops_spans_and_layer_text(tmp_path: Path):
    pdf = _live_text_pdf(tmp_path / "live.pdf")
    full = ingest_pdf(pdf, max_pages=1)
    pub = public_ingest(full)
    assert "spans" not in pub
    assert "layer_text" not in pub
    assert "layer_blocks" not in pub
    assert "has_layer" not in pub
    assert set(pub) == {
        "mode",
        "pages",
        "live_chars",
        "drawings",
        "images",
        "warning",
    }


def test_surface_job_emits_ingest_without_spans(tmp_path: Path, monkeypatch, capsys):
    from app import compare_core

    compare_core.init_paths(tmp_path / "data")
    pdf = _live_text_pdf(tmp_path / "live.pdf")
    monkeypatch.setattr(
        compare_core,
        "_ocr_pages",
        lambda _metas, _ingested=None: ("OCR", [], "mock", {}),
    )
    monkeypatch.setattr(
        compare_core,
        "_qrcode_pages",
        lambda _metas: ([], {"status": "empty"}),
    )
    monkeypatch.setattr(compare_core, "verify_fields", lambda *_a, **_k: [])
    result = compare_core._surface_job(
        tid="0123456789ab",
        pdf=pdf,
        pages_subdir="",
        max_pages=1,
        surface_label="花盒",
        fields=[],
        title="活字夹具",
        filename="live.pdf",
    )
    err = capsys.readouterr().err
    assert "STAGE render_pdf" in err
    assert "STAGE ingest" in err
    assert "STAGE layout" in err
    assert "STAGE ocr" in err
    assert "STAGE match" in err
    ingest = result["ingest"]
    assert ingest["mode"] == "live_text"
    assert "spans" not in ingest
    assert ingest["warning"] is None
    assert result["pack_layout"]["regions"]
