from __future__ import annotations

from app.evidence_locate import locate_dual_evidence
from app.fields import _dedupe_miss_phrases, match_field


def _word(text: str, left: int, top: int = 160) -> dict:
    return {
        "text": text,
        "page": 1,
        "location": {"left": left, "top": top, "width": max(60, len(text) * 18), "height": 32},
    }


def test_copy_location_uses_current_coverage_phrases_not_brand_dictionary():
    boxes = locate_dual_evidence(
        field_group="文案",
        field="文案",
        excel_value="舒缓干燥 保持水润",
        primary_query="舒缓干燥",
        ocr_words=[_word("舒缓干燥", 120), _word("保持水润", 360)],
        hit_phrases=["舒缓干燥", "保持水润"],
    )

    assert len(boxes) == 2
    assert {box["label"] for box in boxes} == {"舒缓干燥", "保持水润"}


def test_unrelated_old_product_words_do_not_create_copy_boxes():
    boxes = locate_dual_evidence(
        field_group="文案",
        field="文案",
        excel_value="全新卖点",
        primary_query="全新卖点",
        ocr_words=[_word("BRIGHTENING VITALIZING ESSENCE MASK", 100)],
        hit_phrases=[],
        miss_phrases=["全新卖点"],
    )

    assert boxes == []


def test_production_information_uses_actual_hit_phrase_at_any_panel_position():
    boxes = locate_dual_evidence(
        field_group="生产信息",
        field="生产商信息",
        excel_value="上海伸美化妆品股份有限公司",
        primary_query="上海伸美化妆品股份有限公司",
        ocr_words=[_word("上海伸美化妆品股份有限公司", 80, 900)],
        hit_phrases=["上海伸美化妆品股份有限公司"],
    )

    assert boxes
    assert boxes[0]["left"] < 200


def test_duplicate_phrase_locations_are_deduped_and_hit_boxes_are_capped():
    phrases = [f"卖点文案{i}" for i in range(12)]
    words = [_word(phrase, 100 + index * 40, 120 + index * 60) for index, phrase in enumerate(phrases)]
    # 同一坐标的重复 OCR 词不能制造多个视觉框。
    words.append(_word(phrases[0], 100, 120))

    boxes = locate_dual_evidence(
        field_group="文案",
        field="文案",
        excel_value="\n".join(phrases),
        primary_query=phrases[0],
        ocr_words=words,
        hit_phrases=[phrases[0], phrases[0], *phrases[1:]],
    )

    hit_boxes = [box for box in boxes if box.get("role") in (None, "hit")]
    assert len(hit_boxes) == 8
    assert len({(box["page"], box["left"], box["top"]) for box in hit_boxes}) == 8


def test_nested_missing_phrases_keep_only_the_complete_statement():
    assert _dedupe_miss_phrases(
        [
            "无其他含义",
            "产品包装上的卡通图案仅为美观设计，无其他含义",
            "无其他含义",
        ]
    ) == ["产品包装上的卡通图案仅为美观设计，无其他含义"]


def test_match_field_reports_long_production_information_as_structured_coverage():
    excel = "\n".join(
        [
            "备案人：上海伸美化妆品股份有限公司",
            "地址：上海市松江区某某路88号",
            "生产企业：杭州示例有限公司",
            "产地：浙江省杭州市",
        ]
    )
    words = [
        _word("备案人：上海伸美化妆品股份有限公司", 100, 100),
        _word("生产企业：杭州示例有限公司", 100, 300),
    ]

    hit = match_field("生产商信息", excel, words, " ".join(word["text"] for word in words))

    assert hit["status"] == "疑点"
    assert hit["long_field"] is True
    assert hit["match_mode"] == "block_coverage"
    assert hit["coverage"] == {
        "ratio": 0.5,
        "matched": 2,
        "total": 4,
        "miss": ["地址：上海市松江区某某路88号", "产地：浙江省杭州市"],
        "hit": ["备案人：上海伸美化妆品股份有限公司", "生产企业：杭州示例有限公司"],
    }
    assert any(box.get("role") == "hit" for box in hit["bboxes"])
