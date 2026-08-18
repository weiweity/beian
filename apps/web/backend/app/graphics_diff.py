"""
像素级图形 diff 钩子（P3 轻量）

用于双 PDF / 同页重渲对比；Excel↔PDF 主路径仍是文字验证。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageStat


def compare_images(
    path_a: str | Path,
    path_b: str | Path,
    out_path: str | Path | None = None,
    *,
    threshold: int = 28,
) -> dict[str, Any]:
    """
    简单像素 diff：缩放对齐后算差异比例，可选输出高亮 PNG。
    """
    a = Image.open(path_a).convert("RGB")
    b = Image.open(path_b).convert("RGB")
    # 对齐到 A 的尺寸
    if b.size != a.size:
        b = b.resize(a.size, Image.Resampling.LANCZOS)
    diff = ImageChops.difference(a, b)
    # 灰度差异
    gray = diff.convert("L")
    # 二值
    mask = gray.point(lambda p: 255 if p > threshold else 0)
    changed = sum(1 for p in mask.getdata() if p)
    total = mask.size[0] * mask.size[1]
    ratio = changed / total if total else 0.0
    mean = ImageStat.Stat(gray).mean[0]

    if out_path:
        # 红半透明叠 diff
        overlay = Image.new("RGBA", a.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        # 稀疏画点避免巨大文件：缩略标记
        px = mask.load()
        step = max(1, min(a.size) // 400)
        for y in range(0, a.size[1], step):
            for x in range(0, a.size[0], step):
                if px[x, y] > 0:
                    draw.rectangle([x, y, x + step, y + step], fill=(238, 0, 0, 90))
        base = a.convert("RGBA")
        composed = Image.alpha_composite(base, overlay).convert("RGB")
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        composed.save(out_path, "PNG")

    return {
        "ok": True,
        "diff_ratio": round(ratio, 6),
        "mean_abs_diff": round(float(mean), 3),
        "changed_pixels": changed,
        "total_pixels": total,
        "threshold": threshold,
        "size": list(a.size),
        "output": str(out_path) if out_path else None,
        "verdict": "similar" if ratio < 0.01 else ("minor" if ratio < 0.05 else "major"),
    }
