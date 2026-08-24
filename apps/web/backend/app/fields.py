"""Excel 确认单解析 + 字段匹配（含 bbox · 单位/别名 · 长文本覆盖率）"""
from __future__ import annotations

import re
from typing import Any

import openpyxl
from rapidfuzz import fuzz

from app.layout_zones import skip_sheet_field

# 字段名别名 → 规范名（匹配用）
FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "净含量": ("净含量", "规格", "含量", "容量"),
    "条形码": ("条形码", "条码", "barcode", "EAN", "69码"),
    "中文品名": ("中文品名", "品名", "产品名称", "中文名称"),
    "英文品名": ("英文品名", "英文名称", "INCI名"),
    "成分表": ("成分表", "全成分", "成分", "ingredients", "化妆品成分表"),
    "使用方法": ("使用方法", "用法", "使用说明", "注意事项"),
    "生产信息": ("生产信息", "生产企业", "生产商", "委托方", "备案人"),
    "二维码": ("二维码", "QR码", "QR", "追溯码"),
    "文案": ("文案", "卖点", "宣称"),
}

# 机审阈值
SCORE_OK = 90
SCORE_WARN = 72

# 软字段：缺失降为疑点
SOFT_FIELDS = ("净含量", "条形码", "条码", "规格", "二维码")

# 长字段：必须做多片段覆盖率，不能只命中一句就「一致」
LONG_FIELD_GROUPS = ("成分表", "生产信息", "文案", "使用方法")

_UNIT_MAP = {
    "毫升": "ml",
    "ml": "ml",
    "mL": "ml",
    "ML": "ml",
    "克": "g",
    "g": "g",
    "G": "g",
    "kg": "kg",
    "KG": "kg",
    "千克": "kg",
}


def normalize(s: str) -> str:
    if not s:
        return ""
    # INCI / OCR 变体先归一再去空白
    try:
        from app.inci_normalize import normalize_inci_text

        s = normalize_inci_text(str(s))
    except Exception:
        s = str(s)
    s = s.replace("\u3000", " ").replace("\xa0", " ")
    s = re.sub(r"\s+", "", s)
    return s.replace("：", ":").replace("（", "(").replace("）", ")").lower()

def normalize_units(s: str) -> str:
    t = normalize(s)
    for a, b in _UNIT_MAP.items():
        t = t.replace(normalize(a), b)
    t = re.sub(r"(\d+(?:\.\d+)?)(ml|g|kg)", r"\1\2", t)
    return t


def field_group(field: str) -> str:
    """更具体的字段优先（避免「品名」误吃「英文品名」）。"""
    f = (field or "").strip()
    fl = f.lower()
    # 显式优先表
    priority = (
        "二维码",
        "条形码",
        "净含量",
        "logo标识",
        "英文品名",
        "中文品名",
        "使用方法",
        "成分表",
        "生产信息",
        "文案",
    )
    for canon in priority:
        aliases = FIELD_ALIASES.get(canon) or (canon,)
        for a in aliases:
            al = a.lower()
            if al in fl or fl in al:
                return canon
    for canon, aliases in FIELD_ALIASES.items():
        if any(a.lower() in fl or fl in a.lower() for a in aliases):
            return canon
    return f


def split_ingredient_steps(field_name: str, value: str, remark: str = "") -> list[dict]:
    """
    P0：成分表按「步骤01/02」「精华液/面膜」拆成多条，各自整段定位。
    拆不出则返回单条原字段。
    """
    text = value or ""
    # 步骤01.精华液：... 步骤02.面膜：...
    parts = re.split(
        r"(?=(?:步骤\s*0*\d+\s*[.．、:：]?|Step\s*\d+\s*[:.．]?))",
        text,
        flags=re.I,
    )
    parts = [p.strip() for p in parts if p and p.strip()]
    if len(parts) < 2:
        # 备用：精华液： / 面膜：
        parts2 = re.split(r"(?=(?:精华液|面膜)\s*[:：])", text)
        parts2 = [p.strip() for p in parts2 if p and p.strip()]
        if len(parts2) >= 2:
            parts = parts2
    if len(parts) < 2:
        return [
            {
                "field": field_name,
                "excel_value": text,
                "remark": remark or "",
                "field_group": "成分表",
                "step_id": None,
            }
        ]
    out = []
    for i, p in enumerate(parts):
        # 标题行
        head = re.split(r"[\n\r]", p, maxsplit=1)[0][:40]
        label = re.sub(r"\s+", "", head)[:24] or f"步骤{i+1}"
        out.append(
            {
                "field": f"{field_name} · {label}",
                "excel_value": p,
                "remark": remark if i == 0 else "",
                "field_group": "成分表",
                "step_id": f"step_{i+1}",
                "parent_field": field_name,
            }
        )
    return out


def parse_excel_fields(path: str) -> list[dict]:
    """
    确认单常见结构：
      A 序号 | B 项目 | C 内容 | D… | E 备注
    只取 B+C；E 备注附上供人审。
    成分表自动按步骤拆条（P0）。
    """
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    fields: list[dict] = []
    max_col = min(ws.max_column or 3, 8)
    for row in ws.iter_rows(
        min_row=1, max_row=ws.max_row or 1, max_col=max_col, values_only=True
    ):
        cells = list(row) + [None] * 8
        b, c = cells[1], cells[2]
        remark = cells[4] if cells[4] is not None else cells[3]
        name = str(b).strip() if b is not None else ""
        if name in ("", "项目", "序号") or "确认单" in name:
            continue
        val = "" if c is None else str(c).strip()
        rem = "" if remark is None else str(remark).strip()
        if not name:
            continue
        if not val and not rem:
            continue
        if not val and rem:
            val = rem
            rem = ""
        if skip_sheet_field(name):
            continue
        fg = field_group(name)
        if fg == "成分表":
            fields.extend(split_ingredient_steps(name, val, rem))
        else:
            fields.append(
                {
                    "field": name,
                    "excel_value": val,
                    "remark": rem,
                    "field_group": fg,
                }
            )
    return fields

def split_chunks(value: str) -> list[str]:
    value = (value or "").strip()
    if not value:
        return []
    chunks: list[str] = []
    for ln in re.split(r"[\n\r]+", value):
        ln = ln.strip()
        if not ln:
            continue
        chunks.append(ln)
        if len(ln) <= 40:
            for p in re.split(r"[\s:：]+", ln):
                if len(p.strip()) >= 2:
                    chunks.append(p.strip())
        else:
            for p in re.split(r"[，,。；;、|/]", ln):
                if len(p.strip()) >= 2:
                    chunks.append(p.strip())
    seen, out = set(), []
    for c in chunks:
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out[:80]


def key_phrases(value: str, *, max_n: int = 40) -> list[str]:
    """
    从 Excel 长文本抽「必须在 PDF 上出现」的关键短语：
    - 条码数字
    - 中文 ≥4 字短语
    - 英文词组 ≥6 字符
    - 成分 INCI 片段
    """
    raw = value or ""
    phrases: list[str] = []
    # 条码 / 备案号 / 许可证
    for m in re.findall(r"\d{8,14}", raw):
        phrases.append(m)
    for m in re.findall(r"[沪浙苏粤京][妆妆]?\d{6,}", raw):
        phrases.append(m)
    for m in re.findall(r"(?:GB|QB|T)[/\s]?[\d.T\-]+", raw, flags=re.I):
        phrases.append(m)

    for ln in re.split(r"[\n\r]+", raw):
        ln = ln.strip()
        if not ln:
            continue
        # 整行（中短）
        if 4 <= len(ln) <= 36:
            phrases.append(ln)
        # 按顿号/逗号切成分
        for p in re.split(r"[，,、；;|/]", ln):
            p = p.strip()
            if len(p) < 3:
                continue
            # 去前缀「成分：」
            p = re.sub(r"^(?:成分|其他微量成分|步骤\d+[.．、]?)[:：]?", "", p).strip()
            if len(normalize(p)) >= 3:
                phrases.append(p)

    # 英文块
    for m in re.findall(r"[A-Za-z][A-Za-z0-9\-\s/+]{5,40}", raw):
        t = re.sub(r"\s+", " ", m).strip()
        if len(t) >= 6:
            phrases.append(t)

    # 去重保序，优先较长且信息量大
    seen: set[str] = set()
    out: list[str] = []
    for p in sorted(phrases, key=lambda x: (-len(normalize(x)), x)):
        n = normalize(p)
        if len(n) < 3 or n in seen:
            continue
        # 过短无意义
        if n in ("使用方法", "注意事项", "贮存条件", "成分", "产品名称", "水", "油", "甘油"):
            continue
        # 单字/双字几乎无定位价值，且易导致只框「水」
        if len(n) < 3:
            continue
        seen.add(n)
        out.append(p)
        if len(out) >= max_n:
            break
    return out


def _is_noise_text(s: str) -> bool:
    t = (s or "").strip()
    if not t:
        return True
    if len(normalize(t)) < 2:
        return True
    if re.fullmatch(r"[\s\W_]+", t, flags=re.UNICODE):
        return True
    return False


