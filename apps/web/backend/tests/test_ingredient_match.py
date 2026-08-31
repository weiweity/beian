from __future__ import annotations

from app.compare_core import _attach_page_size
from app.fields import match_field
from app.ingredient_match import analyze_ingredient_field, parse_ingredient_atoms


INGREDIENT_VALUE = (
    "成分：乳酸杆菌发酵产物、甘油、水、辛酸/癸酸/琥珀酸甘油三酯、1,2-己二醇、"
    "对羟基苯乙酮、辛酸/癸酸甘油三酯、泛醇、蓖麻油/IPDI 共聚物、"
    "毛瑞榈（MAURITIA FLEXUOSA）果油、角鲨烷\n\n"
    "其他微量成分：糖类同分异构体、长茎葡萄蕨藻（CAULERPA LENTILLIFERA）提取物、"
    "愈创薁、DNA 钠、结冷胶、柠檬酸钠、黄原胶、氯化钙、"
    "季戊四醇四（双-叔丁基羟基氢化肉桂酸）酯、柠檬酸"
)


def _word(text: str, left: int, top: int, width: int, height: int = 42) -> dict:
    return {
        "text": text,
        "page": 1,
        "location": {"left": left, "top": top, "width": width, "height": height},
        "_page_width": 5600,
        "_page_height": 3210,
    }


def _review_words() -> list[dict]:
    return [
        _word(
            "成分：乳酸杆菌发酵产物、甘油、水、辛酸/癸酸/琥珀酸甘油三酯、1,2-己二醇、",
            260,
            620,
            1580,
        ),
        _word(
            "对羟基苯乙酮、辛酸/癸酸甘油三酯、泛醇、蓖麻油/IPDI 共聚物、",
            260,
            676,
            1480,
        ),
        _word(
            "毛瑞榈（MAURITIA FLEXUOSA）果油、角鲨烷",
            260,
            732,
            1160,
        ),
        _word(
            "其他微量成分：糖类同分异构体、长茎葡萄蕨藻（CAULERPA LENTILLIFERA）提取物、",
            260,
            812,
            1680,
        ),
        _word("愈创薁、DNA 钠、结冷胶、柠檬酸钠、黄原胶、氯化钙、", 260, 868, 1300),
        _word("季戊四醇四（双-叔丁基羟基氢化肉桂酸）酯、柠檬酸", 260, 924, 1420),
        # 右侧工程信息表：旧定位器会因“无步骤锚点 → 默认右半页”把这些长词全部吞入。
        _word("刀模尺寸：展开图版本", 3260, 184, 620),
        _word("版本号：V6 更新时间：2026-08-30", 3260, 246, 760),
        _word("设计部联系人：张三 电话：13800000000", 3260, 308, 820),
        _word("工艺说明：局部烫金、覆膜", 3260, 370, 700),
    ]


def test_ingredient_atoms_keep_slashes_decimal_commas_hyphens_and_latin_names():
    atoms = parse_ingredient_atoms(INGREDIENT_VALUE)

    assert len(atoms) == 21
    assert "辛酸/癸酸/琥珀酸甘油三酯" in atoms
    assert "1,2-己二醇" in atoms
    assert "蓖麻油/IPDI 共聚物" in atoms
    assert "毛瑞榈（MAURITIA FLEXUOSA）果油" in atoms
    assert "IPDI 共聚物" not in atoms
    assert "2-己二醇" not in atoms
    assert "蓖麻油" not in atoms


def test_legacy_commas_split_atoms_but_keep_numeric_locants():
    atoms = parse_ingredient_atoms(
        "成分：水，甘油,1, 2-己二醇，2，3-丁二醇、蓖麻油/IPDI 共聚物"
    )

    assert atoms == [
        "水",
        "甘油",
        "1, 2-己二醇",
        "2，3-丁二醇",
        "蓖麻油/IPDI 共聚物",
    ]


