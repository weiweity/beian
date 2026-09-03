from __future__ import annotations

import importlib.util
from pathlib import Path

import pymupdf
from PIL import Image

PIPE = Path(__file__).resolve().parents[4] / "workers" / "packaging" / "pipeline.py"


def _load():
    spec = importlib.util.spec_from_file_location("packaging_pipeline", PIPE)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_pipeline_emits_named_stages():
    text = PIPE.read_text(encoding="utf-8")
    assert 'emit_stage("render_pdf")' in text
    assert 'emit_stage("blender")' in text
    assert 'emit_stage("export")' in text


def test_render_pdf_thumbnail_tiny_page_fails(tmp_path):
    pdf = tmp_path / "tiny.pdf"
    doc = pymupdf.open()
    doc.new_page(width=0.5, height=100)
    doc.save(str(pdf))
    doc.close()
    pipe = _load()
    try:
        pipe.render_pdf_thumbnail(pdf, tmp_path / "thumbs", 400)
        raise AssertionError("expected PipelineError")
    except pipe.PipelineError as err:
        assert "页宽" in str(err)


def test_render_pdf_thumbnail_ignores_thin_cropbox(tmp_path):
    pdf = tmp_path / "crop.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=200, height=100)
    page.set_cropbox(pymupdf.Rect(0, 0, 1.1, 100))
    page.insert_text((20, 50), "hi")
    doc.save(str(pdf))
    doc.close()
    pipe = _load()
    out = pipe.render_pdf_thumbnail(pdf, tmp_path / "thumbs", 400)
    with Image.open(out) as im:
        assert im.size[0] == 400
        assert im.size[1] == 200


def test_render_pdf_thumbnail_caps_pixel_budget(tmp_path):
    pdf = tmp_path / "tall.pdf"
    doc = pymupdf.open()
    doc.new_page(width=80, height=4000)
    doc.save(str(pdf))
    doc.close()
    pipe = _load()
    out = pipe.render_pdf_thumbnail(pdf, tmp_path / "thumbs", 8000)
    with Image.open(out) as im:
        assert im.size[0] * im.size[1] <= pipe.MAX_RASTER_PIXELS + 16


def test_render_pdf_thumbnail_uses_pymupdf(tmp_path):
    pdf = tmp_path / "face.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=200, height=100)
    page.insert_text((20, 50), "hi")
    doc.save(str(pdf))
    doc.close()

    pipe = _load()
    out = pipe.render_pdf_thumbnail(pdf, tmp_path / "thumbs", 400)
    assert out.is_file()
    with Image.open(out) as im:
        assert im.size[0] == 400
        assert im.size[1] == 200


def test_write_review_card_caps_longest_edge_and_keeps_alpha(tmp_path):
    pipe = _load()
    source = tmp_path / "front_right_white.png"
    image = Image.new("RGBA", (3000, 3600), (255, 255, 255, 0))
    image.putpixel((10, 10), (117, 35, 46, 255))
    image.save(source)
    dest = tmp_path / "front_right_white_card.png"
    pipe.write_review_card(source, dest, max_edge=1440)
    with Image.open(dest) as card:
        assert max(card.size) == 1440
        assert card.size == (1200, 1440)
        assert "A" in card.getbands()
    ground = tmp_path / "front_right_ground.png"
    image.save(ground)
    job = {
        "outputs": {
            "front_right": str(source),
            "front_right_ground": str(ground),
        }
    }
    pipe.write_review_cards(job)
    assert Path(job["outputs"]["front_right_card"]).name == "front_right_white_card.png"
    assert Path(job["outputs"]["front_right_ground_card"]).name == "front_right_ground_card.png"
    set_still = tmp_path / "front_right_set.png"
    image.save(set_still)
    job["outputs"]["front_right_set"] = str(set_still)
    pipe.write_review_cards(job)
    assert Path(job["outputs"]["front_right_set_card"]).name == "front_right_set_card.png"
    assert "write_review_cards(job)" in PIPE.read_text(encoding="utf-8")


def test_write_review_cards_optional_set_decode_failure_does_not_raise(tmp_path):
    pipe = _load()
    product = tmp_path / "front_right_white.png"
    Image.new("RGB", (8, 8), (255, 255, 255)).save(product)
    bad = tmp_path / "front_right_set.png"
    bad.write_bytes(b"not a png")
    job = {"outputs": {"front_right": str(product), "front_right_set": str(bad)}}
    pipe.write_review_cards(job)
    assert "front_right_card" in job["outputs"]
    assert "front_right_set_card" not in job["outputs"]


def test_write_review_cards_skips_missing_source(tmp_path):
    pipe = _load()
    source = tmp_path / "front_right_white.png"
    Image.new("RGB", (8, 8), (255, 255, 255)).save(source)
    job = {
        "outputs": {
            "front_right": str(source),
            "back_left": str(tmp_path / "gone.png"),
        }
    }
    pipe.write_review_cards(job)
    assert "front_right_card" in job["outputs"]
    assert "back_left_card" not in job["outputs"]
    assert "front_right_ground_card" not in job["outputs"]