def _ingredient_soft_in_ocr(phrase: str, n_ocr: str) -> bool:
    """
    成分/INCI 软命中：OCR 常断行、糊字（辛基十二醇月桂酰谷… / C10-30酸丙酸酸交联）。
    多锚点：中文核 / 编码 / 拉丁名前缀。
    """
    raw = phrase or ""
    # 纯中文核（去括号拉丁）
    cn = re.sub(r"[（(][^）)]*[）)]", "", raw)
    cn = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9\-]", "", cn)
    cn_n = normalize(cn)
    if len(cn_n) >= 4 and cn_n in n_ocr:
        return True
    # 中文连续核：前 4～8 字（断行时后半常丢）
    cn_only = re.sub(r"[^\u4e00-\u9fff]", "", raw)
    if len(cn_only) >= 4:
        for L in (8, 6, 5, 4):
            if len(cn_only) >= L and normalize(cn_only[:L]) in n_ocr:
                return True
    # C10-30 / C13-15 类编码 + 关键词
    codes = re.findall(r"C\s*\d+\s*-\s*\d+", raw, re.I)
    n_ocr_c = re.sub(r"\s+", "", n_ocr).upper()
    for code in codes:
        c = re.sub(r"\s+", "", code).upper()
        if c in n_ocr_c:
            # 编码在 + 交联/烷/丙烯酸 任一
            if any(k in n_ocr for k in ("交联", "烷", "丙烯酸", "酸丙")):
                return True
            if len(codes) == 1 and len(cn_only) <= 2:
                return True
    # 拉丁学名：优先种加词（防 CITRUS AURANTIUM 误把香柠檬=酸橙）
    species_key = {
        "BERGAMIA": ("香柠檬", "BERGAM"),
        "DULCIS": ("酸橙", "DULCIS"),
        "AURANTIIFOLIA": ("来檬", "AURANTIIFOLIA"),
        "AURANTIFOLIA": ("来檬", "AURANTIFOLIA"),
        "LIMON": ("柠檬", "LIMON"),
        "RETICULATA": ("柑橘", "RETICULATA"),
        "GRAVEOLENS": ("天竺葵", "GRAVEOLENS"),
        "ASIATICA": ("积雪草", "ASIATICA"),
        "ALPINUM": ("火绒草", "ALPINUM"),
        "CARICA": ("无花果", "CARICA"),
        "FLORIDA": ("栀子", "FLORIDA"),
    }
    lat_blob = re.sub(r"\s+", "", raw).upper()
    for sp, (cn_hint, needle) in species_key.items():
        if sp in lat_blob or cn_hint in raw:
            if needle in n_ocr_c or cn_hint in n_ocr:
                return True
            # 种加词明确写在确认单但 OCR 完全没有 → 不因属名命中而放行
            if sp in lat_blob:
                return False
    for m in re.finditer(r"[A-Za-z][A-Za-z\-\s]{5,40}", raw):
        lat = re.sub(r"\s+", "", m.group(0)).upper()
        if len(lat) >= 12 and lat[:12] in n_ocr_c:
            return True
        if len(lat) >= 10 and lat in n_ocr_c:
            return True
    # 常见 OCR 糊字映射后再比（含 氢化↔氯化 卵磷脂）
    try:
        from app.inci_normalize import normalize_inci_text

        n2 = normalize(normalize_inci_text(raw))
        if len(n2) >= 4 and (n2 in n_ocr or n2[:8] in n_ocr):
            return True
        ocr2 = normalize(normalize_inci_text(n_ocr))
        if len(n2) >= 4 and n2 in ocr2:
            return True
        if len(cn_only) >= 4 and normalize(cn_only[:6]) in ocr2:
            return True
        # 卵磷脂：OCR 常写成氯化卵磷脂
        if "卵磷脂" in raw and ("卵磷脂" in n_ocr or "卵磷脂" in ocr2):
            return True
    except Exception:
        pass
    # 多锚：中文片段 ≥2 个命中
    parts = re.findall(r"[\u4e00-\u9fff]{2,6}", raw)
    parts = [normalize(p) for p in parts if len(normalize(p)) >= 2]
    if len(parts) >= 2:
        hit = sum(1 for p in parts if p in n_ocr)
        if hit >= max(2, len(parts) - 1):
            return True
    # 硅氧烷 / 共聚物等尾缀 + 前缀
    for tail in ("硅氧烷", "共聚物", "交联聚合物", "谷氨酸酯", "熊果苷", "生育酚"):
        if tail in raw and normalize(tail) in n_ocr:
            head = cn_only[:4] if len(cn_only) >= 4 else ""
            if head and normalize(head) in n_ocr:
                return True
            if tail in ("交联聚合物", "硅氧烷") and any(
                k in n_ocr for k in ("C10-30", "c10-30", "二甲基", "丙烯")
            ):
                return True
    # 生育酚 / 维生素E：OCR 常断成「维生素E」「VE」「生育」+ 邻位油名
    if "生育酚" in raw or re.search(r"维生素\s*E", raw, re.I):
        if any(
            k in n_ocr
            for k in (
                "生育酚",
                "生育",
                "维生素e",
                "维生素E",
                "维生素ｅ",
            )
        ) or re.search(r"维生素\s*e", n_ocr, re.I):
            return True
        if re.search(r"(?:tocopherol|vitamín?e|vitamin\s*e|\bve\b)", n_ocr, re.I):
            return True
        # 夹在果油序列里时常被糊成「…油、生」截断
        if "生" in n_ocr and ("果油" in n_ocr or "香柠檬" in n_ocr or "柠檬" in n_ocr):
            if re.search(r"油[、,，]?\s*生|生[、,，]?\s*(?:育|维)|育酚", n_ocr):
                return True
    return False