def test_legacy_comma_list_reports_a_missing_atom_instead_of_matching_the_whole_line():
    expected = "成分：水，甘油，丁二醇，角鲨烷，泛醇，黄原胶，氯化钙"
    ocr = "成分：水，甘油，丁二醇，角鲨烷，黄原胶，氯化钙"
    words = [_word(ocr, 260, 620, 1520)]

    hit = match_field(
        "化妆品成分表",
        expected,
        words,
        ocr,
        locate_words=words,
    )

    assert hit["coverage"]["total"] == 7
    assert hit["coverage"]["matched"] == 6
    assert hit["coverage"]["miss"] == ["泛醇"]
    assert hit["status"] != "一致"


def test_numeric_locant_accepts_ocr_one_as_lowercase_l_without_splitting_the_comma():
    expected = "成分：1,2-己二醇、甘油"
    words = [_word("成分：l,2-己二醇、甘油", 260, 620, 820)]

    analysis = analyze_ingredient_field(expected, words)

    assert analysis["hit_atoms"] == ["1,2-己二醇", "甘油"]
    locant = next(item for item in analysis["matches"] if item["atom"] == "1,2-己二醇")
    assert locant["matched"] is True
    assert locant["matched_text"] == "l,2-己二醇"


def test_reference_inci_is_explained_but_cannot_auto_accept_a_missing_chinese_name():
    expected = "成分：泛醇、甘油"
    words = [_word("成分：PANTHENOL、甘油", 260, 620, 860)]

    hit = match_field(
        "化妆品成分表",
        expected,
        words,
        words[0]["text"],
        locate_words=words,
    )

    assert hit["coverage"]["matched"] == 1
    assert hit["coverage"]["miss"] == ["泛醇"]
    assert hit["status"] != "一致"
    panthenol = next(
        item for item in hit["ingredient_matches"] if item["atom"] == "泛醇"
    )
    assert panthenol["matched"] is False
    assert panthenol["mode"] == "none"
    assert panthenol["reference"]["inci"] == "PANTHENOL"
    assert panthenol["reference_candidate"] == {
        "matched_text": "PANTHENOL",
        "reference_name": "PANTHENOL",
        "reference_kind": "inci",
        "score": 100.0,
        "source_bbox": {
            "page": 1,
            "left": 258,
            "top": 618,
            "width": 864,
            "height": 46,
        },
        "verdict_effect": "none",
    }
    assert hit["ingredient_reference_dataset"]["as_of"] == "2026-08-19"


def test_ingredient_bbox_anchors_to_body_block_and_excludes_engineering_table():
    words = _review_words()
    hit = match_field(
        "化妆品成分表",
        INGREDIENT_VALUE,
        words,
        "\n".join(word["text"] for word in words),
        locate_words=words,
    )

    assert hit["coverage"]["total"] == 21
    assert hit["coverage"]["matched"] == 21
    assert hit["coverage"]["miss"] == []
    assert [item["atom"] for item in hit["ingredient_matches"]] == hit["ingredient_atoms"]
    assert all(item["matched"] for item in hit["ingredient_matches"])
    assert hit["ingredient_locate_mode"] == "label_anchor"
    assert hit["bboxes"]
    block = next(box for box in hit["bboxes"] if box.get("role") == "hit")
    assert block["left"] < 500
    assert block["left"] + block["width"] < 2400
    assert 560 <= block["top"] <= 650
    assert block["top"] + block["height"] < 1100
    assert 0 <= block["left"] < 5600
    assert 0 < block["left"] + block["width"] <= 5600
    assert 0 <= block["top"] < 3210
    assert 0 < block["top"] + block["height"] <= 3210
    anchor = hit["ingredient_anchor"]
    assert block["left"] <= anchor["x"] <= block["left"] + block["width"]
    assert block["top"] <= anchor["y"] <= block["top"] + block["height"]


