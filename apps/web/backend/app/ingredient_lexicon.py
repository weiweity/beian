"""受控化妆品原料参考词典。

词典只做两件事：

* 用完全规范化后的名称把 Excel 原子关联到一条可追溯的官方记录；
* 为未命中的 OCR 片段提供中文名/INCI 参考候选，供人工复核。

参考候选不能把缺失项改成命中项。判定仍由 ``ingredient_match`` 对 Excel
原文与 OCR 原文完成，避免把“目录中是同一原料”误当成“包装上已按要求印出”。
"""
from __future__ import annotations

import json
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Any


_REFERENCE_PATH = (
    Path(__file__).resolve().parent / "reference" / "cosmetic_ingredients.v1.json"
)


def _lookup_key(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    return "".join(text.casefold().split())


def _require_text(value: Any, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"ingredient reference missing {label}")
    return text


def _string_list(value: Any, label: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"ingredient reference {label} must be a string list")
    return [item.strip() for item in value if item.strip()]


@lru_cache(maxsize=1)
def _load_catalog() -> dict[str, Any]:
    raw = json.loads(_REFERENCE_PATH.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schema_version") != 1:
        raise ValueError("unsupported ingredient reference schema")

    source_by_id: dict[str, dict[str, str]] = {}
    for source in raw.get("sources") or []:
        if not isinstance(source, dict):
            raise ValueError("ingredient reference source must be an object")
        source_id = _require_text(source.get("id"), "source.id")
        if source_id in source_by_id:
            raise ValueError(f"duplicate ingredient reference source: {source_id}")
        source_by_id[source_id] = {
            "id": source_id,
            "authority": _require_text(source.get("authority"), "source.authority"),
            "title": _require_text(source.get("title"), "source.title"),
            "url": _require_text(source.get("url"), "source.url"),
            "as_of": _require_text(source.get("as_of"), "source.as_of"),
        }

    records: list[dict[str, Any]] = []
    record_ids: set[str] = set()
    name_index: dict[str, set[int]] = {}
    for raw_entry in raw.get("entries") or []:
        if not isinstance(raw_entry, dict):
            raise ValueError("ingredient reference entry must be an object")
        entry_id = _require_text(raw_entry.get("id"), "entry.id")
        if entry_id in record_ids:
            raise ValueError(f"duplicate ingredient reference entry: {entry_id}")
        record_ids.add(entry_id)

        source_id = _require_text(raw_entry.get("source_id"), "entry.source_id")
        if source_id not in source_by_id:
            raise ValueError(f"unknown ingredient reference source: {source_id}")
        aliases = _string_list(raw_entry.get("aliases"), "entry.aliases")
        ocr_variants = _string_list(
            raw_entry.get("ocr_variants"), "entry.ocr_variants"
        )
        record = {
            "id": entry_id,
            "canonical_zh": _require_text(
                raw_entry.get("canonical_zh"), "entry.canonical_zh"
            ),
            "inci": _require_text(raw_entry.get("inci"), "entry.inci"),
            "aliases": aliases,
            "ocr_variants": ocr_variants,
            "cas": _string_list(raw_entry.get("cas"), "entry.cas"),
            "regulatory_status": _require_text(
                raw_entry.get("regulatory_status"), "entry.regulatory_status"
            ),
            "source_record": _require_text(
                raw_entry.get("source_record"), "entry.source_record"
            ),
            "note": str(raw_entry.get("note") or "").strip(),
            "source": source_by_id[source_id],
        }
        record_index = len(records)
        records.append(record)
        for name in [record["canonical_zh"], record["inci"], *aliases]:
            key = _lookup_key(name)
            if key:
                name_index.setdefault(key, set()).add(record_index)

    metadata = {
        "available": True,
        "dataset_id": _require_text(raw.get("dataset_id"), "dataset_id"),
        "dataset_version": _require_text(raw.get("dataset_version"), "dataset_version"),
        "as_of": _require_text(raw.get("as_of"), "as_of"),
        "retrieved_at": _require_text(raw.get("retrieved_at"), "retrieved_at"),
        "scope": _require_text(raw.get("scope"), "scope"),
        "verdict_policy": _require_text(raw.get("verdict_policy"), "verdict_policy"),
        "entry_count": len(records),
        "ambiguous_name_count": sum(
            1 for record_indexes in name_index.values() if len(record_indexes) > 1
        ),
        "sources": list(source_by_id.values()),
    }
    return {"metadata": metadata, "records": records, "name_index": name_index}


def ingredient_reference_metadata() -> dict[str, Any]:
    """返回可序列化的数据集元信息，不暴露内部可变对象。"""
    metadata = _load_catalog()["metadata"]
    return {
        **{key: value for key, value in metadata.items() if key != "sources"},
        "sources": [dict(source) for source in metadata["sources"]],
    }


def lookup_ingredient_reference(name: str) -> dict[str, Any] | None:
    """按标准中文名、INCI 或受控别名精确查找；歧义名称失败关闭。"""
    catalog = _load_catalog()
    record_indexes = catalog["name_index"].get(_lookup_key(name)) or set()
    if len(record_indexes) != 1:
        return None
    record = catalog["records"][next(iter(record_indexes))]
    return {
        **{key: value for key, value in record.items() if key != "source"},
        "aliases": list(record["aliases"]),
        "ocr_variants": list(record["ocr_variants"]),
        "cas": list(record["cas"]),
        "source": dict(record["source"]),
    }


def ingredient_reference_names(name: str) -> list[dict[str, str]]:
    """返回同一记录的可解释名称；这些名称只用于参考候选。"""
    record = lookup_ingredient_reference(name)
    if not record:
        return []
    names = [
        {"kind": "canonical_zh", "text": record["canonical_zh"]},
        {"kind": "inci", "text": record["inci"]},
        *({"kind": "alias", "text": alias} for alias in record["aliases"]),
        *(
            {"kind": "ocr_variant", "text": variant}
            for variant in record["ocr_variants"]
        ),
    ]
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in names:
        key = _lookup_key(item["text"])
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out
