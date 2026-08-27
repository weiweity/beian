"""Read 刀线/刀版 and recover a packaging template. No frozen millimetres."""

from __future__ import annotations

import math
from collections import deque
from pathlib import Path
from typing import Any

from PIL import Image

PT_TO_MM = 25.4 / 72.0
KNIFE_NAMES = ("刀线", "刀版", "模切", "刀模")
# 20/34 先试，已能折的大方盒保持现网命中；12 更密；48/64/80 更疏。不要改成纯先密后疏。
CARTON_DIST_K = (20, 34, 12, 48, 64, 80)


def pt_to_mm(pt: float) -> float:
    return float(pt) * PT_TO_MM


def pick_knife_layer(layers: list[str] | None) -> str | None:
    names = [str(n) for n in (layers or [])]
    for name in names:
        if name in KNIFE_NAMES:
            return name
    for name in names:
        if any(bad in name for bad in ("无", "非", "不是")):
            continue
        if any(name.endswith(token) or name == token for token in KNIFE_NAMES):
            return name
    return None


def _smooth(values: list[float], k: int = 7) -> list[float]:
    k = k + (1 - k % 2)
    half = k // 2
    prefix = [0.0]
    for value in values:
        prefix.append(prefix[-1] + value)
    n = len(values)
    out: list[float] = []
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        out.append((prefix[hi] - prefix[lo]) / (hi - lo))
    return out


def _peaks(values: list[float], min_prom: float, min_dist: int) -> list[int]:
    idx: list[int] = []
    for i in range(2, len(values) - 2):
        if values[i] >= values[i - 1] and values[i] >= values[i + 1] and values[i] > min_prom:
            if idx and i - idx[-1] < min_dist:
                if values[i] > values[idx[-1]]:
                    idx[-1] = i
            else:
                idx.append(i)
    return idx


def _mask_from_rgb(im: Image.Image) -> tuple[bytearray, int, int]:
    rgb = im.convert("RGB")
    width, height = rgb.size
    src = rgb.tobytes()
    mask = bytearray(width * height)
    for i in range(width * height):
        r, g, b = src[i * 3], src[i * 3 + 1], src[i * 3 + 2]
        if r > 248 and g > 248 and b > 248:
            continue
        if b > r + 25 and b > g + 15 and b > 80:
            continue
        mask[i] = 1
    return mask, width, height