def test_ingredient_without_anchor_fails_closed_instead_of_guessing_right_half():
    words = [
        _word("版本号：V6 更新时间：2026-08-30", 3260, 246, 760),
        _word("设计部联系人：张三 电话：13800000000", 3260, 308, 820),
        _word("工艺说明：局部烫金、覆膜", 3260, 370, 700),
    ]
    hit = match_field(
        "化妆品成分表",
        INGREDIENT_VALUE,
        words,
        "\n".join(word["text"] for word in words),
        locate_words=words,
    )

    assert hit["bboxes"] == []
    assert hit["no_bbox"] is True


def test_fuzzy_match_keeps_full_atom_and_short_atoms_require_exact_segments():
    expected = "成分：甘油、蓖麻油/IPDI 共聚物、柠檬酸、柠檬酸钠"
    words = [
        _word(
            # IPDI 的 I 被 OCR 读成小写 l；甘油只存在于“甘油三酯”，柠檬酸只存在于“柠檬酸钠”。
            "成分：辛酸/癸酸甘油三酯、蓖麻油/IPDl 共聚物、柠檬酸钠",
            260,
            620,
            1520,
        )
    ]
    analysis = analyze_ingredient_field(expected, words)

    assert analysis["hit_atoms"] == ["蓖麻油/IPDI 共聚物", "柠檬酸钠"]
    assert analysis["miss_atoms"] == ["甘油", "柠檬酸"]
    compound = next(
        item for item in analysis["matches"] if item["atom"] == "蓖麻油/IPDI 共聚物"
    )
    assert compound["matched"] is True
    assert compound["mode"] == "edit_distance"
    assert compound["matched_text"] == "蓖麻油/IPDl 共聚物"

    hit = match_field(
        "化妆品成分表",
        expected,
        words,
        words[0]["text"],
        locate_words=words,
    )
    assert hit["ingredient_fuzzy_atoms"] == ["蓖麻油/IPDI 共聚物"]
    assert hit["status"] == "疑点"


def test_long_atom_allows_at_most_two_equal_length_ocr_edits():
    expected = "成分：长茎葡萄蕨藻（CAULERPA LENTILLIFERA）提取物、甘油"
    two_edits = [_word("成分：长茎葡萄蕨澡（CAULERPA LENTILLIFERB）提取物、甘油", 260, 620, 1540)]
    three_edits = [_word("成分：长茎葡萄蕨澡（CAULERPA LENTILLIFERB）提取勿、甘油", 260, 620, 1540)]

    accepted = analyze_ingredient_field(expected, two_edits)
    rejected = analyze_ingredient_field(expected, three_edits)

    long_match = accepted["matches"][0]
    assert long_match["matched"] is True
    assert long_match["mode"] == "edit_distance"
    assert rejected["hit_atoms"] == ["甘油"]
    assert rejected["miss_atoms"] == [
        "长茎葡萄蕨藻（CAULERPA LENTILLIFERA）提取物"
    ]


def test_semantic_alias_cannot_hide_a_different_ingredient_name():
    expected = "成分：氢化卵磷脂、甘油"
    words = [_word("成分：卵磷脂、甘油", 260, 620, 820)]

    hit = match_field(
        "化妆品成分表",
        expected,
        words,
        words[0]["text"],
        locate_words=words,
    )

    assert hit["coverage"]["hit"] == ["甘油"]
    assert hit["coverage"]["miss"] == ["氢化卵磷脂"]
    assert hit["status"] != "一致"


def test_parenthetical_latin_name_is_part_of_the_same_required_atom():
    expected = "成分：毛瑞榈（MAURITIA FLEXUOSA）果油、甘油"
    words = [_word("成分：毛瑞榈果油、甘油", 260, 620, 920)]

    analysis = analyze_ingredient_field(expected, words)

    assert analysis["hit_atoms"] == ["甘油"]
    assert analysis["miss_atoms"] == ["毛瑞榈（MAURITIA FLEXUOSA）果油"]


