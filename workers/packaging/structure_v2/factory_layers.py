"""Factory print-shop layer names. These are default proposals, not silent nets."""

from __future__ import annotations

from pathlib import Path
import re
from typing import Any, Mapping, Sequence

FACTORY_KNIFE_LAYER_NAMES = ("刀版", "刀线")
PROCESS_PLATE_MARKERS = ("击凹", "击凸", "哑油", "垫白", "丝印", "注塑", "漏银", "烫")
NEVER_DEFAULT_PROPOSAL_MARKERS = ("印刷", "表", "标注", "码")
CATEGORY_UNSUPPORTED_MARKERS = ("内包", "标贴")
POUCH_MARKER = "膜袋"
FLATTENED_LAYER_NAME = re.compile(r"^图层\s*\d+$")


def is_factory_knife_layer_name(name: str) -> bool:
    return name in FACTORY_KNIFE_LAYER_NAMES


def is_process_plate_layer_name(name: str) -> bool:
    return any(marker in name for marker in PROCESS_PLATE_MARKERS)


def is_never_default_proposal_layer_name(name: str) -> bool:
    return any(marker in name for marker in NEVER_DEFAULT_PROPOSAL_MARKERS)


def is_print_fallback_eligible_layer_name(name: str) -> bool:
    return bool(name) and not (
        is_factory_knife_layer_name(name)
        or is_process_plate_layer_name(name)
        or is_never_default_proposal_layer_name(name)
    )


def unique_factory_knife_layer_name(layer_names: Sequence[str]) -> str | None:
    dao_ban = sum(1 for name in layer_names if name == "刀版")
    dao_xian = sum(1 for name in layer_names if name == "刀线")
    if dao_ban == 1 and dao_xian == 0:
        return "刀版"
    if dao_xian == 1 and dao_ban == 0:
        return "刀线"
    return None


def unique_print_fallback_layer_name(layer_names: Sequence[str]) -> str | None:
    eligible: list[str] = []
    for name in layer_names:
        value = str(name or "").strip()
        if not is_print_fallback_eligible_layer_name(value):
            continue
        if value not in eligible:
            eligible.append(value)
    if len(eligible) == 1:
        return eligible[0]
    return None


def is_flattened_layer_set(layer_names: Sequence[str]) -> bool:
    names = [str(name or "").strip() for name in layer_names if str(name or "").strip()]
    return bool(names) and all(FLATTENED_LAYER_NAME.fullmatch(name) for name in names)


def category_unsupported_marker(haystack: str) -> str | None:
    for marker in CATEGORY_UNSUPPORTED_MARKERS:
        if marker in haystack:
            return marker
    return None


def _layer_names(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    names: list[str] = []
    for item in value:
        name = str(item or "").strip()
        if name:
            names.append(name)
    return names


def factory_input_hold(
    source: Path,
    layers: Any,
    product: Mapping[str, Any] | None = None,
) -> tuple[str, str] | None:
    """Return unsupported (code, message) for flattened or non-carton factory files."""
    names = _layer_names(layers)
    if is_flattened_layer_set(names):
        return (
            "structure_flattened_artwork",
            "当前不支持（拼合稿）。请用未拼合、仍有印刷/刀版分层的源稿重新打样。",
        )
    product = product or {}
    haystack = " ".join(
        [
            source.name,
            str(product.get("code") or ""),
            str(product.get("slug") or ""),
            str(product.get("display_name") or ""),
            str(product.get("title") or ""),
            *names,
        ]
    )
    marker = category_unsupported_marker(haystack)
    if marker is not None:
        return (
            "structure_category_unsupported",
            f"当前不支持（{marker}）。打样台只做花盒展开图，请不要把内包或标贴送进同一套成盒证明。",
        )
    return None


def pouch_marker_hint(
    source: Path,
    layers: Any,
    product: Mapping[str, Any] | None = None,
) -> bool:
    """True when filename/title/layers contain 膜袋. Never keys on 面膜 or 袋装."""
    product = product or {}
    haystack = " ".join(
        [
            source.name,
            str(product.get("code") or ""),
            str(product.get("slug") or ""),
            str(product.get("display_name") or ""),
            str(product.get("title") or ""),
            *_layer_names(layers),
        ]
    )
    return POUCH_MARKER in haystack


def print_layer_failure_message(layers: Any) -> str:
    names = _layer_names(layers)
    extra = f"。稿里现有：{'、'.join(names)}" if names else "，请检查稿件图层后重试"
    return ("Illustrator 无法按模板隔离印刷图层" + extra)[:80]
