#!/usr/bin/env python3
"""Controllable local child for harness tests. Not a product worker."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


def _write_pid(out: Path) -> None:
    (out / "child_pid.txt").write_text(str(os.getpid()), encoding="utf-8")


def _payload(out: Path, size: int) -> None:
    (out / "payload.bin").write_bytes((b"R04" * (size // 3 + 1))[:size])


def _timing(out: Path, queued: float | None, running: float | None) -> None:
    payload = {}
    if queued is not None:
        payload["queued_seconds"] = queued
    if running is not None:
        payload["running_seconds"] = running
    (out / "timing.json").write_text(json.dumps(payload), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--sleep", type=float, default=0.35)
    parser.add_argument("--bytes", type=int, default=8192)
    parser.add_argument("--exit-code", type=int, default=7)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    _write_pid(out)

    if args.mode == "success":
        started = time.monotonic()
        _payload(out, args.bytes)
        time.sleep(args.sleep)
        _timing(out, None, time.monotonic() - started)
        raise SystemExit(0)

    if args.mode == "fail":
        started = time.monotonic()
        _payload(out, args.bytes)
        time.sleep(min(args.sleep, 0.2))
        _timing(out, None, time.monotonic() - started)
        raise SystemExit(args.exit_code)

    if args.mode == "hang":
        (out / "hanging.txt").write_text("hang", encoding="utf-8")
        while True:
            time.sleep(1)

    if args.mode == "queue":
        queued_start = time.monotonic()
        print("R04_PHASE queued", flush=True)
        time.sleep(args.sleep)
        queued = time.monotonic() - queued_start
        running_start = time.monotonic()
        print("R04_PHASE running", flush=True)
        _payload(out, args.bytes)
        time.sleep(args.sleep)
        _timing(out, queued, time.monotonic() - running_start)
        print("R04_PHASE done", flush=True)
        raise SystemExit(0)

    if args.mode == "grandchild":
        child = os.fork()
        if child == 0:
            _write_pid(out)
            while True:
                time.sleep(1)
        (out / "grandchild_pid.txt").write_text(str(child), encoding="utf-8")
        os.waitpid(child, 0)
        raise SystemExit(0)

    raise SystemExit(f"unknown mode {args.mode}")


if __name__ == "__main__":
    main()
