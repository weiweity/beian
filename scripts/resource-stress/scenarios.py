"""Reuse the 2026-09-08 R04 matrix. Product loads are planned, not executed here."""

from __future__ import annotations

from typing import Any

PROBE_DIR_REL = "scripts/resource-stress/probes"

# Wrapping a product command with this CLI. Placeholders are interpolated by
# plan.py; this slice must not interpolate them into a live Blender run.
_MEASURE = [
    "{python}",
    "-B",
    "{repo}/scripts/resource-stress/cli.py",
    "measure-command",
    "--repo",
    "{repo}",
    "--out",
    "{out}",
    "--name",
    "{name}",
    "--",
]

EXPECTED_REJECT = {"over-cap", "failure-after-front"}


def _wrap(name: str, inner: list[str]) -> list[str]:
    argv = [token if token != "{name}" else name for token in _MEASURE]
    # Only actual face/render probes that are budget-eligible get --formal-budget.
    # Expected reject, mocked queue, busy and UI contract tests must never be
    # promoted to resource budgets just because the inner command exits 0.
    if name not in EXPECTED_REJECT and (inner is FACE or inner is RENDER):
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


FACE = [
    "{python}",
    "-B",
    "{repo}/" + PROBE_DIR_REL + "/face_probe.py",
    "{repo}",
    "{out}/{name}",
    "{name}",
]
RENDER = [
    "{python}",
    "-B",
    "{repo}/" + PROBE_DIR_REL + "/render_probe.py",
    "{repo}",
    "{out}/{name}",
    "{blender}",
]
UPLOAD = [
    "{node}",
    "--import",
    "{tsx}",
    "{repo}/" + PROBE_DIR_REL + "/upload-probe.mjs",
    "{repo}",
    "{out}/{name}",
]
QUEUE = [
    "{node}",
    "--import",
    "{tsx}",
    "{repo}/" + PROBE_DIR_REL + "/queue-probe.mjs",
    "{repo}",
    "{out}/{name}",
]
BUDGET = [
    "{node}",
    "--import",
    "{tsx}",
    "{repo}/" + PROBE_DIR_REL + "/budget-probe.mjs",
    "{repo}",
    "{out}/{name}",
]
BUSY = ["{npm}", "run", "test", "-w", "beian-server", "--", "src/jobs.test.ts"]
RELIGHT = ["{npm}", "run", "test", "-w", "beian-ui", "--", "src/mockup"]

SCENARIOS: list[dict[str, Any]] = [
    _scene(
        "normal",
        "普通六面 30×20×50mm 合成切面",
        this_round="not-run",
        status="unverified",
        exclusive_command=_wrap("normal", FACE),
        notes="仓库内 face_probe；本切片不执行产品切面。",
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
        notes="期望 structure_limit_exceeded，无暂存遗留。命中时探针 exit 0，不得当预算。",
        r04="max-pixels",
    ),
    _scene(
        "dual-upload",
        "双上传 两路 100MiB，第三路 429",
        this_round="not-run",
        status="unverified",
        exclusive_command=_wrap("dual-upload", UPLOAD),
        notes="无网络/TLS/杭州吞吐含义。本切片不跑 100MiB。",
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
        notes="必须显式给出 Blender 可执行文件。禁止猜 /Applications，不因已安装而启动。",
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
        notes="真实持久队列 + 模拟 worker，不是 Blender 耗时预算。本切片不执行。",
        r04="drain",
    ),
    _scene(
        "fail-cancel",
        "失败/取消/磁盘预留释放",
        this_round="harness-synthetic-only",
        status="harness-verified-synthetic",
        exclusive_command=_wrap("fail-cancel", BUDGET),
        notes="本轮用合成子进程验证 harness 取消与收尾；产品 budget-probe 的 32MiB 是入参不是产品默认。",
        r04="fail-cancel",
    ),
    _scene(
        "failure-after-front",
        "切面中途失败清理",
        this_round="not-run",
        status="unverified",
        exclusive_command=_wrap("failure-after-front", FACE),
        notes="期望 artwork_transform_invalid 且暂存清理。命中时探针 exit 0，不得当预算。",
        r04="fail-cancel",
    ),
]

