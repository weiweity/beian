from app.field_verify import clip_hit_bboxes, pair_bilingual_names, verify_fields


def _box(left, top, w, h, *, page=1, role="hit"):
    return {
        "page": page,
        "left": left,
        "top": top,
        "width": w,
        "height": h,
        "role": role,
    }


def test_clip_keeps_one_hit_box_for_repeated_name():
    regions = [
        {
            "id": "p1_claims",
            "role": "claims",
            "page": 1,
            "left": 0,
            "top": 0,
            "width": 400,
            "height": 200,
        }
    ]
    hit = {
        "field": "中文品名",
        "field_group": "中文品名",
        "bboxes": [
            _box(20, 30, 100, 40),
            _box(20, 80, 100, 40),
            _box(20, 500, 100, 24),
        ],
    }
    out = clip_hit_bboxes(hit, regions)
    hits = [b for b in out["bboxes"] if b.get("role") == "hit"]
    assert len(hits) == 1
    assert hits[0]["top"] == 30
    assert out.get("name_extra_count") == 2


def test_clip_finds_principal_name_region_across_pages():
    regions = [
        {
            "id": "p1_claims",
            "role": "claims",
            "page": 1,
            "left": 0,
            "top": 0,
            "width": 400,
            "height": 200,
        }
    ]
    hit = {
        "field": "中文品名",
        "field_group": "中文品名",
        "bboxes": [
            _box(20, 500, 300, 100, page=2),
            _box(20, 30, 100, 40, page=1),
        ],
    }
    out = clip_hit_bboxes(hit, regions)
    chosen = next(b for b in out["bboxes"] if b.get("role") == "hit")
    assert chosen["page"] == 1
    assert chosen["top"] == 30


def test_bbox_budget_hit_and_optional_check():
    hit = {
        "field": "成分表",
        "field_group": "成分表",
        "bboxes": [
            _box(10, 10, 80, 20, role="hit"),
            _box(10, 40, 80, 20, role="hit"),
            _box(10, 90, 40, 10, role="check"),
            _box(12, 110, 40, 10, role="check"),
        ],
    }
    out = clip_hit_bboxes(hit, [])
    roles = [b.get("role") for b in out["bboxes"]]
    assert roles.count("hit") == 1
    assert roles.count("check") == 1
    assert len(out["bboxes"]) == 2


def test_long_field_prefers_its_semantic_region_over_larger_duplicate():
    regions = [
        {
            "role": "claims",
            "page": 1,
            "left": 0,
            "top": 0,
            "width": 1000,
            "height": 400,
        },
        {
            "role": "ingredients",
            "page": 1,
            "left": 0,
            "top": 400,
            "width": 1000,
            "height": 600,
        },
    ]
    hit = {
        "field": "成分表",
        "field_group": "成分表",
        "bboxes": [
            _box(10, 50, 900, 300, role="hit"),
            _box(10, 500, 500, 200, role="hit"),
        ],
    }
    out = clip_hit_bboxes(hit, regions)
    chosen = next(b for b in out["bboxes"] if b.get("role") == "hit")
    assert chosen["top"] == 500
    assert chosen["width"] == 500


def test_context_only_is_not_promoted_to_real_hit():
    hit = {
        "field": "卖点文案",
        "field_group": "文案",
        "bboxes": [_box(10, 20, 200, 80, role="context")],
        "no_bbox": False,
    }
    out = clip_hit_bboxes(hit, [])
    assert out["bboxes"] == []
    assert out["no_bbox"] is True


def test_cross_page_warning_controls_hit_page_and_stays_local():
    hit = {
        "field": "使用方法",
        "field_group": "使用方法",
        "page": 1,
        "bboxes": [
            _box(10, 10, 80, 20, page=1, role="hit"),
            _box(20, 40, 60, 18, page=2, role="check"),
            _box(900, 1400, 80, 30, page=3, role="check"),
            _box(5, 5, 20, 10, page=1, role="miss_anchor"),
        ],
    }
    out = clip_hit_bboxes(hit, [])
    checks = [b for b in out["bboxes"] if b.get("role") == "check"]
    assert len(checks) == 1
    assert checks[0]["page"] == 2
    assert checks[0]["left"] == 20
    assert checks[0]["width"] == 60
    assert out["page"] == 2
    assert out["no_bbox"] is False


def test_bilingual_pair_one_shared_box():
    cn = {
        "field": "中文品名",
        "field_group": "中文品名",
        "bboxes": [_box(20, 20, 120, 30, role="hit")],
    }
    en = {
        "field": "英文品名",
        "field_group": "英文品名",
        "bboxes": [_box(24, 52, 160, 22, role="hit")],
    }
    out = pair_bilingual_names([cn, en], [])
    cb = out[0]["bboxes"][0]
    eb = out[1]["bboxes"][0]
    assert out[0]["bilingual_pair"] is True
    assert out[0]["bilingual_pair_id"] == out[1]["bilingual_pair_id"]
    assert cb["left"] == eb["left"]
    assert cb["top"] == eb["top"]
    assert cb["width"] == eb["width"]
    assert cb["height"] == eb["height"]


def test_bilingual_pair_does_not_hide_a_field_warning():
    cn = {
        "field": "中文品名",
        "field_group": "中文品名",
        "bboxes": [
            _box(20, 20, 120, 30, role="hit"),
            _box(10, 300, 80, 20, page=2, role="check"),
        ],
    }
    en = {
        "field": "英文品名",
        "field_group": "英文品名",
        "bboxes": [_box(24, 52, 160, 22, role="hit")],
    }
    out = pair_bilingual_names([cn, en], [])
    assert not out[0].get("bilingual_pair")
    assert not out[1].get("bilingual_pair")


def test_verify_fields_uses_compare_then_clips(monkeypatch):
    def fake_compare(*_a, **_k):
        return [
            {
                "field": "中文品名",
                "field_group": "中文品名",
                "bboxes": [_box(10, 10, 40, 20), _box(10, 80, 40, 20)],
                "status": "一致",
            }
        ]

    monkeypatch.setattr("app.field_verify.compare_fields", fake_compare)
    hits = verify_fields(
        [{"field": "中文品名", "excel_value": "达肤妍"}],
        [],
        "达肤妍",
        regions=[
            {
                "role": "claims",
                "page": 1,
                "left": 0,
                "top": 0,
                "width": 200,
                "height": 60,
            }
        ],
    )
    assert len(hits) == 1
    assert len([b for b in hits[0]["bboxes"] if b.get("role") == "hit"]) == 1