def test_fuzzy_match_cannot_drop_or_add_a_chemical_modifier():
    expected = "成分：透明质酸钠、甘油"

    for actual in ("成分：透明质酸、甘油", "成分：乙酰化透明质酸钠、甘油"):
        words = [_word(actual, 260, 620, 920)]
        analysis = analyze_ingredient_field(expected, words)

        assert analysis["hit_atoms"] == ["甘油"]
        assert analysis["miss_atoms"] == ["透明质酸钠"]


def test_long_atom_can_match_across_an_ocr_visual_line_wrap():
    expected = "成分：季戊四醇四（双-叔丁基羟基氢化肉桂酸）酯、甘油"
    words = [
        _word("成分：季戊四醇四（双-叔丁基羟基", 260, 620, 1120),
        _word("氢化肉桂酸）酯、甘油", 260, 676, 920),
    ]

    analysis = analyze_ingredient_field(expected, words)

    assert analysis["hit_atoms"] == [
        "季戊四醇四（双-叔丁基羟基氢化肉桂酸）酯",
        "甘油",
    ]
    compound = analysis["matches"][0]
    assert compound["source_bbox"]["top"] < 620
    assert compound["source_bbox"]["height"] > 90


def test_cross_line_join_cannot_reuse_the_same_ocr_evidence_for_a_shorter_atom():
    expected = "成分：柠檬酸钠、柠檬酸、甘油"
    words = [
        _word("成分：柠檬酸", 260, 620, 560),
        _word("钠、甘油", 260, 676, 520),
    ]

    analysis = analyze_ingredient_field(expected, words)

    assert analysis["hit_atoms"] == ["柠檬酸钠", "甘油"]
    assert analysis["miss_atoms"] == ["柠檬酸"]


def test_step_specific_field_cannot_borrow_atoms_from_another_step():
    expected = "步骤01：成分：水、甘油、泛醇"
    words = [
        _word("步骤01：成分：水、甘油", 260, 620, 880),
        _word("步骤02：成分：水、甘油、泛醇", 260, 760, 980),
    ]

    hit = match_field(
        "成分表 · 步骤01：水、甘油、泛醇",
        expected,
        words,
        "\n".join(word["text"] for word in words),
        locate_words=words,
    )

    assert hit["coverage"]["hit"] == ["水", "甘油"]
    assert hit["coverage"]["miss"] == ["泛醇"]
    assert hit["status"] != "一致"
    assert hit["ingredient_locate_mode"] == "label_anchor"
    assert max(box["top"] + box["height"] for box in hit["bboxes"]) < 730


def test_target_step_missing_from_ocr_fails_closed():
    expected = "步骤01：成分：水、甘油、泛醇"
    words = [_word("步骤02：成分：水、甘油、泛醇", 260, 760, 980)]

    analysis = analyze_ingredient_field(expected, words)

    assert analysis["hit_atoms"] == []
    assert analysis["block_bbox"] is None


def test_atom_dense_fallback_locates_body_when_only_the_label_is_lost_by_ocr():
    words = [
        _word("乳酸杆菌发酵产物、甘油、水、辛酸/癸酸/琥珀酸甘油三酯", 260, 620, 1500),
        _word("1,2-己二醇、对羟基苯乙酮、辛酸/癸酸甘油三酯", 260, 676, 1360),
    ]
    analysis = analyze_ingredient_field(INGREDIENT_VALUE, words)

    assert analysis["locate_mode"] == "atom_dense_fallback"
    assert len(analysis["hit_atoms"]) >= 6
    assert analysis["block_bbox"]["left"] < 500
    assert analysis["block_bbox"]["left"] + analysis["block_bbox"]["width"] < 2400


def test_unusable_weak_anchor_does_not_disable_atom_dense_fallback():
    words = [
        _word("化妆品成分表", 3260, 184, 620),
        _word("乳酸杆菌发酵产物、甘油、水、辛酸/癸酸/琥珀酸甘油三酯", 260, 620, 1500),
        _word("1,2-己二醇、对羟基苯乙酮、辛酸/癸酸甘油三酯", 260, 676, 1360),
    ]

    analysis = analyze_ingredient_field(INGREDIENT_VALUE, words)

    assert analysis["locate_mode"] == "atom_dense_fallback"
    assert len(analysis["hit_atoms"]) >= 6
    assert analysis["block_bbox"]["left"] < 500


