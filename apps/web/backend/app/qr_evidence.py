"""二维码字段的单一语义合同。

字段核对回答的是“包装是否印了扫码关注引导语”，二维码图片能否解码是另一份
审计证据。两者不得互相改写状态或坐标。
"""
from __future__ import annotations

import re


DEFAULT_QR_GUIDE = "扫码关注微信工作号"
QR_GUIDE_PHRASES = (
    DEFAULT_QR_GUIDE,
    "扫码关注微信公众号",
    "扫码关注微信公众账号",
    "扫一扫关注微信公众号",
)


def _normal(text: str) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", str(text or "").lower())


def qr_guide_queries(excel_value: str = "") -> tuple[str, ...]:
    """Expected wording first, followed by accepted full-phrase variants."""
    expected = str(excel_value or "").strip()
    ordered: list[str] = []
    for phrase in (expected, *QR_GUIDE_PHRASES):
        if not phrase or phrase in ordered:
            continue
        # Arbitrary notes such as a brand name are not QR guide semantics.
        has_scan_verb = "扫码" in phrase or "扫一扫" in phrase
        if has_scan_verb and ("微信" in phrase or "公众号" in phrase):
            ordered.append(phrase)
    return tuple(ordered or QR_GUIDE_PHRASES)


def matched_qr_guide(text: str, excel_value: str = "") -> str | None:
    normalized = _normal(text)
    if not normalized:
        return None
    for phrase in qr_guide_queries(excel_value):
        if _normal(phrase) in normalized:
            return phrase
    return None


def expected_qr_guide(excel_value: str = "") -> str:
    return qr_guide_queries(excel_value)[0]
