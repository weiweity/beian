from __future__ import annotations

from app.compare_core import _apply_qrcode_to_hits
from app.evidence_locate import locate_dual_evidence
from app.fields import match_field
from app.qr_evidence import matched_qr_guide


def _word(text: str, left: int = 120) -> dict:
    return {
        "text": text,
        "page": 1,
        "location": {"left": left, "top": 220, "width": 260, "height": 36},
    }


def test_full_wechat_guide_is_the_only_field_semantics():
    assert matched_qr_guide("扫码 关注 微信工作号") == "扫码关注微信工作号"
    assert matched_qr_guide("扫一扫关注微信公众号") == "扫一扫关注微信公众号"
    assert matched_qr_guide("这里有微信和二维码") is None

    hit = match_field(
        "二维码",
        "扫码关注微信工作号",
        [_word("扫码关注微信工作号")],
        "扫码关注微信工作号",
    )
    assert hit["status"] == "一致"
    assert hit["coverage"]["hit"] == ["扫码关注微信工作号"]
    assert hit["bboxes"][0]["label"] == "扫码关注引导语"
    assert hit["bboxes"][0]["left"] <= 120


def test_weak_wechat_words_do_not_create_a_fake_location():
    words = [_word("微信"), _word("10", 900)]
    hit = match_field("二维码", "扫码关注微信工作号", words, "微信 10")
    boxes = locate_dual_evidence(
        field_group="二维码",
        field="二维码",
        excel_value="扫码关注微信工作号",
        primary_query="扫码关注微信工作号",
        ocr_words=words,
        miss_phrases=["扫码关注微信工作号"],
    )
    assert hit["status"] == "疑点"
    assert hit["bboxes"] == []
    assert boxes == []


def test_decoded_qr_payload_never_overwrites_guide_result_or_bbox():
    original_box = {"page": 1, "left": 12, "top": 14, "width": 100, "height": 24}
    hits = [
        {
            "field": "二维码",
            "field_group": "二维码",
            "status": "缺失",
            "score": 40.0,
            "bboxes": [original_box],
            "evidence": "未见完整引导语",
        }
    ]
    result = _apply_qrcode_to_hits(
        hits,
        [
            {
                "text": "https://example.test",
                "page": 1,
                "location": {"left": 800, "top": 300, "width": 180, "height": 180},
            }
        ],
        {"status": "ok"},
    )[0]

    assert result["status"] == "缺失"
    assert result["score"] == 40.0
    assert result["bboxes"] == [original_box]
    assert result["qrcode_values"] == ["https://example.test"]
    assert result["qrcode_boxes"][0]["left"] == 800
