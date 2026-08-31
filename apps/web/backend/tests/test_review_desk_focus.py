from app import baidu_ocr
from app.compare_core import _apply_qrcode_to_hits
from app.fields import assign_doubt_bucket, field_group, match_field, _primary_compare_text


def test_field_group_mixed_net_barcode():
    assert field_group("净含量&条形码") == "净含量&条形码"
    assert field_group("净含量/条码") == "净含量&条形码"
    assert field_group("条形码") == "条形码"
    assert field_group("净含量") == "净含量"


def test_primary_compare_does_not_fall_back_to_naming_basis():
    text = "1.命名依据：内部代号不可印"
    assert _primary_compare_text("中文品名", text) == ""


def test_chinese_name_remark_does_not_downgrade(monkeypatch):
    words = [{"text": "达肤妍海葡萄油萃微珠保湿喷雾", "page": 1, "location": {"left": 10, "top": 10, "width": 200, "height": 20}}]
    hit = match_field(
        "中文品名",
        "达肤妍海葡萄油萃微珠保湿喷雾",
        words,
        "达肤妍海葡萄油萃微珠保湿喷雾",
        remark="1.命名依据：花盒上要写明备案人商标扫码公众号步骤01步骤02",
    )
    assert hit["status"] == "一致"
    assert "Excel备注" not in (hit.get("evidence") or "")


def test_mixed_net_barcode_one_hit_keeps_30ml():
    words = [
        {"text": "净含量：30ml", "page": 1, "location": {"left": 20, "top": 400, "width": 80, "height": 16}},
        {"text": "6901234567890", "page": 1, "location": {"left": 20, "top": 430, "width": 120, "height": 16}},
    ]
    ocr = "净含量：30ml 6901234567890"
    hit = match_field(
        "净含量&条形码",
        "净含量：30ml\n条形码：6901234567890",
        words,
        ocr,
    )
    assert hit["field"] == "净含量&条形码"
    joined = "".join(str(x) for x in (hit.get("coverage") or {}).get("hit") or []).lower().replace(" ", "")
    assert "30ml" in joined
    assert "6901234567890" in joined
    assert hit["status"] == "一致"
    assert "0/5" not in (hit.get("evidence") or "")


def test_qr_boxes_kept_without_payload_and_do_not_overwrite_guide_bbox():
    original = {"page": 1, "left": 12, "top": 14, "width": 100, "height": 24}
    result = _apply_qrcode_to_hits(
        [
            {
                "field": "二维码",
                "field_group": "二维码",
                "status": "疑点",
                "bboxes": [original],
            }
        ],
        [{"text": "", "page": 1, "location": {"left": 800, "top": 300, "width": 180, "height": 180}}],
        {"status": "empty"},
    )[0]
    assert result["status"] == "疑点"
    assert result["bboxes"] == [original]
    assert result["qrcode_boxes"][0]["left"] == 800


def test_qr_only_box_moves_hit_to_the_detected_page():
    result = _apply_qrcode_to_hits(
        [{"field": "二维码", "field_group": "二维码", "status": "疑点", "bboxes": [], "page": 1}],
        [{"text": "", "page": 2, "location": {"left": 80, "top": 30, "width": 18, "height": 18}}],
        {"status": "empty"},
    )[0]
    assert result["page"] == 2
    assert result["qrcode_boxes"][0]["page"] == 2


def test_baidu_qr_parser_keeps_vertex_box_without_decoded_text(monkeypatch):
    body = {
        "codes_result": [
            {
                "text": "",
                "vertexes_location": [
                    {"x": 10, "y": 20},
                    {"x": 50, "y": 20},
                    {"x": 50, "y": 70},
                    {"x": 10, "y": 70},
                ],
            }
        ]
    }

    class Response:
        content = b"{}"

        def json(self):
            return body

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, *args, **kwargs):
            return Response()

    monkeypatch.setattr(baidu_ocr, "load_baidu_env", lambda: {"BAIDU_OCR_API_KEY": "ak", "BAIDU_OCR_SECRET_KEY": "sk"})
    monkeypatch.setattr(baidu_ocr, "get_access_token", lambda *_args, **_kwargs: "token")
    monkeypatch.setattr(baidu_ocr.httpx, "Client", Client)

    codes, _meta = baidu_ocr.qrcode_image_bytes(b"synthetic")
    assert codes == [{"text": "", "location": {"left": 10, "top": 20, "width": 40, "height": 50}}]


def test_mixed_net_barcode_partial_or_empty_stays_doubt():
    excel = "净含量：30ml\n条形码：6901234567890"
    net = match_field(
        "净含量&条形码",
        excel,
        [{"text": "净含量：30ml", "page": 1, "location": {"left": 20, "top": 400, "width": 80, "height": 16}}],
        "净含量：30ml",
    )
    bar = match_field(
        "净含量&条形码",
        excel,
        [{"text": "6901234567890", "page": 1, "location": {"left": 20, "top": 430, "width": 120, "height": 16}}],
        "6901234567890",
    )
    empty = match_field("净含量&条形码", excel, [], "")
    long_excel = "净含量：30ml（单片装）\n净含量：150ml（5片装）\n条形码：6901234567890\n条形码：6901234567891\n备注：" + ("规格说明" * 8)
    long_net_only = match_field(
        "净含量&条形码",
        long_excel,
        [{"text": "净含量：30ml", "page": 1, "location": {"left": 20, "top": 400, "width": 80, "height": 16}}],
        "净含量：30ml",
    )
    assert net["status"] == "疑点"
    assert bar["status"] == "疑点"
    assert empty["status"] == "疑点"
    assert long_net_only["status"] == "疑点"
    assert "30ml" in "".join(str(x) for x in (net.get("coverage") or {}).get("hit") or []).lower().replace(" ", "")
    parts = (net.get("coverage") or {}).get("parts") or {}
    assert parts.get("barcode", {}).get("coverage", 1) < 0.99


def test_smallprint_and_graphic_buckets_stay_doubts():
    small = assign_doubt_bucket(
        {
            "status": "疑点",
            "field": "文案",
            "field_group": "文案",
            "excel_value": "本产品采用的材料来自良好管理的森林",
            "coverage": {"miss_phrases": ["本产品采用的材料来自良好管理的"]},
        }
    )
    graphic = assign_doubt_bucket(
        {
            "status": "疑点",
            "field": "文案",
            "field_group": "文案",
            "excel_value": "09",
            "coverage": {"miss_phrases": ["09"]},
        }
    )
    assert small == "ocr_smallprint"
    assert graphic == "ocr_graphic"
    copy_miss = assign_doubt_bucket(
        {
            "status": "疑点",
            "field": "文案",
            "field_group": "文案",
            "excel_value": "保湿亮泽水润修护",
            "coverage": {"miss_phrases": ["保湿", "亮泽", "水润"]},
        }
    )
    assert copy_miss == "coverage"