def _phrase_in_ocr(phrase: str, n_ocr: str, n_ocr_u: str) -> bool:
    """
    短语是否在 OCR 中出现。
    抗：换行粘连、中间插入 logo、项目符号/步骤写法差异、形近字、INCI 断字。
    """
    n = normalize(phrase)
    nu = normalize_units(phrase)
    if len(n) < 3:
        return False
    if n in n_ocr or nu in n_ocr_u:
        return True
    # 前缀命中（OCR 截断）：辛基十二醇月桂酰谷氨酸酯 ↔ 辛基十二醇月桂酰谷
    if len(n) >= 6:
        for L in (12, 10, 8, 6):
            if len(n) >= L and n[:L] in n_ocr:
                return True
    # 成分/INCI
    if re.search(
        r"提取物|油|酯|醇|烷|共聚|硅氧|肽|酸|苷|胶|C\d|INCI|[A-Z]{3,}",
        phrase,
        re.I,
    ) or re.search(r"[\u4e00-\u9fff]{2,}.*[（(][A-Za-z]", phrase):
        if _ingredient_soft_in_ocr(phrase, n_ocr):
            return True
    # 文案软匹配：·光感透亮 / 1步骤涂·精华液 ↔ 包装写法
    try:
        from app.phrase_soft import phrase_soft_in_ocr

        if phrase_soft_in_ocr(phrase, n_ocr, n_ocr_u):
            return True
    except Exception:
        pass
    # 生产信息：地址/公司名 OCR 易糊，锚点够就过
    if re.search(r"地址|有限公司|备案人|许可证|产地", phrase):
        cores = re.findall(
            r"[\u4e00-\u9fff]{2,8}(?:路|号|区|市|公司|科技|生物)", phrase
        )
        cores = [normalize(c) for c in cores]
        if cores:
            hit = sum(1 for c in cores if c in n_ocr or c[:4] in n_ocr)
            if hit >= max(1, len(cores) // 2):
                return True
        # 路名单独（含形近：环城北路↔调机环 等糊字时用门牌号+区）
        for road in re.findall(r"[\u4e00-\u9fff]{2,6}路", phrase):
            if normalize(road) in n_ocr or normalize(road)[:3] in n_ocr:
                return True
        nums = re.findall(r"\d{2,4}号", phrase)
        districts = re.findall(r"[\u4e00-\u9fff]{2,3}区", phrase)
        if nums and any(normalize(x) in n_ocr or x in n_ocr for x in nums):
            # 有门牌 +（区名或公司关键字）
            if districts and any(normalize(d)[:2] in n_ocr for d in districts):
                return True
            if any(k in n_ocr for k in ("科思", "宜侬", "伸燚", "伸懿", "生产企业", "奉贤")):
                return True
        # 南桥 / 环城 等关键地标碎片
        landmarks = re.findall(r"南桥|环城北路|光泰路|河庄|江东四路", phrase)
        if landmarks:
            hit_l = sum(
                1
                for lm in landmarks
                if normalize(lm) in n_ocr or normalize(lm)[:2] in n_ocr
            )
            if hit_l >= 1 and (nums and any(x[:3] in n_ocr for x in nums)):
                return True

    # 文案脚注：*“：”为设计图案，没有任何含义。
    if "设计图案" in phrase or ("任何含义" in phrase and "设计" in phrase):
        if "设计图案" in n_ocr or ("设计" in n_ocr and "含义" in n_ocr):
            return True
        if "没有任何含义" in n_ocr or "无任何含义" in n_ocr:
            return True
        # 冒号图案说明：OCR 常丢「设计图案」四字，只剩 *： 与 含义
        if re.search(r"[*＊].{0,6}[：:].{0,12}含义", n_ocr) or re.search(
            r"为设计|设计图|图案.*含义|含义.*图案", n_ocr
        ):
            return True
    # 模糊：长短语允许 partial
    if len(n) >= 8:
        sc = float(fuzz.partial_ratio(n[:48], n_ocr[:12000]))
        if sc >= 86:
            return True
    # 断行/插字：关键锚点多数命中
    if len(n) >= 10:
        anchors = re.findall(r"[\u4e00-\u9fff]{3,8}|[0-9]{1,2}-[0-9]{1,2}分钟?", phrase)
        anchors = [normalize(a) for a in anchors if len(normalize(a)) >= 3]
        seen: set[str] = set()
        uniq: list[str] = []
        for a in anchors:
            if a not in seen:
                seen.add(a)
                uniq.append(a)
        if len(uniq) >= 2:
            hit = sum(1 for a in uniq if a in n_ocr)
            if hit >= max(2, int(len(uniq) * 0.55)):
                return True
        mid = max(4, len(n) // 2)
        left, right = n[:mid], n[mid:]
        if len(left) >= 4 and len(right) >= 4 and left in n_ocr and right in n_ocr:
            return True
        core = re.findall(
            r"(?:静敷|揭下|涂抹|贴于|拍打|吸收|挤出|平整|洁面|停止使用|阳光直射|清水冲净)",
            phrase,
        )
        if core:
            ch = sum(1 for c in core if normalize(c) in n_ocr)
            if ch >= max(1, len(core) - 0):
                win = [n[i : i + 6] for i in range(0, max(1, len(n) - 5), 5)]
                wh = sum(1 for w in win if w in n_ocr)
                if wh >= max(1, int(len(win) * 0.45)):
                    return True
    return False


def coverage_against_ocr(excel_value: str, ocr_text: str) -> dict[str, Any]:
    phrases = key_phrases(excel_value, max_n=36)
    if not phrases:
        return {
            "coverage": 0.0,
            "matched": 0,
            "total": 0,
            "hit_phrases": [],
            "miss_phrases": [],
        }
    n_ocr = normalize(ocr_text or "")
    n_ocr_u = normalize_units(ocr_text or "")
    hits, misses = [], []
    for p in phrases:
        if _phrase_in_ocr(p, n_ocr, n_ocr_u):
            hits.append(p)
        else:
            misses.append(p)
    total = len(phrases)
    matched = len(hits)
    return {
        "coverage": (matched / total) if total else 0.0,
        "matched": matched,
        "total": total,
        "hit_phrases": hits[:12],
        "miss_phrases": misses[:12],
    }


def _word_box(w: dict) -> dict | None:
    loc = w.get("location") or {}
    if not (loc.get("width") or loc.get("height")):
        return None
    return {
        "page": int(w.get("page") or 1),
        "left": int(loc.get("left") or 0),
        "top": int(loc.get("top") or 0),
        "width": int(loc.get("width") or 0),
        "height": int(loc.get("height") or 0),
    }


def union_boxes(boxes: list[dict], *, pad: int = 4) -> list[dict]:
    """同页框合并为包围盒（每页一个），便于「整段落」高亮"""
    by_page: dict[int, list[dict]] = {}
    for b in boxes or []:
        if not b:
            continue
        p = int(b.get("page") or 1)
        by_page.setdefault(p, []).append(b)
    out = []
    for page, blist in sorted(by_page.items()):
        left = min(int(b.get("left") or 0) for b in blist) - pad
        top = min(int(b.get("top") or 0) for b in blist) - pad
        right = max(int(b.get("left") or 0) + int(b.get("width") or 0) for b in blist) + pad
        bottom = max(int(b.get("top") or 0) + int(b.get("height") or 0) for b in blist) + pad
        out.append(
            {
                "page": page,
                "left": max(0, left),
                "top": max(0, top),
                "width": max(2, right - left),
                "height": max(2, bottom - top),
            }
        )
    return out


def expand_block_boxes(
    seed_boxes: list[dict], ocr_words: list[dict], *, y_gap: float = 1.8, x_slack: float = 0.35
) -> list[dict]:
    """
    从种子命中行向上下扩展，吞掉同一栏连续的成分/说明文字行，
    得到「整段成分表」区域，而不是单行「成分：水」。
    """
    if not seed_boxes or not ocr_words:
        return seed_boxes or []
    seeds = list(seed_boxes)
    pages = {int(b.get("page") or 1) for b in seeds}
    collected: list[dict] = []
    for page in pages:
        page_seeds = [b for b in seeds if int(b.get("page") or 1) == page]
        page_words = []
        for w in ocr_words:
            if int(w.get("page") or 1) != page:
                continue
            box = _word_box(w)
            if box:
                page_words.append((w, box))
        if not page_words:
            collected.extend(page_seeds)
            continue
        # 种子垂直范围
        s_top = min(b["top"] for b in page_seeds)
        s_bot = max(b["top"] + b["height"] for b in page_seeds)
        s_left = min(b["left"] for b in page_seeds)
        s_right = max(b["left"] + b["width"] for b in page_seeds)
        med_h = sorted(b["height"] for b in page_seeds)[len(page_seeds) // 2] or 20
        gap = med_h * y_gap
        col_left = s_left - (s_right - s_left) * x_slack
        col_right = s_right + (s_right - s_left) * x_slack

        # 迭代扩展直到稳定
        top, bot = s_top, s_bot
        for _ in range(40):
            changed = False
            for _w, box in page_words:
                cx = box["left"] + box["width"] / 2
                if cx < col_left or cx > col_right:
                    continue
                btop, bbot = box["top"], box["top"] + box["height"]
                # 与当前带有重叠或紧邻
                if bbot >= top - gap and btop <= bot + gap:
                    nt, nb = min(top, btop), max(bot, bbot)
                    if nt < top - 0.5 or nb > bot + 0.5:
                        top, bot = nt, nb
                        changed = True
            if not changed:
                break
        # 收集带内所有词框
        block = []
        for _w, box in page_words:
            cx = box["left"] + box["width"] / 2
            mid_y = box["top"] + box["height"] / 2
            if col_left <= cx <= col_right and top - gap * 0.3 <= mid_y <= bot + gap * 0.3:
                block.append(box)
        if not block:
            block = page_seeds
        collected.extend(union_boxes(block, pad=6))
    return collected or seeds


def collect_phrase_boxes(
    phrases: list[str], ocr_words: list[dict], *, min_score: float = 88.0
) -> tuple[list[dict], list[str]]:
    """多短语 → 多个命中框 + 命中短语列表（用于整段定位）"""
    boxes: list[dict] = []
    hit_phrases: list[str] = []
    if not phrases or not ocr_words:
        return boxes, hit_phrases

    try:
        from app.inci_normalize import expand_query_variants
    except Exception:
        expand_query_variants = lambda p: [p]  # type: ignore

    for phrase in phrases:
        variants = expand_query_variants(phrase)
        n_ch = normalize(phrase)
        n_ch_u = normalize_units(phrase)
        if len(n_ch) < 3:
            continue
        # 过短且无信息（如单独「水」）不当种子，避免只框一个字
        if len(n_ch) <= 2:
            continue
        best_local = 0.0
        best_boxes: list[dict] = []
        for w in ocr_words:
            raw_w = w.get("text") or ""
            n_w = normalize(raw_w)
            if not n_w:
                continue
            sc = 0.0
            if n_ch in n_w or n_w in n_ch or n_ch_u in normalize_units(raw_w):
                sc = 100.0 if (n_ch in n_w or len(n_ch) >= 4 and n_w in n_ch) else 94.0
            else:
                sc = float(fuzz.partial_ratio(n_ch[:40], n_w))
                # 变体匹配
                for v in variants[1:]:
                    nv = normalize(v)
                    if nv and (nv in n_w or n_w in nv):
                        sc = max(sc, 96.0)
                        break
                    sc = max(sc, float(fuzz.partial_ratio(nv[:40], n_w)))
            if sc < min_score:
                continue
            box = _word_box(w)
            if sc > best_local and box:
                best_local = sc
                best_boxes = [box]
            elif sc >= min_score and box and sc >= best_local - 2:
                # 同短语可能跨多行 OCR
                best_boxes.append(box)
        # 多词拼接窗口（长 INCI）
        if best_local < 96 and len(n_ch) > 6:
            for i in range(len(ocr_words)):
                acc = ""
                win_boxes: list[dict] = []
                for j in range(i, min(i + 10, len(ocr_words))):
                    acc += ocr_words[j].get("text") or ""
                    b = _word_box(ocr_words[j])
                    if b:
                        win_boxes.append(b)
                    n_acc = normalize(acc)
                    if n_ch in n_acc:
                        if 100.0 >= best_local:
                            best_local = 100.0
                            best_boxes = win_boxes
                        break
                    sc = float(fuzz.partial_ratio(n_ch[:48], n_acc))
                    if sc > best_local and sc >= min_score:
                        best_local = sc
                        best_boxes = list(win_boxes)
        if best_local >= min_score and best_boxes:
            hit_phrases.append(phrase)
            boxes.extend(best_boxes)
    # 去重近似框
    uniq: list[dict] = []
    seen: set[tuple] = set()
    for b in boxes:
        key = (b["page"], b["left"] // 4, b["top"] // 4, b["width"] // 4)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(b)
    return uniq, hit_phrases


def _match_words(
    excel_value: str, ocr_words: list[dict]
) -> tuple[float, str, list[dict], int]:
    chunks = split_chunks(excel_value)
    if not chunks or not ocr_words:
        return 0.0, "", [], 0

    best_score = 0.0
    best_chunk = ""
    best_boxes: list[dict] = []
    best_page = 0

    for ch in chunks:
        n_ch = normalize(ch)
        n_ch_u = normalize_units(ch)
        if len(n_ch) < 2:
            continue
        # 短噪声块（仅「水」「油」）权重降低
        short_penalty = len(n_ch) <= 2
        for w in ocr_words:
            n_w = normalize(w.get("text") or "")
            n_w_u = normalize_units(w.get("text") or "")
            if not n_w:
                continue
            if n_ch in n_w or n_w in n_ch or n_ch_u == n_w_u or n_ch_u in n_w_u:
                score = 100.0 if (n_ch in n_w or n_ch_u == n_w_u) else 96.0
            else:
                score = max(
                    float(fuzz.partial_ratio(n_ch, n_w)),
                    float(fuzz.partial_ratio(n_ch_u, n_w_u)),
                )
            if short_penalty:
                score = min(score, 82.0)
            if score > best_score:
                best_score = score
                best_chunk = ch
                loc = w.get("location") or {}
                page = int(w.get("page") or 1)
                best_page = page
                box = _word_box(w)
                best_boxes = [box] if box else []
        if len(n_ch) > 8:
            for i in range(len(ocr_words)):
                acc = ""
                boxes = []
                for j in range(i, min(i + 10, len(ocr_words))):
                    acc += ocr_words[j].get("text") or ""
                    b = _word_box(ocr_words[j])
                    if b:
                        boxes.append(b)
                    n_acc = normalize(acc)
                    if n_ch in n_acc or n_ch_u in normalize_units(acc):
                        if 100.0 > best_score:
                            best_score = 100.0
                            best_chunk = ch
                            best_boxes = boxes
                            best_page = int(ocr_words[j].get("page") or 1)
                        break
                    sc = float(fuzz.partial_ratio(n_ch, n_acc))
                    if sc > best_score:
                        best_score = sc
                        best_chunk = ch
                        best_boxes = boxes
                        best_page = int(ocr_words[min(j, len(ocr_words) - 1)].get("page") or 1)

    return best_score, best_chunk, best_boxes, best_page

def _primary_compare_text(field: str, excel_value: str) -> str:
    """
    中文品名等字段 Excel 常夹带「命名依据」说明，不必印在包装上。
    比对主行：取首行/首句作为主比对文本。
    """
    fg = field_group(field)
    text = excel_value or ""
    if fg in ("中文品名", "英文品名", "logo标识"):
        # 第一行作为品名
        first = re.split(r"[\n\r]+", text.strip())[0].strip()
        # 去掉「1.命名依据」后的说明
        first = re.split(r"\d+[.．、]命名", first)[0].strip()
        return first or text
    return text


# OCR 置信度阈值：低于此 → 疑点分桶 ocr_unclear（看不清）
OCR_PROB_LOW = 0.82


def _dedupe_miss_phrases(misses: list[str]) -> list[str]:
    """去子串冗余：保留较长完整句，丢掉被包含的碎片（如「没有任何含义。」）。"""
    cleaned: list[str] = []
    for m in misses or []:
        s = (m or "").strip()
        if not s:
            continue
        cleaned.append(s)
    # 长优先
    cleaned.sort(key=lambda x: (-len(normalize(x)), x))
    kept: list[str] = []
    for m in cleaned:
        nm = normalize(m)
        if not nm:
            continue
        # 已被更长句包含 → 丢
        if any(nm != normalize(k) and nm in normalize(k) for k in kept):
            continue
        # 新句包含已保留短句 → 替换
        kept = [k for k in kept if normalize(k) not in nm or normalize(k) == nm]
        if not any(normalize(k) == nm for k in kept):
            kept.append(m)
    return kept[:12]


def assign_doubt_bucket(hit: dict) -> str | None:
    """
    疑点分桶：typo | ocr_unclear | branch | noise | reverse | coverage
    一致/跳过 → None
    真漏字(typo)：硬规则缺字/漏空格、品名单字错；文案脚注未见 → coverage
    """
    st = hit.get("status")
    if st in ("一致", "跳过"):
        return None
    if hit.get("hard_typos") or hit.get("doubt_bucket") == "typo":
        return "typo"
    if "硬规则·缺字" in (hit.get("evidence") or "") or "漏空格" in (hit.get("evidence") or ""):
        return "typo"
    if hit.get("ocr_low_confidence") or hit.get("doubt_bucket") == "ocr_unclear":
        return "ocr_unclear"
    ev = hit.get("evidence") or ""
    fg = hit.get("field_group") or ""
    cat = hit.get("category") or ""
    cov_miss = list(
        (hit.get("coverage") or {}).get("miss")
        or (hit.get("coverage") or {}).get("miss_phrases")
        or []
    )
    if cat == "reverse_extra" or "反向" in (hit.get("field") or ""):
        return "reverse"
    if fg in ("净含量", "条形码") and (
        "装型" in ev or "分支" in ev or "规格" in ev or "部分条码" in ev
    ):
        return "branch"
    seq = hit.get("sequence_diff") or {}
    only_pack = seq.get("only_in_pack") or hit.get("reverse_extras") or []
    only_excel = seq.get("only_in_excel") or []
    if only_pack and not only_excel and st == "疑点":
        return "noise"
    # 文案：条款/脚注未见 = 覆盖问题，绝不标「真漏字」
    if fg == "文案" and st in ("疑点", "缺失"):
        return "coverage"
    if only_excel and st in ("疑点", "缺失"):
        if fg in ("中文品名",) and any(len(normalize(x)) <= 6 for x in only_excel[:3]):
            return "typo"
        return "coverage"
    if cov_miss and st in ("疑点", "缺失"):
        # 长条款/整句未见 → coverage；短词（≤4）且品名类 → typo
        if fg in ("中文品名", "英文品名") and any(
            len(normalize(m)) <= 4 for m in cov_miss[:3]
        ):
            return "typo"
        return "coverage"
    if st == "缺失":
        return "coverage"
    if "备注" in ev:
        return "coverage"
    return "coverage"


def match_field(
    field: str,
    excel_value: str,
    ocr_words: list[dict],
    ocr_text: str,
    *,
    remark: str = "",
    pack_profile: dict | None = None,
    zone_scope: str | None = None,
    locate_words: list[dict] | None = None,
) -> dict:
    if _is_noise_text(excel_value):
        return {
            "field": field,
            "excel_value": (excel_value or "")[:1200],
            "status": "跳过",
            "evidence": "空值/噪声字段，已跳过",
            "score": 0.0,
            "decision": "ignore",
            "bboxes": [],
            "page": 1,
            "field_group": field_group(field),
            "noise": True,
            "coverage": None,
        }

    fg = field_group(field)
    compare_text = _primary_compare_text(field, excel_value)
    long_mode = fg in LONG_FIELD_GROUPS or (
        len(excel_value or "") >= 80 and fg not in ("中文品名", "英文品名", "logo标识")
    )
    cov_source = compare_text if fg in ("中文品名", "英文品名", "logo标识") else excel_value
    phrases = key_phrases(cov_source, max_n=48 if long_mode else 16)

    # 单点最佳（短字段）
    score, chunk, boxes, page = _match_words(compare_text, ocr_words)
    if score < SCORE_WARN and ocr_text:
        n_ocr = normalize(ocr_text)
        n_ocr_u = normalize_units(ocr_text)
        for ch in split_chunks(compare_text):
            n_ch = normalize(ch)
            n_ch_u = normalize_units(ch)
            if len(n_ch) < 2:
                continue
            if n_ch in n_ocr or n_ch_u in n_ocr_u:
                score, chunk = 100.0, ch
                break
            sc = max(
                float(fuzz.partial_ratio(n_ch, n_ocr)),
                float(fuzz.partial_ratio(n_ch_u, n_ocr_u)),
            )
            if sc > score:
                score, chunk = sc, ch

    # 长字段：短语定位；成分/生产用整段扩展，文案/用法定点多框（避免一条窄带）
    multi_boxes: list[dict] = []
    hit_ph: list[str] = []
    if long_mode and phrases:
        multi_boxes, hit_ph = collect_phrase_boxes(phrases, ocr_words, min_score=86.0)
        if multi_boxes:
            if fg in ("成分表", "生产信息"):
                multi_boxes = expand_block_boxes(multi_boxes, ocr_words)
            elif fg in ("文案", "使用方法"):
                # 多点保留，勿扩成无意义大框/窄条
                multi_boxes = union_boxes(multi_boxes, pad=6) if len(multi_boxes) > 8 else multi_boxes
            else:
                multi_boxes = union_boxes(multi_boxes, pad=8)
            boxes = multi_boxes
            page = boxes[0]["page"] if boxes else page
            if hit_ph:
                chunk = hit_ph[0]

    cov = coverage_against_ocr(cov_source, ocr_text or "")
    # 合并 bbox 命中 + 软匹配命中
    if long_mode and phrases:
        n_ocr_m = normalize(ocr_text or "")
        n_ocr_u_m = normalize_units(ocr_text or "")
        hit_set = {normalize(x) for x in hit_ph}
        text_hits = [
            p
            for p in phrases
            if normalize(p) in hit_set or _phrase_in_ocr(p, n_ocr_m, n_ocr_u_m)
        ]
        seen_h: set[str] = set()
        merged_hit: list[str] = []
        for p in list(hit_ph) + text_hits:
            k = normalize(p)
            if k and k not in seen_h:
                seen_h.add(k)
                merged_hit.append(p)
        miss_ph = [p for p in phrases if normalize(p) not in seen_h]
        # 软匹配再滤一轮 miss
        miss_ph = [p for p in miss_ph if not _phrase_in_ocr(p, n_ocr_m, n_ocr_u_m)]
        miss_ph = _dedupe_miss_phrases(miss_ph)
        if merged_hit or cov.get("matched", 0):
            m_cnt = len(merged_hit) if merged_hit else int(cov.get("matched") or 0)
            # 用软匹配后的 hit/miss 为准
            total_p = max(1, len(phrases))
            # recompute matched = total - miss（miss 已去子串冗余，分母仍用 phrases 总数）
            m_cnt = max(0, total_p - len(miss_ph))
            cov = {
                "coverage": m_cnt / total_p,
                "matched": m_cnt,
                "total": total_p,
                "hit_phrases": merged_hit[:12],
                "miss_phrases": miss_ph[:12],
            }

    # 条码：按「规格分支」评估（护肤品常 5片/1片 两码，花盒只印一码）
    # miss 只计「当前装必检码」，忽略装不进 miss / 待处理
    if fg == "条形码":
        codes = re.findall(r"\d{8,14}", excel_value or "")
        if codes:
            n_ocr = normalize(ocr_text or "")
            must_codes, ign_codes = codes, []
            try:
                from app.pack_profile import required_barcodes

                must_codes, ign_codes = required_barcodes(
                    excel_value or "", pack_profile or {}
                )
                if not must_codes and not ign_codes:
                    must_codes, ign_codes = codes, []
            except Exception:
                must_codes, ign_codes = codes, []
            hit_c = [c for c in must_codes if c in n_ocr]
            miss_c = [c for c in must_codes if c not in n_ocr]
            # 仅必检码参与 coverage；忽略码不进 miss_phrases（避免 UI「建议核对」）
            total_req = max(1, len(must_codes))
            cov = {
                "coverage": len(hit_c) / total_req,
                "matched": len(hit_c),
                "total": total_req,
                "hit_phrases": hit_c,
                "miss_phrases": miss_c,  # 仅必检未命中
                "ignored_codes": ign_codes,
            }
            code_boxes, _ = collect_phrase_boxes(
                must_codes or codes, ocr_words, min_score=95.0
            )
            if code_boxes:
                boxes = code_boxes
            if not hit_c and must_codes:
                score = min(score, 40.0)
            elif miss_c:
                score = 72.0
            else:
                # 必检全中；有忽略码未印 = 规格分支一致
                score = max(score, 95.0)

    # 净含量：拆「装型分支」（5片装/单片装）；装型画像只考核当前装
    net_branch_info: dict[str, Any] | None = None
    if fg == "净含量":
        branches = [
            ln.strip()
            for ln in re.split(r"[\n\r]+", excel_value or "")
            if ln.strip()
        ] or [excel_value or ""]
        active = str((pack_profile or {}).get("active_piece") or "")
        if active:
            focused = []
            for br in branches:
                if active == "5" and re.search(r"5\s*片", br):
                    focused.append(br)
                elif active == "1" and re.search(r"单片|1\s*片", br):
                    focused.append(br)
            if focused:
                branches = focused
        n_ocr = normalize(ocr_text or "")
        n_ocr_u = normalize_units(ocr_text or "")
        pack_raw = ocr_text or ""
        # 膜袋常见：只印「净含量：（2ml+28ml）/片」不写「单片装」字样
        pouch_single_like = bool(
            re.search(r"净含量", pack_raw)
            and re.search(r"/\s*片", pack_raw)
            and not re.search(r"[×xX]\s*[2-9]|[2-9]\s*片装|[2-9]\s*片\s*[：:]", pack_raw)
        )
        multi_pack_on = bool(
            re.search(r"[×xX]\s*[2-9]|[2-9]\s*片装|片\s*[×xX]\s*[2-9]", pack_raw)
        )

        def _piece_marker_on_pack(n: str) -> bool:
            """禁止用裸数字 '5' 误判；要求「N片 / ×N」装型标记。"""
            if not n:
                return False
            return bool(
                re.search(
                    rf"(?:^|[^\d]){re.escape(n)}\s*片|[×xX]\s*{re.escape(n)}|"
                    rf"片\s*[×xX]\s*{re.escape(n)}",
                    pack_raw,
                )
            )

        hit_br, miss_br = [], []
        for br in branches:
            nu = normalize_units(br)
            nn = normalize(br)
            ok = False
            piece = re.search(r"(\d+)\s*片", br)
            single = bool(re.search(r"单片", br))
            # 装型关键词必须在包装出现（避免 5片花盒误报「单片装也命中」）
            if single:
                if re.search(r"单片|1\s*片", pack_raw) or (
                    active == "1" and pouch_single_like
                ):
                    pass  # 装型门通过，继续正文匹配
                else:
                    ok = False
                    (hit_br if ok else miss_br).append(br[:60])
                    continue
            elif piece and not _piece_marker_on_pack(piece.group(1)):
                # 片数标记对不上（裸数字不算）
                if not (active == piece.group(1) and piece.group(1) == "1" and pouch_single_like):
                    ok = False
                    (hit_br if ok else miss_br).append(br[:60])
                    continue
            # 正文：完整句 / 单位归一 / ml 量
            body = re.sub(r"^(?:单片装|5\s*片装|\d+\s*片装)\s*[:：]?", "", br).strip()
            body_n = normalize(body)
            body_u = normalize_units(body)
            if len(nn) >= 6 and (nn in n_ocr or nu in n_ocr_u):
                ok = True
            elif body_n and len(body_n) >= 6 and (body_n in n_ocr or body_u in n_ocr_u):
                ok = True
            else:
                nums = re.findall(r"\d+(?:\.\d+)?(?:ml|g)", body_u or nu, flags=re.I)
                if nums and all(
                    normalize(x) in n_ocr_u or x.replace(" ", "") in n_ocr_u for x in nums
                ):
                    if single or (active == "1" and re.search(r"单片|1\s*片", br)):
                        ok = bool(re.search(r"单片|1\s*片", pack_raw)) or pouch_single_like
                    elif piece:
                        ok = _piece_marker_on_pack(piece.group(1)) or (
                            piece.group(1) == "5" and multi_pack_on
                        )
                    else:
                        ok = True
            (hit_br if ok else miss_br).append(br[:60])
        net_branch_info = {
            "hit": hit_br,
            "miss": miss_br,
            "total": len(branches),
        }
        cov = {
            "coverage": (len(hit_br) / len(branches)) if branches else 0.0,
            "matched": len(hit_br),
            "total": len(branches),
            "hit_phrases": hit_br,
            "miss_phrases": miss_br,
        }
        if hit_br and not miss_br:
            score = max(score, 95.0)
            chunk = hit_br[0]
        elif hit_br and miss_br:
            # 护肤品：确认单常写多规格，包装只印当前装 — 疑点非缺失
            score = 78.0
            chunk = hit_br[0]
        else:
            score = min(score, 55.0)
        # 证据话术：标明装型画像依据（优先条码→单片/5片）
        if hit_br:
            act = (pack_profile or {}).get("active_piece")
            how = ""
            if (pack_profile or {}).get("piece_from_barcode"):
                how = "（由包装条码推断装型）"
            elif act:
                how = f"（装型画像≈{act}片）"
            show = hit_br[0]
            # 优先展示与 active 一致的分支文案
            if active == "1":
                for x in hit_br:
                    if re.search(r"单片|1\s*片", x):
                        show = x
                        break
            elif active == "5":
                for x in hit_br:
                    if re.search(r"5\s*片", x):
                        show = x
                        break
            net_branch_info["evidence_hint"] = (
                f"净含量装型命中「{show[:40]}」{how}"
            )

    # 二维码：图形区 + 引导/品牌词即可；勿要求「扫码关注…」整句 OCR 命中
    if fg == "二维码":
        n_ocr = normalize(ocr_text or "")
        keys = ["扫码", "公众号", "关注", "二维码", "qr", "微信", "公号"]
        has_guide = any(normalize(k) in n_ocr for k in keys)
        val_n = normalize(excel_value or "")
        has_val = len(val_n) >= 4 and (
            val_n in n_ocr or float(fuzz.partial_ratio(val_n, n_ocr[:2000])) >= 80
        )
        # 确认单里的品牌/主体词（去掉扫码关注等虚词）
        brand_toks = [
            t
            for t in re.findall(r"[\u4e00-\u9fff]{2,}", excel_value or "")
            if t not in ("扫码", "关注", "微信", "二维码", "请")
        ]
        brand_hits = [t for t in brand_toks if normalize(t) in n_ocr]
        # 译龄 + 公众号 / 扫码 + 公众号 → 视为引导齐全
        strong_guide = has_guide and (
            bool(brand_hits)
            or ("公众号" in n_ocr and any(k in n_ocr for k in ("扫码", "关注", "微信", "公号")))
            or ("译龄" in n_ocr and "公众号" in n_ocr)
        )
        if has_val:
            score = max(score, 95.0)
            cov = {
                "coverage": 1.0,
                "matched": 1,
                "total": 1,
                "hit_phrases": [excel_value[:40]],
                "miss_phrases": [],
            }
        elif strong_guide:
            score = max(score, 92.0)
            hit_show = "、".join(brand_hits[:3]) if brand_hits else "公众号/扫码引导"
            cov = {
                "coverage": 1.0,
                "matched": 2,
                "total": 2,
                "hit_phrases": [hit_show, "扫码引导区"],
                "miss_phrases": [],
            }
            chunk = chunk or hit_show
        elif has_guide:
            score = 80.0
            cov = {
                "coverage": 0.6,
                "matched": 1,
                "total": 2,
                "hit_phrases": ["扫码引导区"],
                "miss_phrases": [excel_value[:40] if excel_value else "品牌引导文案"],
            }
        else:
            score = min(score, 50.0)
            cov = {
                "coverage": 0.0,
                "matched": 0,
                "total": 1,
                "hit_phrases": [],
                "miss_phrases": [excel_value[:40] if excel_value else "二维码文案"],
            }

    # 长字段：覆盖率决定结论；禁止「只命中一句水」变一致
    if long_mode and cov.get("total", 0) >= 3:
        cov_pct = cov["coverage"] * 100
        # 单点 100 分不能盖过低覆盖
        score = min(float(score), max(cov_pct, float(score) * 0.25 + cov_pct * 0.75))
        # 极短代表句命中不算数
        if chunk and len(normalize(chunk)) <= 3 and cov["coverage"] < 0.6:
            score = min(score, 55.0)
        n_box = len(boxes or [])
        if cov["coverage"] >= 0.78 and score >= 85:
            status = "一致"
            ev = (
                f"整段覆盖 {cov['matched']}/{cov['total']} 关键短语 · "
                f"定位 {n_box} 区 · 例「{(chunk or '')[:28]}」"
            )
        elif cov["coverage"] >= 0.4:
            status = "疑点"
            miss = "、".join((cov.get("miss_phrases") or [])[:4])
            ev = (
                f"仅覆盖 {cov['matched']}/{cov['total']} 关键短语 · 定位 {n_box} 区"
                + (f" · 未见缺失：{miss}" if miss else "")
            )
        else:
            status = "缺失" if cov["coverage"] < 0.22 else "疑点"
            miss = "、".join((cov.get("miss_phrases") or [])[:5])
            ev = (
                f"覆盖偏低 {cov['matched']}/{cov['total']} · 定位 {n_box} 区"
                + (f" · 未见缺失：{miss}" if miss else "")
            )
    elif fg == "净含量" and net_branch_info:
        hit_br, miss_br = net_branch_info["hit"], net_branch_info["miss"]
        if hit_br and not miss_br:
            hint = net_branch_info.get("evidence_hint") or (
                f"净含量装型命中「{hit_br[0][:36]}」"
            )
            status, ev = "一致", hint
        elif hit_br and miss_br:
            status = "疑点"
            ev = (
                f"包装命中 {len(hit_br)}/{net_branch_info['total']} 种装型"
                f"（已命中：{'；'.join(hit_br[:2])}；"
                f"未见：{'；'.join(miss_br[:2])}）· 护肤品常见「确认单多规格/包装单规格」"
            )
        else:
            status = "缺失" if score < 50 else "疑点"
            ev = f"净含量装型未在包装找到 · best score={score:.0f}"
    elif fg == "二维码":
        if score >= SCORE_OK and (cov or {}).get("coverage", 0) >= 0.85:
            status, ev = (
                "一致",
                f"二维码引导/品牌命中「{(chunk or excel_value or '')[:36]}」"
                f"（图形码区+文案引导，不要求整句 OCR）",
            )
        elif score >= SCORE_WARN:
            status, ev = "疑点", f"仅见弱引导 · score={score:.0f} · 请人眼看公众号/码区"
        else:
            status, ev = "缺失", f"未见扫码引导/二维码相关文案 · score={score:.0f}"
    elif fg == "条形码":
        if score >= SCORE_OK:
            status, ev = "一致", f"条码全部命中 score={score:.0f}"
        elif score >= SCORE_WARN:
            miss = "、".join((cov or {}).get("miss_phrases") or [])[:40]
            status, ev = (
                "疑点",
                f"部分条码命中（规格分支）· 未见 {miss or '部分码'} · 花盒/膜袋常只印一码",
            )
        else:
            status, ev = "缺失", f"包装未见确认单条码 · score={score:.0f}"
    elif fg == "logo标识":
        # 短语全覆盖时以 coverage 为准（best chunk 常被「译龄」短词拖到 82）
        cov_r = float((cov or {}).get("coverage") or 0)
        miss_n = len((cov or {}).get("miss_phrases") or [])
        if cov_r >= 0.85 and miss_n == 0:
            score = max(float(score), 95.0)
            status, ev = (
                "一致",
                f"logo 短语已覆盖 {(cov or {}).get('matched')}/{(cov or {}).get('total')} · "
                f"命中「{(chunk or excel_value or '')[:36]}」",
            )
        elif score >= SCORE_OK or (cov_r >= 0.5 and score >= SCORE_WARN):
            status, ev = (
                "一致" if score >= SCORE_OK else "疑点",
                f"命中「{(chunk or '')[:40]}」 score={score:.0f}",
            )
        elif score >= SCORE_WARN:
            status, ev = "疑点", f"弱匹配「{(chunk or '')[:40]}」 score={score:.0f}"
        else:
            status, ev = "缺失", f"未找到 logo/商标（best={score:.0f}）"
    else:
        if score >= SCORE_OK:
            status, ev = "一致", f"命中「{(chunk or '')[:40]}」 score={score:.0f}"
        elif score >= SCORE_WARN:
            status, ev = "疑点", f"弱匹配「{(chunk or '')[:40]}」 score={score:.0f}"
        else:
            status, ev = "缺失", f"未找到接近内容（best={score:.0f}「{(chunk or '')[:30]}」）"

    # 短字段也禁止「coverage=0 却一致」（证据诚实）
    if (
        not long_mode
        and status == "一致"
        and cov
        and cov.get("total", 0) > 0
        and (cov.get("coverage") or 0) < 0.35
        and fg not in ("中文品名", "英文品名", "logo标识")
    ):
        status = "疑点"
        ev = f"短语命中但装型/覆盖不足（{cov.get('matched')}/{cov.get('total')}）· " + ev

    if any(k in field for k in SOFT_FIELDS) and status == "缺失":
        status = "疑点"
        ev = "规格/条码类可能分支 · " + ev

    if fg == "净含量" and status == "疑点" and score >= 75:
        if "装型" not in (ev or ""):
            ev = "单位/装型可能不一致 · " + ev
    if remark:
        ev = ev + f" · Excel备注：{remark[:80]}"

    if remark and len(remark) >= 6:
        # 备注常含工厂指示（「花盒上要写明…」），包装只需落地关键点
        n_ocr_r = normalize(ocr_text or "")
        pack_must = re.findall(
            r"(?:第[一二三四五六1-6]步|步骤\s*0*[1-6]|扫码|公众号|商标|备案)",
            remark,
        )
        if pack_must:
            def _remark_key_on_pack(m: str) -> bool:
                nm = normalize(m)
                if nm and nm in n_ocr_r:
                    return True
                if re.search(r"一|1", m):
                    return any(k in n_ocr_r for k in ("第一步", "步骤01", "步骤1", "①"))
                if re.search(r"二|2", m):
                    return any(k in n_ocr_r for k in ("第二步", "步骤02", "步骤2", "②"))
                return False

            uniq = list(dict.fromkeys(pack_must))
            must_hit = sum(1 for m in uniq if _remark_key_on_pack(m))
            if must_hit < len(uniq) and status == "一致":
                status = "疑点"
                ev = (
                    f"正文已命中，但备注关键点未齐（{must_hit}/{len(uniq)}）· "
                    + ev
                )
        else:
            remark_cov = coverage_against_ocr(remark, ocr_text or "")
            if remark_cov["total"] and remark_cov["coverage"] < 0.5 and status == "一致":
                status = "疑点"
                ev = (
                    f"正文已命中，但备注要求覆盖 {remark_cov['matched']}/{remark_cov['total']} · "
                    + ev
                )

    # 前端：同时给 union 大框 + 原始多框（高亮整段）
    display_boxes = boxes or []
    if long_mode and display_boxes and len(display_boxes) > 1:
        # 已在 expand 里 union 过；若仍是多页则保留
        display_boxes = union_boxes(display_boxes, pad=4) if fg != "条形码" else display_boxes

    # —— 证据框：必须用「全页 OCR 词」定位，不能只用 zone 词（logo 常在底部）——
    words_for_locate = locate_words if locate_words is not None else ocr_words
    try:
        from app.evidence_locate import refine_field_boxes

        page_h = 2400
        page_w = 2200
        for w in words_for_locate or []:
            loc = w.get("location") or {}
            page_h = max(
                page_h,
                int(loc.get("top") or 0) + int(loc.get("height") or 0) + 40,
            )
            page_w = max(
                page_w,
                int(loc.get("left") or 0) + int(loc.get("width") or 0) + 40,
            )
        refined = refine_field_boxes(
            field_group=fg,
            field=field,
            excel_value=excel_value or "",
            primary_query=compare_text or "",
            ocr_words=words_for_locate or [],
            existing_boxes=[],
            miss_phrases=list(cov.get("miss_phrases") or []),
            hit_phrases=list(cov.get("hit_phrases") or []),
            page_w=page_w,
            page_h=page_h,
        )
        if refined:
            display_boxes = refined
            page = display_boxes[0].get("page") or page
            # 证据模式：有黄框=疑点优先 · 仅绿框=命中
            if any(b.get("role") in ("check", "miss_anchor") for b in refined):
                # keep
                pass
        elif fg in ("logo标识", "中文品名", "英文品名", "净含量", "条形码", "二维码"):
            # 全文再扫一遍兜底（不继承错误 zone 框）
            display_boxes = []
        elif not refined and display_boxes:
            pass
        else:
            display_boxes = refined or []
    except Exception:
        pass

    # —— 供应链硬规则：明显缺字/漏空格 → 直接「缺失」（非疑点）——
    hard_typo_issues: list = []
    force_typo_bucket = False
    try:
        from app.typo_hard import apply_hard_typo_status

        if fg in ("logo标识", "文案", "英文品名", "中文品名") or re.search(
            r"Grrshula|Cell", excel_value or "", re.I
        ):
            st2, ev2, _bkt, hard_typo_issues = apply_hard_typo_status(
                status=status,
                evidence=ev or "",
                excel_value=excel_value or "",
                ocr_text=ocr_text or "",
                field_group=fg,
            )
            if hard_typo_issues:
                status, ev = st2, ev2
                force_typo_bucket = True
    except Exception:
        hard_typo_issues = []
        force_typo_bucket = False

    # miss 非空 → 进入待处理（疑点），忽略装条码除外
    hard_miss = list(cov.get("miss_phrases") or [])
    if hard_miss and status == "一致":
        if fg == "成分表":
            # 覆盖已较高时：多半是 OCR 断字/糊字，标疑点但措辞降级
            ratio = float(cov.get("coverage") or 0)
            status = "疑点"
            if ratio >= 0.72 and len(hard_miss) <= 10:
                ev = (
                    f"主体已覆盖({int(ratio*100)}%)，{len(hard_miss)} 项 OCR 弱/未见"
                    f"（常见断行糊字，请在本步骤整段内肉眼核）："
                    + "、".join(m[:14] for m in hard_miss[:4])
                    + " · "
                    + (ev or "")
                )
            else:
                ev = (
                    f"主体已覆盖，仍有 {len(hard_miss)} 项未见/OCR 弱："
                    + "、".join(m[:16] for m in hard_miss[:3])
                    + " · "
                    + (ev or "")
                )
        elif fg == "生产信息" and any(
            "地址" in m or "路" in m or "号" in m for m in hard_miss
        ):
            status = "疑点"
            ev = (
                "生产地址等关键项可能未见或 OCR 丢失："
                + "、".join(m[:24] for m in hard_miss[:2])
                + " · "
                + (ev or "")
            )
        elif fg == "文案" and hard_miss:
            # 脚注未见：待人核；证据首行写清「漏印的是哪几句」
            status = "疑点"
            uniq_miss = _dedupe_miss_phrases(hard_miss)
            # 编号列出，避免「真漏字却看不出漏啥」
            numbered = " ".join(
                f"{i+1})「{m[:48]}」" for i, m in enumerate(uniq_miss[:5])
            )
            ev = (
                f"【可能漏印原文】{numbered}。"
                f"请在包装脚注区逐条核对是否印出（主体卖点已覆盖时，通常是星号条款/设计说明漏印或 OCR 未识）。 · "
                + (ev or "")
            )
            # 写回去重后的 miss，供前端列表展示
            cov["miss_phrases"] = uniq_miss
            if "miss" in cov:
                cov["miss"] = uniq_miss
        elif fg == "条形码" and hard_miss:
            # 仅必检码 miss 才会进 hard_miss
            status = "疑点"
            ev = (
                "必检条码未见："
                + "、".join(hard_miss[:3])
                + " · "
                + (ev or "")
            )

    # 二维码：一致也进待处理，强制人扫确认（C 端）
    if fg == "二维码" and status == "一致":
        status = "疑点"
        ev = (
            "二维码需人工扫码确认是否跳转正确（机审仅校验引导文案/码区存在） · "
            + (ev or "")
        )

    # OCR 置信度：缺失/低覆盖时若区域字置信度低 → 看不清（非硬缺失）
    ocr_low = False
    ocr_prob = None
    try:
        from app.ocr_postprocess import avg_prob_in_boxes

        ocr_prob = avg_prob_in_boxes(ocr_words, display_boxes)
        if ocr_prob is None:
            ocr_prob = avg_prob_in_boxes(ocr_words, None)
        if (
            ocr_prob is not None
            and ocr_prob < OCR_PROB_LOW
            and status in ("缺失", "疑点")
            and (cov.get("coverage") or 0) < 0.78
        ):
            ocr_low = True
            if status == "缺失":
                status = "疑点"
            ev = (
                f"OCR 置信度偏低({ocr_prob:.2f})，可能看不清而非漏印 · "
                + (ev or "")
            )
    except Exception:
        pass

    # 文案疑点：避免重复堆叠；若尚无「可能漏印原文」则补一句
    if status == "疑点" and fg == "文案":
        miss_show = _dedupe_miss_phrases(list(cov.get("miss_phrases") or []))[:4]
        if miss_show and "可能漏印原文" not in (ev or ""):
            numbered = " ".join(
                f"{i+1})「{m[:48]}」" for i, m in enumerate(miss_show)
            )
            ev = (
                f"【可能漏印原文】{numbered}。"
                f"（写法差异如「1步骤」vs「步骤.涂」已做软匹配） · "
                + (ev or "")
            )
        cov["miss_phrases"] = miss_show
        if isinstance(cov.get("miss"), list) or cov.get("miss") is None:
            cov["miss"] = miss_show

    hit_out = {
        "field": field,
        "excel_value": (excel_value or "")[:1200],
        "remark": (remark or "")[:400],
        "status": status,
        "evidence": ev,
        "score": round(float(score), 2),
        "decision": "pending",
        "bboxes": display_boxes,
        "page": page or (display_boxes[0]["page"] if display_boxes else 1),
        "field_group": fg,
        "no_bbox": not bool(display_boxes),
        "bbox_mode": (
            "dual_track"
            if any(
                (b.get("role") in ("check", "miss_anchor"))
                for b in (display_boxes or [])
            )
            and any(
                (b.get("role") in (None, "hit")) for b in (display_boxes or [])
            )
            else (
                "evidence_points"
                if any((b.get("role") == "check") for b in (display_boxes or []))
                else (
                    "multi"
                    if len(display_boxes or []) > 1
                    else ("block" if long_mode and display_boxes else "point")
                )
            )
        ),
        "bbox_legend": {
            "hit": "蓝/绿框 = 包装上已命中的字",
            "check": "黄框 = 疑点/漏印请核这里",
        },
        "coverage": {
            "ratio": round(cov["coverage"], 3),
            "matched": cov["matched"],
            "total": cov["total"],
            "miss": (cov.get("miss_phrases") or [])[:8],
            "hit": (cov.get("hit_phrases") or [])[:8],
        }
        if cov.get("total")
        else None,
        "long_field": long_mode,
        "match_mode": "block_coverage" if long_mode and cov.get("total", 0) >= 3 else "phrase",
        "zone_scope": zone_scope,
        "ocr_prob": round(ocr_prob, 4) if ocr_prob is not None else None,
        "ocr_low_confidence": ocr_low,
        "evidence_roles": {
            "check": sum(1 for b in (display_boxes or []) if b.get("role") == "check"),
            "hit": sum(
                1
                for b in (display_boxes or [])
                if b.get("role") in (None, "hit", "context")
            ),
        },
    }
    hit_out["doubt_bucket"] = assign_doubt_bucket(hit_out)
    if force_typo_bucket:
        hit_out["doubt_bucket"] = "typo"
        hit_out["hard_typos"] = hard_typo_issues
        hit_out["status"] = "缺失"  # 硬规则压过后续降级
    return hit_out

def compare_fields(
    fields: list[dict],
    ocr_words: list[dict],
    ocr_text: str,
    *,
    attach_sequence_diff: bool = True,
    pack_profile: dict | None = None,
    excel_joined: str | None = None,
    zones: dict | None = None,
) -> list[dict]:
    hits = []
    try:
        from app.inci_normalize import pack_text_for_match

        ocr_for_match = (ocr_text or "") + "\n" + pack_text_for_match(ocr_text or "")
    except Exception:
        ocr_for_match = ocr_text or ""

    # 确认单全文 SSOT：反向 only_in_pack 对照全表，避免成分串到文案/用法
    if excel_joined is None:
        excel_joined = "\n".join(
            (f.get("excel_value") or "") + "\n" + (f.get("remark") or "")
            for f in fields
        )

    for i, f in enumerate(fields):
        if skip_sheet_field(f.get("field") or ""):
            continue
        fg_pre = field_group(f["field"])
        zone_scope = "full"
        match_words = ocr_words
        match_text = ocr_for_match
        try:
            from app import layout_zones as _lz

            scoped_text, scoped_words, zone_scope = _lz.pack_scope_for_field(
                fg_pre, ocr_words, zones, ocr_for_match
            )
            if scoped_text:
                match_text = scoped_text
            if scoped_words:
                match_words = scoped_words
        except Exception:
            pass

        h = match_field(
            f["field"],
            f.get("excel_value") or "",
            match_words,
            match_text,
            remark=f.get("remark") or "",
            pack_profile=pack_profile,
            zone_scope=zone_scope,
            # 定位必须全页词：logo/公众号/净含量常在 claims zone 外
            locate_words=ocr_words,
        )
        h["id"] = f"f{i}"
        if f.get("step_id"):
            h["step_id"] = f.get("step_id")
            h["parent_field"] = f.get("parent_field")
        boxes = h.get("bboxes") or []
        if h.get("long_field") and boxes:
            # 尺寸取整段 hit 框，避免 miss 黄条（check）抢第一位导致「框26px」误导
            hit_boxes = [
                b
                for b in boxes
                if b.get("role") in (None, "hit", "context")
                and int(b.get("height") or 0) >= 40
            ]
            b0 = max(hit_boxes, key=lambda b: int(b.get("height") or 0)) if hit_boxes else boxes[0]
            h["evidence"] = (
                (h.get("evidence") or "")
                + f" · 框{b0.get('width')}×{b0.get('height')}px"
            )
            h["block_size"] = {
                "width": b0.get("width"),
                "height": b0.get("height"),
                "page": b0.get("page"),
            }
        if attach_sequence_diff and h.get("long_field"):
            try:
                from app.text_verify import sequence_diff
                from app import layout_zones as _lz

                # 正向 miss 用全文/zone hybrid；反向 pack 侧按字段 zone 防串扰
                pack_for_rev = _lz.reverse_pack_text_for_field(
                    h.get("field_group") or "",
                    ocr_words,
                    zones,
                    ocr_for_match or "",
                )
                sd = sequence_diff(
                    f.get("excel_value") or "",
                    pack_for_rev or ocr_for_match or "",
                    excel_full=excel_joined,
                    field_group=h.get("field_group") or "",
                )
                h["sequence_diff"] = {
                    "ratio": sd.get("ratio"),
                    "only_in_excel": (sd.get("token_miss") or sd.get("only_in_excel") or [])[
                        :10
                    ],
                    "only_in_pack": (sd.get("token_extra") or sd.get("only_in_pack") or [])[
                        :8
                    ],
                }
                miss = h["sequence_diff"]["only_in_excel"]
                cov_ratio = (h.get("coverage") or {}).get("ratio")
                # 覆盖率已经很高时，不要因整页 SequenceMatcher 低 ratio 误降为疑点
                if (
                    miss
                    and h.get("status") == "一致"
                    and (sd.get("ratio") or 1) < 0.35
                    and (cov_ratio is None or cov_ratio < 0.85)
                    and len(miss) >= 2
                ):
                    h["status"] = "疑点"
                    h["evidence"] = (
                        f"字符/词 diff 相似度 {sd.get('ratio')} · "
                        f"包装可能缺少：{'、'.join(miss[:3])} · "
                        + (h.get("evidence") or "")
                    )
                h["doubt_bucket"] = assign_doubt_bucket(h)
            except Exception:
                pass
        if h.get("field_group") == "条形码":
            try:
                from app.pack_profile import required_barcodes
                from app.text_verify import barcode_card

                excel_bc = f.get("excel_value") or ""
                must, ign = required_barcodes(excel_bc, pack_profile or {})
                if must or ign:
                    n_pack = normalize(ocr_text or "")
                    items = []
                    for c in must:
                        items.append(
                            {
                                "code": c,
                                "found": c in n_pack,
                                "status": "一致" if c in n_pack else "缺失",
                                "required": True,
                            }
                        )
                    for c in ign:
                        items.append(
                            {
                                "code": c,
                                "found": c in n_pack,
                                "status": "忽略",
                                "required": False,
                                "note": "装型画像：非当前装，可不命中",
                            }
                        )
                    req_ok = all(i["found"] for i in items if i.get("required")) if must else True
                    # 覆盖 miss 与卡一致：忽略装不进 miss
                    if h.get("coverage"):
                        h["coverage"]["miss"] = [
                            c for c in must if c not in n_pack
                        ]
                        h["coverage"]["miss_phrases"] = h["coverage"]["miss"]
                        h["coverage"]["hit"] = [c for c in must if c in n_pack]
                        h["coverage"]["matched"] = len(h["coverage"]["hit"])
                        h["coverage"]["total"] = max(1, len(must))
                        h["coverage"]["ratio"] = h["coverage"]["matched"] / h["coverage"][
                            "total"
                        ]
                    # 必检全中则保持一致；仅忽略装未印不算待处理
                    if req_ok and h.get("status") == "疑点" and not any(
                        not i["found"] for i in items if i.get("required")
                    ):
                        # 若疑点仅来自忽略码展示，拉回一致
                        if h.get("doubt_bucket") == "branch" or "规格" in (
                            h.get("evidence") or ""
                        ):
                            pass
                    h["barcode_card"] = {
                        "codes": items,
                        "total": len(must),
                        "found": sum(1 for i in items if i.get("required") and i["found"]),
                        "ignored": ign,
                        "status": "一致" if req_ok else "缺失",
                        "summary": (
                            f"必检 {sum(1 for i in items if i.get('required') and i['found'])}/{len(must)}；"
                            f"忽略非本装 {len(ign)} 码"
                        ),
                        "profile": (pack_profile or {}).get("rules"),
                    }
                    if must and req_ok:
                        h["status"] = "一致"
                        h["score"] = 95.0
                        h["evidence"] = (
                            f"装型画像 {(pack_profile or {}).get('surface_label')}/"
                            f"{(pack_profile or {}).get('active_piece') or '?'}片 · "
                            f"必检条码已命中 · 忽略 {len(ign)} 个非本装码"
                        )
                    elif must:
                        miss = [i["code"] for i in items if i.get("required") and not i["found"]]
                        h["status"] = "疑点"
                        h["score"] = 60.0
                        h["evidence"] = (
                            f"装型画像下必检条码未齐 · 缺 {','.join(miss)} · "
                            f"已忽略非本装: {','.join(ign) or '无'}"
                        )
                else:
                    h["barcode_card"] = barcode_card(excel_bc, ocr_text or "", ocr_words)
            except Exception:
                try:
                    from app.text_verify import barcode_card

                    h["barcode_card"] = barcode_card(
                        f.get("excel_value") or "", ocr_text or "", ocr_words
                    )
                except Exception:
                    pass
        hits.append(h)
    return hits

def locate_text_in_ocr(text: str, ocr_words: list[dict], *, limit: int = 3) -> list[dict]:
    if not text or not ocr_words:
        return []
    n_t = normalize(text)
    if len(n_t) < 2:
        return []
    scored: list[tuple[float, dict]] = []
    for w in ocr_words:
        n_w = normalize(w.get("text") or "")
        if not n_w:
            continue
        if n_t in n_w or n_w in n_t:
            sc = 100.0
        else:
            sc = float(fuzz.partial_ratio(n_t[:40], n_w))
        if sc < 82:
            continue
        loc = w.get("location") or {}
        if not (loc.get("width") or loc.get("height")):
            continue
        page = int(w.get("page") or 1)
        scored.append(
            (
                sc,
                {
                    "page": page,
                    "left": loc["left"],
                    "top": loc["top"],
                    "width": loc["width"],
                    "height": loc["height"],
                },
            )
        )
    scored.sort(key=lambda x: -x[0])
    out = []
    seen = set()
    for sc, b in scored:
        key = (b["page"], b["left"], b["top"])
        if key in seen:
            continue
        seen.add(key)
        out.append(b)
        if len(out) >= limit:
            break
    return out