SYNTHETIC_SUITE = (
    {"id": "synthetic-success", "child_mode": "success", "expect_exit": 0},
    {"id": "synthetic-fail", "child_mode": "fail", "expect_exit": 7},
    {"id": "synthetic-queue", "child_mode": "queue", "expect_exit": 0},
    {"id": "synthetic-cancel", "child_mode": "hang", "expect_exit": None, "cancel_after_s": 0.25},
)

FACE_DEPS = [
    "python",
    "pymupdf",
    "workers/packaging/structure_v2/artwork.py",
]
NODE_DEPS = ["node", "tsx", "apps/web/server/src"]
UNVERIFIED_COMMON = [
    "formal exclusive window",
    "Windows Job Object",
    "Hangzhou native",
    "real artwork L2",
]

SCENARIO_CONTRACT: dict[str, dict[str, Any]] = {
    "normal": {
        "class": "product_face",
        "eligibility": "BUDGET",
        "formal_budget_allowed": True,
        "simulated": False,
        "probe": "face_probe.py",
        "expect_exit": 0,
        "expected_error": None,
        "requires_result": True,
        "runtime_deps": FACE_DEPS,
        "behavior_pass_when": "result.json ok=true and expected_error=null and staging empty",
        "unverified": UNVERIFIED_COMMON,
        "notes": "product face function; 32MP is not RSS",
    },
    "tall": {
        "class": "product_face",
        "eligibility": "BUDGET",
        "formal_budget_allowed": True,
        "simulated": False,
        "probe": "face_probe.py",
        "expect_exit": 0,
        "expected_error": None,
        "requires_result": True,
        "runtime_deps": FACE_DEPS,
        "behavior_pass_when": "result.json ok=true",
        "unverified": UNVERIFIED_COMMON + ["extreme box topology"],
        "notes": "100:1 aspect observation",
    },
    "wide": {
        "class": "product_face",
        "eligibility": "BUDGET",
        "formal_budget_allowed": True,
        "simulated": False,
        "probe": "face_probe.py",
        "expect_exit": 0,
        "expected_error": None,
        "requires_result": True,
        "runtime_deps": FACE_DEPS,
        "behavior_pass_when": "result.json ok=true",
        "unverified": UNVERIFIED_COMMON + ["extreme box topology"],
        "notes": "100:1 aspect observation",
    },
    "near-cap": {
        "class": "product_face",
        "eligibility": "BUDGET",
        "formal_budget_allowed": True,
        "simulated": False,
        "probe": "face_probe.py",
        "expect_exit": 0,
        "expected_error": None,
        "requires_result": True,
        "runtime_deps": FACE_DEPS,
        "behavior_pass_when": "result.json ok=true; 32MP is a pixel cap not an RSS budget",
        "unverified": UNVERIFIED_COMMON + ["near-cap product load not run this slice"],
        "notes": "do not run this slice",
    },
    "exact-cap-paper": {
        "class": "product_face",
        "eligibility": "BUDGET",
        "formal_budget_allowed": True,
        "simulated": False,
        "probe": "face_probe.py",
        "expect_exit": 0,
        "expected_error": None,
        "requires_result": True,
        "runtime_deps": FACE_DEPS,
        "behavior_pass_when": "result.json ok=true; paper_only branch",
        "unverified": UNVERIFIED_COMMON + ["not complex print content"],
        "notes": "paper_only",
    },
    "over-cap": {
        "class": "expected_reject",
        "eligibility": "NEVER",
        "formal_budget_allowed": False,
        "simulated": False,
        "probe": "face_probe.py",
        "expect_exit": 0,
        "expected_error": "structure_limit_exceeded",
        "requires_result": True,
        "runtime_deps": FACE_DEPS,
        "behavior_pass_when": "result.json ok=true and expected_error=structure_limit_exceeded and staging_left empty",
        "unverified": UNVERIFIED_COMMON,
        "notes": "exit 0 on expected error is behavior, never a budget",
    },
    "failure-after-front": {
        "class": "expected_reject",
        "eligibility": "NEVER",
        "formal_budget_allowed": False,
        "simulated": False,
        "probe": "face_probe.py",
        "expect_exit": 0,
        "expected_error": "artwork_transform_invalid",
        "requires_result": True,
        "runtime_deps": FACE_DEPS,
        "behavior_pass_when": "result.json ok=true and expected_error=artwork_transform_invalid and staging_left empty",
        "unverified": UNVERIFIED_COMMON,
        "notes": "exit 0 on expected error is behavior, never a budget",
    },
    "dual-upload": {
        "class": "synthetic_observe",
        "eligibility": "NEVER",
        "formal_budget_allowed": False,
        "simulated": True,
        "probe": "upload-probe.mjs",
        "expect_exit": 0,
        "expected_error": None,
        "requires_result": True,
        "runtime_deps": NODE_DEPS + ["apps/web/server/src/uploads.ts", "apps/web/server/src/auth.ts"],
        "behavior_pass_when": "third session 429; two streams written then discarded; slot reacquired",
        "unverified": UNVERIFIED_COMMON + ["100MiB dual-upload not run this slice", "no TLS/Hangzhou"],
        "notes": "in-process Hono",
    },
    "queue-drain": {
        "class": "synthetic_observe",
        "eligibility": "NEVER",
        "formal_budget_allowed": False,
        "simulated": True,
        "probe": "queue-probe.mjs",
        "expect_exit": 0,
        "expected_error": None,
        "requires_result": True,
        "runtime_deps": NODE_DEPS + ["apps/web/server/src/jobs.ts", "apps/web/server/src/mockup.ts"],
        "behavior_pass_when": "maxActive=1; drain blocked while jobs_active; ready after both succeed",
        "unverified": UNVERIFIED_COMMON + ["200ms worker is not Blender duration"],
        "notes": "synthetic worker",
    },
    "fail-cancel": {
        "class": "cancel_observe",
        "eligibility": "NEVER",
        "formal_budget_allowed": False,
        "simulated": True,
        "probe": "budget-probe.mjs",
        "expect_exit": 0,
        "expected_error": None,
        "requires_result": True,
        "runtime_deps": NODE_DEPS + ["apps/web/server/src/renderGenerationBudget.ts"],
        "behavior_pass_when": "success/disk-exhaustion/cancel release reservation; ownership-unknown recovered",
        "unverified": UNVERIFIED_COMMON + ["32MiB is probe input not product default"],
        "notes": "not Windows Job Object",
    },
    "illustrator-busy": {
        "class": "simulated_l0",
        "eligibility": "NEVER",
        "formal_budget_allowed": False,
        "simulated": True,
        "probe": None,
        "expect_exit": 0,
        "expected_error": None,
        "requires_result": False,
        "runtime_deps": ["npm", "apps/web/server/src/jobs.test.ts"],
        "behavior_pass_when": "jobs.test.ts busy does not claim; idle claims",
        "unverified": UNVERIFIED_COMMON + ["no native Illustrator"],
        "notes": "product L0 mock",
    },
    "relight": {
        "class": "simulated_l0",
        "eligibility": "NEVER",
        "formal_budget_allowed": False,
        "simulated": True,
        "probe": None,
        "expect_exit": 0,
        "expected_error": None,
        "requires_result": False,
        "runtime_deps": ["npm", "apps/web/ui/src/mockup"],
        "behavior_pass_when": "UI unit tests pass",
        "unverified": UNVERIFIED_COMMON + ["fake canvas, not GPU"],
        "notes": "product L0 mock",
    },
    "blender-serial": {
        "class": "blender",
        "eligibility": "BUDGET",
        "formal_budget_allowed": True,
        "simulated": False,
        "probe": "render_probe.py",
        "expect_exit": 0,
        "expected_error": None,
        "requires_result": True,
        "runtime_deps": [
            "python",
            "explicit blender executable",
            "workers/packaging/tools/render_quality_eval.py",
            "rf00-tall-carton",
            "rf00-wide-carton",
        ],
        "behavior_pass_when": "runtime_hard=pass; at most one Blender in owned tree",
        "unverified": UNVERIFIED_COMMON + ["Blender not started this slice"],
        "notes": "no /Applications default",
    },
}


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


def scene_by_id(scene_id: str) -> dict[str, Any] | None:
    return next((row for row in SCENARIOS if row["id"] == scene_id), None)
