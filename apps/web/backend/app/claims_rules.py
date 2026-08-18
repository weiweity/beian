"""
宣称/合规轻量规则骨架（P3）

不接外部法规库；内置常见风险词与强制标识检查点，供人审提示。
后续可替换为妆合规/企业词库 API。
"""
from __future__ import annotations

import re
from typing import Any

from app.fields import normalize

# 宣称风险（示例，非法律意见）
CLAIM_RISK_PATTERNS: list[tuple[str, str, str]] = [
    (r"治愈|治疗|抗菌|灭菌|消炎", "high", "医疗/药品化宣称风险"),
    (r"100%\s*有效|永久|根除", "high", "绝对化功效表述"),
    (r"纯天然|无添加|无化学", "medium", "绝对化/误导性清洁标签"),
    (r"抗衰|逆龄|基因", "medium", "功效边界需文献与法规核对"),
    (r"美白|祛斑", "medium", "特殊化妆品宣称范畴需核对备案"),
]

# 包装强制信息关键词（出现即记录，缺失另算）
MANDATORY_HINTS = [
    "备案人",
    "生产企业",
    "生产许可证",
    "执行标准",
    "净含量",
    "使用方法",
    "注意",
]


def scan_claims(text: str) -> list[dict[str, Any]]:
    t = text or ""
    hits = []
    for pat, level, note in CLAIM_RISK_PATTERNS:
        for m in re.finditer(pat, t, flags=re.I):
            hits.append(
                {
                    "span": m.group(0),
                    "level": level,
                    "note": note,
                    "start": m.start(),
                }
            )
    return hits[:30]


def scan_mandatory_presence(pack_text: str) -> list[dict[str, Any]]:
    n = normalize(pack_text or "")
    out = []
    for k in MANDATORY_HINTS:
        out.append(
            {
                "keyword": k,
                "present": normalize(k) in n or k in (pack_text or ""),
            }
        )
    return out


def build_claims_report(
    excel_joined: str, pack_text: str
) -> dict[str, Any]:
    return {
        "engine": "claims_rules_v0",
        "disclaimer": "规则骨架仅供人审提示，不构成合规结论。",
        "excel_claim_risks": scan_claims(excel_joined),
        "pack_claim_risks": scan_claims(pack_text),
        "mandatory_on_pack": scan_mandatory_presence(pack_text),
    }
