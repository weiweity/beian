"""Reuse the 2026-09-08 R04 matrix. Product loads are planned, not executed here."""

from __future__ import annotations

from typing import Any

# Wrapping a product command with this CLI. Placeholders are for the later
# exclusive window; this slice must not interpolate them into a live Blender run.
_MEASURE = [
    "python3",
    "scripts/resource-stress/cli.py",
    "measure-command",
    "--repo",
    "{repo}",
    "--out",
    "{out}",
    "--name",
    "{name}",
    "--",
]


def _wrap(name: str, inner: list[str]) -> list[str]:
    argv = [token if token != "{name}" else name for token in _MEASURE]
    # Only actual face/render probes are product measurements. Mocked queue,
    # busy and UI contract tests must never be promoted to resource budgets.
    if inner is FACE or inner is RENDER:
        argv[-1:-1] = ["--formal-budget", "--workload-kind", "product"]
    return argv + inner


def _scene(
    scene_id: str,
    coverage: str,
    *,
    this_round: str,
    status: str,
    exclusive_command: list[str],
    notes: str,
    r04: str,
) -> dict[str, Any]:
    return {
        "id": scene_id,
        "coverage": coverage,
        "r04_item": r04,
        "this_round": this_round,
        "status": status,
        "exclusive_command": exclusive_command,
        "notes": notes,
    }


# Historical inner probes lived in the 2026-09-08 evidence harness, not in git.
# Main agent later supplies {python} and {probe} (copy or rewrite of those probes).
FACE = ["{python}", "{probe}/face_probe.py", "{repo}", "{out}/{name}", "{name}"]
RENDER = ["{python}", "{probe}/render_probe.py", "{repo}", "{out}/{name}"]
UPLOAD = ["node", "--import", "tsx", "{probe}/upload-probe.mjs", "{out}/{name}"]
QUEUE = ["node", "--import", "tsx", "{probe}/queue-probe.mjs", "{out}/{name}"]
BUDGET = ["node", "--import", "tsx", "{probe}/budget-probe.mjs", "{out}/{name}"]
BUSY = ["npm", "run", "test", "-w", "beian-server", "--", "src/jobs.test.ts"]
RELIGHT = ["npm", "run", "test", "-w", "beian-ui", "--", "src/mockup"]

SCENARIOS: list[dict[str, Any]] = [
    _scene(
        "normal",
        "普通六面 30×20×50mm 合成切面",
        this_round="not-run",
        status="unverified",
        exclusive_command=_wrap("normal", FACE),
        notes="2026-09-08 已有合成切面观测；本轮不重跑产品切面。",
        r04="baseline-face",
    ),
    _scene(
        "tall",
        "极端长宽比 5×5×500mm",
        this_round="not-run",
        status="unverified",
        exclusive_command=_wrap("tall", FACE),
        notes="只证明切面函数，不证明极端盒型拓扑/生产支持。",
        r04="extreme-aspect",
    ),
    _scene(
        "wide",
        "极端长宽比 500×5×5mm",
        this_round="not-run",
        status="unverified",
        exclusive_command=_wrap("wide", FACE),
        notes="与 tall 组成 100:1 局部切面映射。",
        r04="extreme-aspect",
    ),
    _scene(
        "near-cap",
        "接近像素上限 199×5×399mm ≈ 31.76MP",
        this_round="not-run",
        status="unverified",
        exclusive_command=_wrap("near-cap", FACE),
        notes="32MP 是单图像素上限，不是进程 RSS 预算。独占窗口再测。",
        r04="max-pixels",
    ),
    _scene(
        "exact-cap-paper",
        "精确 32MP 纸基空白分支 200×5×400mm",
        this_round="not-run",
        status="unverified",
        exclusive_command=_wrap("exact-cap-paper", FACE),
        notes="paper_only，不冒充 32MP 复杂印刷内容。",
        r04="max-pixels",
    ),
    _scene(
        "over-cap",
        "超限拒绝 200×5×401mm",
        this_round="not-run",
        status="unverified",
        exclusive_command=_wrap("over-cap", FACE),
        notes="期望 structure_limit_exceeded，无暂存遗留。",
        r04="max-pixels",
    ),
    _scene(
        "dual-upload",
        "双上传 两路 100MiB，第三路 429",
        this_round="not-run",
        status="unverified",
        exclusive_command=_wrap("dual-upload", UPLOAD),
        notes="无网络/TLS/杭州吞吐含义。",
        r04="dual-upload",
    ),
    _scene(
        "illustrator-busy",
        "Illustrator busy 不领单",
        this_round="not-run",
        status="simulated-in-product-l0",
        exclusive_command=_wrap("illustrator-busy", BUSY),
        notes="产品 jobs.test.ts 模拟心跳；未启动原生 Illustrator。本轮不跑。",
        r04="busy",
    ),
    _scene(
        "blender-serial",
        "Blender 单槽串行",
        this_round="not-run",
        status="unverified",
        exclusive_command=_wrap("blender-serial", RENDER),
        notes="本轮禁止启动 Blender。正式独占由主 agent 串行安排。",
        r04="serial",
    ),
    _scene(
        "relight",
        "调灯/重渲棚",
        this_round="not-run",
        status="simulated-in-product-l0",
        exclusive_command=_wrap("relight", RELIGHT),
        notes="UI 纯函数/伪 canvas，不是浏览器 GPU 或杭州实机。本轮不跑。",
        r04="relight",
    ),
    _scene(
        "queue-drain",
        "排队与发版 drain",
        this_round="not-run",
        status="unverified",
        exclusive_command=_wrap("queue-drain", QUEUE),
        notes="旧探针为真实持久队列 + 模拟 worker，不是 Blender 耗时预算。",
        r04="drain",
    ),
    _scene(
        "fail-cancel",
        "失败/取消/磁盘预留释放",
        this_round="harness-synthetic-only",
        status="harness-verified-synthetic",
        exclusive_command=_wrap("fail-cancel", BUDGET),
        notes="本轮用合成子进程验证 harness 取消与收尾；产品 budget-probe 留独占窗口。不是 Windows Job Object。",
        r04="fail-cancel",
    ),
    _scene(
        "failure-after-front",
        "切面中途失败清理",
        this_round="not-run",
        status="unverified",
        exclusive_command=_wrap("failure-after-front", FACE),
        notes="旧观测 artwork_transform_invalid 且暂存清理。本轮不重跑。",
        r04="fail-cancel",
    ),
]

SYNTHETIC_SUITE = (
    {"id": "synthetic-success", "child_mode": "success", "expect_exit": 0},
    {"id": "synthetic-fail", "child_mode": "fail", "expect_exit": 7},
    {"id": "synthetic-queue", "child_mode": "queue", "expect_exit": 0},
    {"id": "synthetic-cancel", "child_mode": "hang", "expect_exit": None, "cancel_after_s": 0.25},
)


def required_r04_items() -> set[str]:
    return {
        "extreme-aspect",
        "max-pixels",
        "dual-upload",
        "busy",
        "serial",
        "relight",
        "drain",
        "fail-cancel",
    }


def coverage_index() -> dict[str, list[str]]:
    index: dict[str, list[str]] = {item: [] for item in required_r04_items()}
    for scene in SCENARIOS:
        index.setdefault(scene["r04_item"], []).append(scene["id"])
    return index