def _downsample(mask: bytearray, width: int, height: int, factor: int) -> tuple[bytearray, int, int]:
    nw, nh = max(1, width // factor), max(1, height // factor)
    out = bytearray(nw * nh)
    for y in range(nh):
        for x in range(nw):
            ink = 0
            for dy in range(factor):
                row = (y * factor + dy) * width
                for dx in range(factor):
                    if mask[row + x * factor + dx]:
                        ink = 1
                        break
                if ink:
                    break
            out[y * nw + x] = ink
    return out, nw, nh


def _dilate(mask: bytearray, width: int, height: int, radius: int = 1) -> bytearray:
    out = bytearray(mask)
    for y in range(height):
        for x in range(width):
            if not mask[y * width + x]:
                continue
            for dy in range(-radius, radius + 1):
                yy = y + dy
                if yy < 0 or yy >= height:
                    continue
                for dx in range(-radius, radius + 1):
                    xx = x + dx
                    if 0 <= xx < width:
                        out[yy * width + xx] = 1
    return out


def _components(mask: bytearray, width: int, height: int, min_pix: int) -> list[dict[str, int]]:
    seen = bytearray(width * height)
    comps: list[dict[str, int]] = []
    for i in range(width * height):
        if not mask[i] or seen[i]:
            continue
        queue: deque[int] = deque([i])
        seen[i] = 1
        cells: list[int] = []
        while queue:
            p = queue.popleft()
            cells.append(p)
            x, y = p % width, p // width
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                xx, yy = x + dx, y + dy
                if 0 <= xx < width and 0 <= yy < height:
                    j = yy * width + xx
                    if mask[j] and not seen[j]:
                        seen[j] = 1
                        queue.append(j)
        if len(cells) < min_pix:
            continue
        xs = [c % width for c in cells]
        ys = [c // width for c in cells]
        comps.append(
            {
                "n": len(cells),
                "x0": min(xs),
                "y0": min(ys),
                "x1": max(xs),
                "y1": max(ys),
            }
        )
    comps.sort(key=lambda c: -c["n"])
    return comps


def _col_proj(mask: bytearray, width: int, x0: int, y0: int, x1: int, y1: int) -> list[float]:
    cols = [0.0] * max(1, x1 - x0)
    for y in range(y0, y1):
        row = y * width
        for x in range(x0, x1):
            if mask[row + x]:
                cols[x - x0] += 1
    return cols


def _row_proj(mask: bytearray, width: int, x0: int, y0: int, x1: int, y1: int) -> list[float]:
    rows = [0.0] * max(1, y1 - y0)
    for y in range(y0, y1):
        row = y * width
        total = 0.0
        for x in range(x0, x1):
            if mask[row + x]:
                total += 1
        rows[y - y0] = total
    return rows


def _ink_span(values: list[float], min_frac: float = 0.08) -> tuple[int, int] | None:
    if not values:
        return None
    peak = max(values)
    thr = max(peak * min_frac, 2.0)
    hits = [i for i, v in enumerate(values) if v >= thr]
    if not hits:
        return None
    return hits[0], hits[-1]


def pick_main_regions(
    comps: list[dict[str, int]],
    factor: int,
    zoom: float,
) -> tuple[str, list[dict[str, Any]]]:
    scored: list[dict[str, Any]] = []
    for comp in comps:
        x0 = comp["x0"] * factor / zoom
        y0 = comp["y0"] * factor / zoom
        x1 = (comp["x1"] + 1) * factor / zoom
        y1 = (comp["y1"] + 1) * factor / zoom
        ww, hh = x1 - x0, y1 - y0
        if ww < 40 or hh < 40:
            continue
        aspect = ww / hh
        if aspect > 2.4 or aspect < 0.12:
            continue
        scored.append({**comp, "pt": (x0, y0, x1, y1), "ww": ww, "hh": hh, "aspect": aspect})
    if not scored:
        raise RuntimeError("刀线层里找不到展开图")
    if len(scored) >= 2:
        a, b = scored[0], scored[1]
        if (
            abs(a["ww"] - b["ww"]) / max(a["ww"], 1) < 0.12
            and abs(a["hh"] - b["hh"]) / max(a["hh"], 1) < 0.12
            and min(a["n"], b["n"]) > 0.78 * max(a["n"], b["n"])
        ):
            ordered = sorted(scored[:2], key=lambda c: c["pt"][0])
            return "pouch", ordered
    # 一页可能同时放产品盒体和内衬。后续必须比较所有候选，不能只拿第一个
    # 连通域；Illustrator 图层顺序和连通像素数都不能代表哪套刀版是成品。
    return "carton", scored[:4]


def _is_wide(width_pt: float, max_width: float) -> bool:
    return width_pt >= 0.6 * max_width


def assign_body_panels(xs: list[float]) -> tuple[str, list[tuple[float, float]]]:
    if len(xs) < 4:
        raise RuntimeError("刀线竖线太少，拆不出盒面")
    widths = [xs[i + 1] - xs[i] for i in range(len(xs) - 1)]
    usable = [w for w in widths if pt_to_mm(w) >= 6]
    if len(usable) < 3:
        raise RuntimeError("刀线面宽太碎，拆不出盒面")
    max_w = max(usable)
    for i in range(len(widths) - 3):
        chunk = widths[i : i + 4]
        flags = [_is_wide(w, max_w) for w in chunk]
        if flags == [False, True, False, True]:
            return "flat", [(xs[i + k], xs[i + k + 1]) for k in range(4)]
        if flags == [True, False, True, False]:
            return "flat", [(xs[i + k], xs[i + k + 1]) for k in range(4)]
    med = sorted(usable)[len(usable) // 2]
    glue = 0.55 * med
    is_body = [w >= glue for w in widths]
    best_i, best_n = 0, 0
    i = 0
    while i < len(is_body):
        if not is_body[i]:
            i += 1
            continue
        j = i
        while j < len(is_body) and is_body[j]:
            j += 1
        if j - i > best_n:
            best_i, best_n = i, j - i
        i = j
    if best_n < 3:
        raise RuntimeError("刀线没有连续的盒身面")
    n = min(best_n, 4)
    start = best_i
    if best_n > 4:
        start = best_i + (best_n - 4)
        n = 4
    return "carton", [(xs[start + k], xs[start + k + 1]) for k in range(n)]


def _roles_for(family: str, count: int) -> list[str]:
    if family == "pouch":
        return ["front", "back"][:count]
    if family == "flat" and count == 4:
        return ["left", "front", "right", "back"]
    if count == 4:
        return ["back", "left", "front", "right"]
    if count == 3:
        return ["left", "front", "right"]
    return [f"panel{i}" for i in range(count)]


def layout_to_template(layout: dict[str, Any]) -> dict[str, Any]:
    dims = layout["dimensions_mm"]
    width, depth, height = float(dims["width"]), float(dims["depth"]), float(dims["height"])
    page_w = float(layout["page_pt"][0])
    boxes = {panel["role"]: [panel["x0"], panel["y0"], panel["x1"], panel["y1"]] for panel in layout["panels"]}
    if "top" not in boxes and "front" in boxes:
        fx0, fy0, fx1, _fy1 = boxes["front"]
        lid = min(max(width, depth) / PT_TO_MM, max(8.0, fy0 - layout["roi"][1]))
        boxes["top"] = [fx0, max(layout["roi"][1], fy0 - lid), fx1, fy0]
    return {
        "template_id": f"dieline_{layout['family']}",
        "version": 1,
        "description": f"刀线还原 {layout['family']}",
        "source": "dieline",
        "family": layout["family"],
        "knife_layer": layout["knife_layer"],
        "expected_page_points": list(layout["page_pt"]),
        "page_size_tolerance_ratio": 0.05,
        "required_layers": ["印刷"],
        "print_layers": ["印刷"],
        "reference_width_px": page_w,
        "raster_width_px": 8000,
        "dimensions_mm": {"width": round(width, 2), "depth": round(depth, 2), "height": round(height, 2)},
        "panel_order": ["back", "left", "front", "right"],
        "face_boxes": boxes,
        "face_sources": {name: "print" for name in ("back", "left", "front", "right", "top")},
        "composite_inset_reference_px": 0,
        "render": {
            "resolution_x": 2000,
            "resolution_y": 2400,
            "camera_ortho_scale_mm": round(max(max(math.hypot(width, depth), height, width, depth, 1.0) * 1.36, 80.0), 1),
            "front_rotation_deg": 0.0,
            "back_rotation_deg": 180.0,
        },
        "glb_tolerance_mm": 2.0,
    }


def knife_drawings_safe(page: Any) -> bool:
    """刀线层大面积填色多半混进了印刷，矢量回退会脏。"""
    drawings = page.get_drawings()
    if not drawings:
        return False
    area = float(page.rect.width * page.rect.height) or 1.0
    fill = 0.0
    for drawing in drawings:
        rect = drawing.get("rect")
        if drawing.get("fill") and rect is not None:
            fill += abs(float(rect.width) * float(rect.height))
    return fill / area <= 0.45


def _pt_xy(point: Any) -> tuple[float, float]:
    if hasattr(point, "x"):
        return float(point.x), float(point.y)
    return float(point[0]), float(point[1])


class _Rect:
    __slots__ = ("x0", "y0", "x1", "y1")

    def __init__(self, x0: float, y0: float, x1: float, y1: float) -> None:
        self.x0, self.y0, self.x1, self.y1 = x0, y0, x1, y1


def _freeze_drawings(drawings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Copy path items off the live MuPDF page before doc.close()."""
    frozen: list[dict[str, Any]] = []
    for drawing in drawings:
        items: list[Any] = []
        for item in drawing.get("items") or []:
            if not item:
                continue
            parts: list[Any] = [item[0]]
            for part in item[1:]:
                if hasattr(part, "x0") and hasattr(part, "y0"):
                    parts.append(_Rect(float(part.x0), float(part.y0), float(part.x1), float(part.y1)))
                elif hasattr(part, "x") or isinstance(part, (tuple, list)):
                    parts.append(_pt_xy(part))
                else:
                    parts.append(part)
            items.append(tuple(parts))
        frozen.append({"items": items})
    return frozen


def _plot(mask: bytearray, width: int, height: int, x: int, y: int) -> None:
    if 0 <= x < width and 0 <= y < height:
        mask[y * width + x] = 1


def _thick_line(mask: bytearray, width: int, height: int, x0: int, y0: int, x1: int, y1: int, thick: int = 2) -> None:
    rad = max(1, thick)
    pad = rad
    if (x0 < -pad and x1 < -pad) or (x0 >= width + pad and x1 >= width + pad):
        return
    if (y0 < -pad and y1 < -pad) or (y0 >= height + pad and y1 >= height + pad):
        return
    x0 = max(-pad, min(width + pad, x0))
    y0 = max(-pad, min(height + pad, y0))
    x1 = max(-pad, min(width + pad, x1))
    y1 = max(-pad, min(height + pad, y1))
    dx = abs(x1 - x0)
    dy = abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    x, y = x0, y0
    while True:
        for oy in range(-rad, rad + 1):
            for ox in range(-rad, rad + 1):
                _plot(mask, width, height, x + ox, y + oy)
        if x == x1 and y == y1:
            break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x += sx
        if e2 < dx:
            err += dx
            y += sy


def _stroke_drawings_into_mask(mask: bytearray, width: int, height: int, zoom: float, drawings: list[dict[str, Any]]) -> None:
    drawn = 0
    for drawing in drawings:
        for item in drawing.get("items") or []:
            drawn += 1
            if drawn > 8000:
                return
            kind = item[0]
            if kind == "l" and len(item) >= 3:
                x0, y0 = _pt_xy(item[1])
                x1, y1 = _pt_xy(item[2])
                _thick_line(mask, width, height, int(x0 * zoom), int(y0 * zoom), int(x1 * zoom), int(y1 * zoom))
            elif kind == "re" and len(item) >= 2:
                rect = item[1]
                x0, y0, x1, y1 = int(rect.x0 * zoom), int(rect.y0 * zoom), int(rect.x1 * zoom), int(rect.y1 * zoom)
                _thick_line(mask, width, height, x0, y0, x1, y0)
                _thick_line(mask, width, height, x1, y0, x1, y1)
                _thick_line(mask, width, height, x1, y1, x0, y1)
                _thick_line(mask, width, height, x0, y1, x0, y0)
            elif kind == "c" and len(item) >= 5:
                pts = [_pt_xy(item[i]) for i in range(1, 5)]
                for i in range(3):
                    x0, y0 = pts[i]
                    x1, y1 = pts[i + 1]
                    _thick_line(mask, width, height, int(x0 * zoom), int(y0 * zoom), int(x1 * zoom), int(y1 * zoom), 1)


def _try_parse_mask(
    mask: bytearray,
    width: int,
    height: int,
    zoom: float,
    knife_layer: str,
    page_w: float,
    page_h: float,
) -> tuple[dict[str, Any] | None, str]:
    factor = 3
    small, nw, nh = _downsample(mask, width, height, factor)
    small = _dilate(small, nw, nh, 1)
    comps = _components(small, nw, nh, min_pix=40)
    try:
        family, regions = pick_main_regions(comps, factor, zoom)
    except RuntimeError as err:
        return None, str(err)
    last_error = "刀线读不出盒面"
    candidates: list[tuple[float, int, int, dict[str, Any]]] = []
    for region in regions:
        for dist_k in CARTON_DIST_K:
            try:
                layout = _carton_from_roi(mask, width, height, zoom, region, dist_k, knife_layer, page_w, page_h)
            except RuntimeError as err:
                last_error = str(err)
                continue
            if layout_sane(layout):
                # 同一刀版在不同峰距下可能同时产出“勉强合理”的短盒和真正盒身。
                # 四个盒面的物理面积能表达完整盒身，且不依赖固定毫米数；再以
                # 连通像素和先试顺序作稳定的次级排序。
                body_area = sum(
                    max(0.0, float(panel["x1"]) - float(panel["x0"]))
                    * max(0.0, float(panel["y1"]) - float(panel["y0"]))
                    for panel in layout.get("panels") or []
                    if panel.get("role") in {"front", "back", "left", "right"}
                )
                candidates.append((body_area, int(region.get("n") or 0), -len(candidates), layout))
                continue
            last_error = f"刀线还原的尺寸不合理：{layout['dimensions_mm']}"
    if candidates:
        return max(candidates, key=lambda item: item[:3])[3], ""
    if family == "pouch" and len(regions) >= 2:
        panels = []
        roles = _roles_for("pouch", 2)
        for role, region in zip(roles, regions):
            x0, y0, x1, y1 = region["pt"]
            panels.append({"role": role, "x0": x0, "y0": y0, "x1": x1, "y1": y1})
        face_w = pt_to_mm((panels[0]["x1"] - panels[0]["x0"] + panels[1]["x1"] - panels[1]["x0"]) / 2)
        face_h = pt_to_mm((panels[0]["y1"] - panels[0]["y0"] + panels[1]["y1"] - panels[1]["y0"]) / 2)
        layout = {
            "family": "pouch",
            "knife_layer": knife_layer,
            "page_pt": [page_w, page_h],
            "roi": regions[0]["pt"],
            "panels": panels,
            "dimensions_mm": {"width": face_w, "depth": 3.0, "height": face_h},
        }
        if layout_sane(layout):
            return layout, ""
        last_error = f"刀线还原的尺寸不合理：{layout['dimensions_mm']}"
    return None, last_error


def parse_knife_pdf(knife_pdf: Path, knife_layer: str) -> dict[str, Any]:
    import pymupdf

    doc = pymupdf.open(str(knife_pdf))
    try:
        if doc.page_count < 1:
            raise RuntimeError("刀线PDF没有页")
        page = doc[0]
        page.set_cropbox(page.mediabox)
        page_w, page_h = float(page.mediabox.width), float(page.mediabox.height)
        if page_w <= 1 or page_h <= 1:
            raise RuntimeError("刀线页宽异常")
        width_px = 1600
        zoom = min(width_px / page_w, 8000 / page_h)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        samples = bytes(pix.samples)
        size = (pix.width, pix.height)
        drawings_ok = knife_drawings_safe(page)
        drawings = _freeze_drawings(page.get_drawings()) if drawings_ok else []
    finally:
        doc.close()
    im = Image.frombytes("RGB", size, samples)
    mask, width, height = _mask_from_rgb(im)
    # 密折痕花盒（胶原棒）在 20/34 会把盒身切碎。先密后疏，命中即停，不改已能折的大方盒。
    layout, last_error = _try_parse_mask(mask, width, height, zoom, knife_layer, page_w, page_h)
    if layout:
        layout["die_source"] = "raster"
        return layout
    if drawings_ok and drawings:
        stroked = bytearray(width * height)
        _stroke_drawings_into_mask(stroked, width, height, zoom, drawings)
        stroked = _dilate(stroked, width, height, 1)
        layout, vector_error = _try_parse_mask(stroked, width, height, zoom, knife_layer, page_w, page_h)
        if layout:
            layout["die_source"] = "vector"
            return layout
        last_error = vector_error or last_error
    raise RuntimeError(last_error or "刀线读不出盒面")


def layout_sane(layout: dict[str, Any]) -> bool:
    dims = layout.get("dimensions_mm") or {}
    try:
        width, depth, height = float(dims.get("width") or 0), float(dims.get("depth") or 0), float(dims.get("height") or 0)
    except (TypeError, ValueError):
        return False
    if not all(math.isfinite(v) for v in (width, depth, height)):
        return False
    family = layout.get("family")
    roles = {str(p.get("role")) for p in layout.get("panels") or []}
    if family == "pouch":
        return 50 <= width <= 400 and 80 <= height <= 500 and {"front", "back"} <= roles
    if family == "flat":
        return 50 <= width <= 400 and 8 <= depth <= 120 and 50 <= height <= 500 and {"front", "back", "left", "right"} <= roles
    return 18 <= width <= 250 and 18 <= depth <= 250 and 40 <= height <= 450 and {"front", "back", "left", "right"} <= roles


def _carton_from_roi(
    mask: bytearray,
    width: int,
    height: int,
    zoom: float,
    region: dict[str, Any],
    dist_k: int,
    knife_layer: str,
    page_w: float,
    page_h: float,
) -> dict[str, Any]:
    rx0, ry0, rx1, ry1 = region["pt"]
    px0, py0 = max(0, int(rx0 * zoom)), max(0, int(ry0 * zoom))
    px1, py1 = min(width, int(rx1 * zoom)), min(height, int(ry1 * zoom))
    cols = _smooth(_col_proj(mask, width, px0, py0, px1, py1), 5)
    peak = max(cols) if cols else 0
    min_dist = max(12, int(dist_k * zoom))
    xs = [(px0 + i) / zoom for i in _peaks(cols, min_prom=max(peak * 0.26, (py1 - py0) * 0.07), min_dist=min_dist)]
    if xs:
        if xs[0] - rx0 > 8:
            xs = [rx0] + xs
        if rx1 - xs[-1] > 8:
            xs = xs + [rx1]
    carton_family, spans = assign_body_panels(xs)
    rows_all = _smooth(_row_proj(mask, width, px0, py0, px1, py1), 5)
    row_peak = max(rows_all) if rows_all else 0
    ys = [(py0 + i) / zoom for i in _peaks(rows_all, min_prom=max(row_peak * 0.26, (px1 - px0) * 0.07), min_dist=min_dist)]
    body_y0, body_y1 = ry0, ry1
    if len(ys) >= 2:
        best = (ys[0], ys[-1])
        best_h = 0.0
        limit = 0.88 * (ry1 - ry0)
        for i in range(len(ys) - 1):
            h = ys[i + 1] - ys[i]
            if h > best_h and h < limit:
                best_h = h
                best = (ys[i], ys[i + 1])
        if best_h > 40:
            body_y0, body_y1 = best
        elif ys[-1] - ys[0] < limit:
            body_y0, body_y1 = ys[0], ys[-1]
    roles = _roles_for(carton_family, len(spans))
    panels = [{"role": role, "x0": x0, "y0": body_y0, "x1": x1, "y1": body_y1} for role, (x0, x1) in zip(roles, spans)]
    by_role = {p["role"]: p for p in panels}

    def width_of(role: str, fallback: str) -> float:
        hit = by_role.get(role) or by_role.get(fallback)
        if not hit:
            return 0.0
        return pt_to_mm(hit["x1"] - hit["x0"])

    def height_of(role: str) -> float:
        hit = by_role.get(role)
        if not hit:
            return 0.0
        return pt_to_mm(hit["y1"] - hit["y0"])

    if carton_family == "flat":
        dim_w = max(width_of("front", "back"), width_of("back", "front"))
        dim_d = max(width_of("left", "right"), width_of("right", "left"))
        dim_h = max(height_of("front"), height_of("back"), 10.0)
    else:
        dim_w = width_of("front", "back") or width_of("back", "front")
        dim_d = width_of("left", "right") or width_of("right", "left") or dim_w
        dim_h = max(height_of("front"), height_of("back"), height_of("left"), 10.0)
        if abs(dim_w - dim_d) / max(dim_w, dim_d, 1) < 0.12:
            dim_d = dim_w
    return {
        "family": carton_family,
        "knife_layer": knife_layer,
        "page_pt": [page_w, page_h],
        "roi": region["pt"],
        "panels": panels,
        "dimensions_mm": {"width": dim_w, "depth": dim_d, "height": dim_h},
    }
