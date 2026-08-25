from app.fields import _keep_same_panel, compare_fields, match_field
from app.pack_profile import infer_pack_profile, parse_spec_keys, required_barcodes


def test_spec_keys_use_sku_label_not_formula_ml():
    keys = parse_spec_keys(
        excel_net="30ml装：（2ml+28ml）\n50ml装：（4ml+46ml）",
        excel_barcode="30ml装：12345678\n50ml装：87654321",
    )
    assert keys["30ml装"] == ["12345678"]
    assert keys["50ml装"] == ["87654321"]
    assert "2ml装" not in keys


def test_spec_keys_accept_piece_pack_labels():
    keys = parse_spec_keys(
        excel_barcode="5片装：1234567890123\n单片装：1111111111111",
        excel_net="5片装：（2ml+28ml）×5\n单片装：（2ml+28ml）",
    )
    assert keys.get("5") == ["1234567890123"]
    assert keys.get("1") == ["1111111111111"]
    assert "2ml装" not in keys


def test_required_barcodes_one_hit_for_active_sku():
    profile = {"active_spec": "30ml装", "codes_on_pack": ["12345678"]}
    must, ign = required_barcodes(
        "30ml装：12345678\n50ml装：87654321",
        profile,
        excel_net="30ml装 / 50ml装",
    )
    assert must == ["12345678"]
    assert "87654321" in ign


def test_required_barcodes_star_one_hit():
    must, ign = required_barcodes(
        "12345678\n87654321",
        {"active_spec": "30ml装", "codes_on_pack": ["12345678"]},
    )
    assert must == ["12345678"]
    assert "87654321" in ign


def test_required_barcodes_unmatched_ml_falls_back_to_piece():
    must, ign = required_barcodes(
        "5片：12345678\n1片：11111111",
        {"active_spec": "30ml装", "active_pieces": ["5"], "ignore_piece_codes": ["1"]},
    )
    assert must == ["12345678"]
    assert "11111111" in ign
    assert "12345678" not in ign


def test_unmatched_ml_keys_do_not_self_prove():
    must, ign = required_barcodes(
        "30ml装：12345678\n50ml装：87654321",
        {"active_spec": "5", "active_pieces": ["5"], "codes_on_pack": ["87654321"]},
    )
    assert must == []
    assert "87654321" in ign
    assert "12345678" in ign


def test_pouch_piece_spec_uses_single():
    must, ign = required_barcodes(
        "5片：12345678\n1片：11111111",
        {"active_spec": "1", "active_pieces": ["1"], "ignore_piece_codes": ["5"]},
    )
    assert must == ["11111111"]
    assert "12345678" in ign


def test_formula_ml_does_not_become_sku_key():
    p = infer_pack_profile(
        title="达肤妍花盒",
        filename="carton.ai",
        ocr_text="30ml装 净含量：（2ml+28ml）/片 条码1234567890123",
        excel_net_content="30ml装：（2ml+28ml）\n50ml装：（4ml+46ml）",
        excel_barcode="30ml装：1234567890123\n50ml装：1111111111111",
    )
    assert p.get("active_spec") == "30ml装"
    assert p.get("active_spec") not in ("2ml装", "28ml装")


def test_ocr_without_ml_pack_falls_back_to_piece():
    p = infer_pack_profile(
        title="达肤妍花盒",
        filename="carton.ai",
        ocr_text="净含量：（2ml+28ml）/片 ×5  条码1234567890123",
        excel_net_content="5片装：（2ml+28ml）×5\n单片装：（2ml+28ml）",
        excel_barcode="5片：1234567890123\n1片：1111111111111",
    )
    assert p.get("active_spec") != "2ml装"
    assert p.get("active_piece") == "5" or p.get("active_spec") == "5"


def test_barcode_one_must_hit_clears_miss():
    profile = {"active_spec": "30ml装"}
    excel = "30ml装：12345678\n30ml装：87654321\n50ml装：11111111"
    hits = compare_fields(
        [{"field": "条形码", "excel_value": excel}],
        [],
        "包装 30ml装 12345678",
        pack_profile=profile,
    )
    h = hits[0]
    assert h["status"] == "一致"
    assert h["coverage"]["miss"] == []
    assert "12345678" in (h["coverage"].get("hit") or [])


def test_barcode_no_must_hit_is_doubt():
    hits = compare_fields(
        [{"field": "条形码", "excel_value": "30ml装：12345678\n50ml装：11111111"}],
        [],
        "包装上没有这些码",
        pack_profile={"active_spec": "30ml装"},
    )
    assert hits[0]["status"] in ("疑点", "缺失")
    assert "12345678" in (hits[0]["coverage"].get("miss") or [])


def test_net_content_focuses_active_ml_sku():
    excel = "30ml装：（2ml+28ml）\n50ml装：（4ml+46ml）"
    h = match_field(
        "净含量",
        excel,
        [],
        "净含量 30ml装：（2ml+28ml）",
        pack_profile={"active_spec": "30ml装", "active_piece": "5"},
    )
    miss = (h.get("coverage") or {}).get("miss") or (h.get("coverage") or {}).get("miss_phrases") or []
    assert not any("50ml" in str(x) for x in miss)


def test_net_content_ml_spec_is_not_a_substring():
    excel = "30ml装：（2ml+28ml）\n130ml装：（10ml+120ml）"
    h = match_field(
        "净含量",
        excel,
        [],
        "净含量 30ml装：（2ml+28ml）",
        pack_profile={"active_spec": "30ml装"},
    )
    miss = (h.get("coverage") or {}).get("miss") or (h.get("coverage") or {}).get("miss_phrases") or []
    assert not any("130ml" in str(x) for x in miss)
    h8 = match_field(
        "净含量",
        "8ml装：8ml\n单片：（2ml+28ml）",
        [],
        "净含量 8ml装 8ml",
        pack_profile={"active_spec": "8ml装"},
    )
    miss8 = (h8.get("coverage") or {}).get("miss") or (h8.get("coverage") or {}).get("miss_phrases") or []
    assert not any("28ml" in str(x) for x in miss8)


def test_keep_same_panel_drops_far_board():
    left = {"page": 1, "left": 10, "top": 10, "width": 40, "height": 20}
    right = {"page": 1, "left": 400, "top": 10, "width": 40, "height": 20}
    kept = _keep_same_panel([left, right], gap=120)
    assert kept in ([left], [right])
    assert len(kept) == 1


def test_keep_same_panel_keeps_larger_cluster():
    a = {"page": 1, "left": 10, "width": 40, "top": 10, "height": 20}
    b = {"page": 1, "left": 60, "width": 40, "top": 10, "height": 20}
    c = {"page": 1, "left": 110, "width": 40, "top": 10, "height": 20}
    far = {"page": 1, "left": 400, "width": 40, "top": 10, "height": 20}
    kept = _keep_same_panel([a, far, b, c], gap=120)
    assert kept == [a, b, c]


def test_keep_same_panel_splits_pages():
    a = {"page": 1, "left": 10, "width": 40, "top": 10, "height": 20}
    b = {"page": 2, "left": 12, "width": 40, "top": 10, "height": 20}
    kept = _keep_same_panel([a, b], gap=120)
    assert kept in ([a], [b])
    assert len(kept) == 1
