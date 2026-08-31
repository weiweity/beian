from __future__ import annotations

import app.ingredient_lexicon as ingredient_lexicon
from app.ingredient_lexicon import (
    ingredient_reference_metadata,
    ingredient_reference_names,
    lookup_ingredient_reference,
)
from app.ingredient_match import analyze_ingredient_field


def test_controlled_reference_has_versioned_sources_and_no_ambiguous_names():
    metadata = ingredient_reference_metadata()

    assert metadata["available"] is True
    assert metadata["dataset_version"] == "2026-08-19.case-ff89a97a1fe3.v1"
    assert metadata["as_of"] == "2026-08-19"
    assert metadata["retrieved_at"] == "2026-08-31"
    assert metadata["entry_count"] == 21
    assert metadata["ambiguous_name_count"] == 0
    assert {source["id"] for source in metadata["sources"]} >= {
        "nmpa_iecic_i",
        "nmpa_iecic_ii",
    }


def test_reference_resolves_chinese_and_inci_to_the_same_auditable_record():
    chinese = lookup_ingredient_reference("泛醇")
    inci = lookup_ingredient_reference("  panthenol  ")

    assert chinese is not None
    assert inci is not None
    assert chinese["id"] == inci["id"] == "nmpa-i-02292"
    assert chinese["canonical_zh"] == "泛醇"
    assert chinese["inci"] == "PANTHENOL"
    assert chinese["ocr_variants"] == []
    assert chinese["regulatory_status"] == "listed_i_objective_record"
    assert chinese["source_record"] == "02292"
    assert chinese["source"]["as_of"] == "2026-08-19"


def test_reference_lookup_returns_copies_and_keeps_candidate_kinds_explicit():
    first = lookup_ingredient_reference("DNA钠")
    assert first is not None
    first["source"]["title"] = "changed"

    second = lookup_ingredient_reference("DNA 钠")
    assert second is not None
    assert second["source"]["title"] == "《已使用化妆品原料目录》I"
    assert ingredient_reference_names("DNA钠") == [
        {"kind": "canonical_zh", "text": "DNA 钠"},
        {"kind": "inci", "text": "SODIUM DNA"},
    ]


def test_broken_reference_file_degrades_to_direct_ocr_evidence(
    monkeypatch, tmp_path
):
    broken = tmp_path / "broken-reference.json"
    broken.write_text("{not-json", encoding="utf-8")
    ingredient_lexicon._load_catalog.cache_clear()
    monkeypatch.setattr(ingredient_lexicon, "_REFERENCE_PATH", broken)
    words = [
        {
            "text": "成分：水、甘油、泛醇",
            "page": 1,
            "location": {"left": 120, "top": 220, "width": 760, "height": 40},
            "_page_width": 1200,
            "_page_height": 800,
        }
    ]

    try:
        analysis = analyze_ingredient_field("成分：水、甘油、泛醇", words)
    finally:
        ingredient_lexicon._load_catalog.cache_clear()

    assert analysis["hit_atoms"] == ["水", "甘油", "泛醇"]
    assert analysis["miss_atoms"] == []
    assert analysis["reference_dataset"] == {
        "available": False,
        "verdict_policy": "direct_ocr_evidence_only",
    }
    assert all(item["reference"] is None for item in analysis["matches"])
