import builtins
import json

from app.cli import cmd_probe


class _Args:
    def __init__(self, target: str):
        self.target = target


def test_probe_python_ok():
    assert cmd_probe(_Args("python")) == 0


def test_probe_unknown():
    assert cmd_probe(_Args("nope")) == 2


def test_probe_python_missing_pypdf(monkeypatch, capsys):
    real_import = builtins.__import__

    def _blocked(name, *a, **k):
        if name == "pypdf":
            raise ImportError("no pypdf")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", _blocked)
    assert cmd_probe(_Args("python")) == 2
    err = capsys.readouterr().err.strip().splitlines()[-1]
    payload = json.loads(err)
    assert payload["ok"] is False
    assert "pypdf" in payload["error"]
