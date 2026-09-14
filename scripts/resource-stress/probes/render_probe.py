#!/usr/bin/env python3
"""In-repo Blender render probe. Blender path is required and never guessed.

Importing this module does not load render_quality_eval or start Blender.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable

STALE_WORKTREE = "worktrees/beian-r04-resource-stress"


def parse_args(argv: list[str], env: dict[str, str] | None = None) -> tuple[Path, Path, Path]:
    if len(argv) < 2:
        raise SystemExit(
            "usage: render_probe.py <repo> <out> <blender-executable>; "
            "BEIAN_BLENDER may replace argv[3]; no Mac /Applications default"
        )
    repo = Path(argv[0])
    out = Path(argv[1])
    environ = os.environ if env is None else env
    blender_raw = (argv[2] if len(argv) > 2 else "") or environ.get("BEIAN_BLENDER", "")
    if STALE_WORKTREE in str(repo):
        raise SystemExit("refuse: stale worktree path in repo argv")
    if not repo.is_dir():
        raise SystemExit(f"refuse: repo is not a directory: {repo}")
    if not str(blender_raw).strip():
        raise SystemExit(
            "refuse: blender executable required via argv[3] or BEIAN_BLENDER; "
            "no Mac default; installed Blender is not authorization to start it"
        )
    blender = Path(blender_raw)
    if not blender.is_file():
        raise SystemExit(f"refuse: blender path is not a file: {blender}")
    return repo, out, blender


def load_eval_module(repo: Path) -> Any:
    path = repo / "workers/packaging/tools/render_quality_eval.py"
    if not path.is_file():
        raise SystemExit(f"refuse: missing render_quality_eval.py: {path}")
    spec = importlib.util.spec_from_file_location("r04_eval", path)
    if spec is None or spec.loader is None:
        raise SystemExit("refuse: cannot load render_quality_eval.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def execute(
    repo: Path,
    out: Path,
    blender: Path,
    *,
    eval_runner: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    out.mkdir(parents=True, exist_ok=True)
    if eval_runner is None:
        module = load_eval_module(repo)
        fixtures = [
            module.fixture_by_id(module.load_fixture_manifest(), key)
            for key in ("rf00-tall-carton", "rf00-wide-carton")
        ]
        report = module.run_eval(
            output_dir=out / "render",
            fixtures=fixtures,
            approved_baseline_path=out / "unapproved.json",
            update_baseline=False,
            render_blender=True,
            blender_executable=blender,
        )
    else:
        report = eval_runner(repo=repo, out=out, blender=blender)
    layers = report.get("quality_layers", {})
    result = {
        "ok": layers.get("runtime_hard", {}).get("status") == "pass",
        "quality_layers": layers,
        "fixtures": report.get("fixtures", []),
        "blender": str(blender),
        "repo": str(repo),
        "note": "Blender serial is a product probe; this module never guesses /Applications",
    }
    (out / "result.json").write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")
    return result


def main(argv: list[str] | None = None) -> int:
    repo, out, blender = parse_args(list(sys.argv[1:] if argv is None else argv))
    result = execute(repo, out, blender)
    print(json.dumps(result, default=str))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
