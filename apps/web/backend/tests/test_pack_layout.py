from app.pack_layout import detect_regions, words_in_roles


def _word(text: str, *, page=1, left=10, top=10, width=80, height=20) -> dict:
    return {
        "text": text,
        "page": page,
        "location": {"left": left, "top": top, "width": width, "height": height},
    }


def test_detect_regions_assigns_roles_and_pixel_boxes():
    metas = [{"page": 1, "width": 1000, "height": 2000}]
    words = [
        _word("达肤妍喷雾", top=40),
        _word("成分：水", top=500),
        _word("使用方法", top=1100),
    ]
    layout = detect_regions(words, metas)
    roles = {r["role"] for r in layout["regions"]}
    assert {"claims", "ingredients", "usage", "filing", "footnote"} <= roles
    claims = next(r for r in layout["regions"] if r["role"] == "claims")
    assert claims["page"] == 1
    assert claims["width"] > 10
    assert "zones" in layout
    assert "claims" in layout["zones"]


def test_product_name_scope_is_claims_not_ingredients():
    metas = [{"page": 1, "width": 1000, "height": 2000}]
    words = [
        _word("达肤妍", left=20, top=30, width=120, height=40),
        _word("达肤妍", left=20, top=520, width=120, height=24),
    ]
    layout = detect_regions(words, metas)
    claims_words = words_in_roles(words, layout["regions"], ("claims",))
    ing_words = words_in_roles(words, layout["regions"], ("ingredients",))
    claims_text = " ".join(w["text"] for w in claims_words)
    ing_text = " ".join(w["text"] for w in ing_words)
    assert "达肤妍" in claims_text
    # 成分区那一处不应进主展示匹配范围
    assert claims_words[0]["location"]["top"] < 200
    assert any(w["location"]["top"] > 400 for w in ing_words) or "达肤妍" in ing_text


def test_multi_page_layout_keeps_page_specific_zones():
    metas = [
        {"page": 1, "width": 1000, "height": 1000},
        {"page": 2, "width": 1200, "height": 3000},
    ]
    words = [
        _word("成分：水", page=1, top=300),
        _word("使用方法", page=2, top=2400),
    ]
    layout = detect_regions(words, metas)
    assert layout["zones"] == {}
    assert set(layout["zones_by_page"]) == {1, 2}
    assert layout["zones_by_page"][1]["process"]["y1"] == 1000
    assert layout["zones_by_page"][2]["process"]["y1"] == 3000
