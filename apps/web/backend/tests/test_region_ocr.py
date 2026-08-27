from app.region_ocr import recognize_pages
from app.text_verify import ENGINE_FEATURES, ENGINE_VERSION


def test_live_text_skips_ocr():
    calls = {"n": 0}

    def boom(_data: bytes):
        calls["n"] += 1
        raise AssertionError("live_text 不应调用 OCR")

    text, words, tag, meta = recognize_pages(
        [{"path": "/nope.png", "page": 1, "width": 10, "height": 10}],
        {"mode": "live_text", "pages": [{"page": 1, "mode": "live_text"}]},
        ocr_fn=boom,
    )
    assert calls["n"] == 0
    assert words == []
    assert tag == "pdf_layer"
    assert meta["skipped"] is True
    assert meta["union"] is False
    assert "baidu" not in "".join(meta.get("engines") or [])


def test_outlined_runs_single_engine_once_per_page(tmp_path):
    img = tmp_path / "p.png"
    img.write_bytes(b"x")
    calls = {"n": 0}

    def fake(_data: bytes):
        calls["n"] += 1
        return (
            "hello",
            [{"text": "hello", "location": {"left": 1, "top": 1, "width": 10, "height": 8}}],
            {"api": "accurate"},
        )

    _t, words, tag, meta = recognize_pages(
        [{"path": str(img), "page": 1, "width": 20, "height": 20}],
        {"mode": "outlined", "pages": [{"page": 1, "mode": "outlined"}]},
        ocr_fn=fake,
    )
    assert calls["n"] == 1
    assert len(words) == 1
    assert meta["union"] is False
    assert meta.get("zone_boost", {}).get("pages") == 0
    assert meta.get("paddle_vl", {}).get("enabled") is False
    assert tag.startswith("baidu:")


def test_no_engine_union_in_source():
    from pathlib import Path

    core = (Path(__file__).resolve().parents[1] / "app" / "compare_core.py").read_text(
        encoding="utf-8"
    )
    assert "ocr_zone_boost" not in core
    assert "recognize_pages" in core
    assert "paddle_vl" not in core
    assert "boost_page_ocr" not in core
    ocr = (Path(__file__).resolve().parents[1] / "app" / "region_ocr.py").read_text(
        encoding="utf-8"
    )
    assert "zone_boost" in ocr  # 诊断字段写 0
    assert "boost_page_ocr" not in ocr


def test_engine_contract_matches_single_engine_pipeline():
    assert ENGINE_VERSION == "tvt-lite-2.0"
    assert {
        "pdf_ingest_classification",
        "page_source_routing",
        "live_text_no_ocr",
        "single_ocr_engine",
    } <= set(ENGINE_FEATURES)
    assert {
        "ocr_line_merge",
        "ocr_zone_boost",
        "paddle_ocr_vl",
        "ocr_ensemble_crosscheck",
        "zone_crop_reocr",
    }.isdisjoint(ENGINE_FEATURES)
