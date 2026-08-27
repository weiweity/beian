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
    assert cb["left"] == eb["left"]
    assert cb["top"] == eb["top"]
    assert cb["width"] == eb["width"]
    assert cb["height"] == eb["height"]


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
