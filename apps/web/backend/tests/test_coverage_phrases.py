from app.fields import COVERAGE_PHRASE_CAP, _dedupe_miss_phrases, coverage_against_ocr


def test_coverage_keeps_more_than_eight_misses():
    items = [
        "积雪草苷",
        "烟酰胺醇",
        "香柠檬油",
        "透明质酸",
        "尿囊素粒",
        "甘草酸二",
        "泛醇维素",
        "生育酚醇",
        "神经酰胺",
        "霍霍巴油",
        "角鲨烷脂",
        "辛酸癸酸",
    ]
    cov = coverage_against_ocr("，".join(items), "积雪草苷")
    assert cov["total"] > 8
    assert len(cov["miss_phrases"]) > 8
    assert len(cov["hit_phrases"]) >= 1
    assert "积雪草苷" in cov["hit_phrases"]


def test_dedupe_miss_keeps_more_than_twelve():
    misses = [f"成分短语{i:02d}完整句" for i in range(20)]
    out = _dedupe_miss_phrases(misses)
    assert len(out) > 12
    assert len(out) <= COVERAGE_PHRASE_CAP