def test_weak_anchor_with_one_incidental_atom_still_yields_to_dense_body():
    expected = "成分：水、甘油、泛醇"
    words = [
        _word("化妆品成分表", 3260, 184, 620),
        _word("水", 3260, 240, 180),
        _word("水、甘油、泛醇", 260, 620, 860),
    ]

    analysis = analyze_ingredient_field(expected, words)

    assert analysis["locate_mode"] == "atom_dense_fallback"
    assert analysis["hit_atoms"] == ["水", "甘油", "泛醇"]
    assert analysis["block_bbox"]["left"] < 500


def test_medium_specific_field_cannot_borrow_from_the_other_medium():
    expected = "精华液：成分：水、甘油、泛醇"
    words = [
        _word("精华液：成分：水、甘油", 260, 620, 900),
        _word("面膜：成分：水、甘油、泛醇", 260, 760, 980),
    ]

    analysis = analyze_ingredient_field(expected, words)

    assert analysis["hit_atoms"] == ["水", "甘油"]
    assert analysis["miss_atoms"] == ["泛醇"]
    assert analysis["block_bbox"]["top"] + analysis["block_bbox"]["height"] < 730


def test_anchorless_block_with_only_two_atoms_fails_closed():
    words = [_word("乳酸杆菌发酵产物、甘油", 260, 620, 780)]

    analysis = analyze_ingredient_field(INGREDIENT_VALUE, words)

    assert analysis["block_bbox"] is None
    assert analysis["hit_atoms"] == []


def test_engineering_heading_stops_the_same_column_before_later_ingredient_text():
    expected = "成分：水、甘油、泛醇"
    words = [
        _word("成分：水、甘油", 260, 620, 760),
        _word("版本号：V8", 260, 676, 480),
        _word("泛醇", 260, 732, 260),
    ]

    analysis = analyze_ingredient_field(expected, words)

    assert analysis["hit_atoms"] == ["水", "甘油"]
    assert analysis["miss_atoms"] == ["泛醇"]
    assert analysis["block_bbox"]["top"] + analysis["block_bbox"]["height"] < 676


def test_page_metadata_drives_per_page_bbox_clipping():
    words = [
        {
            "text": "版本号：V1",
            "page": 1,
            "location": {"left": 20, "top": 20, "width": 240, "height": 40},
        },
        {
            "text": "成分：水、甘油、泛醇",
            "page": 2,
            "location": {"left": 900, "top": 430, "width": 220, "height": 80},
        },
    ]
    _attach_page_size(
        words,
        [
            {"page": 1, "width": 800, "height": 600},
            {"page": 2, "width": 1000, "height": 500},
        ],
    )

    analysis = analyze_ingredient_field("成分：水、甘油、泛醇", words)

    assert words[0]["_page_width"] == 800
    assert words[1]["_page_width"] == 1000
    bbox = analysis["block_bbox"]
    assert bbox["page"] == 2
    assert bbox["left"] + bbox["width"] <= 1000
    assert bbox["top"] + bbox["height"] <= 500


def test_match_field_reuses_ingredient_analysis_for_evidence_location(monkeypatch):
    import app.ingredient_match as ingredient_match

    calls = 0
    real_analyze = ingredient_match.analyze_ingredient_field

    def counted_analyze(*args, **kwargs):
        nonlocal calls
        calls += 1
        return real_analyze(*args, **kwargs)

    monkeypatch.setattr(ingredient_match, "analyze_ingredient_field", counted_analyze)
    words = [_word("成分：水、甘油、泛醇", 260, 620, 820)]

    match_field(
        "化妆品成分表",
        "成分：水、甘油、泛醇",
        words,
        words[0]["text"],
        locate_words=words,
    )

    assert calls == 1
