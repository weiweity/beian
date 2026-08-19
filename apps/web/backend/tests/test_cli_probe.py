from app.cli import cmd_probe


class _Args:
    def __init__(self, target: str):
        self.target = target


def test_probe_python_ok():
    assert cmd_probe(_Args("python")) == 0


def test_probe_unknown():
    assert cmd_probe(_Args("nope")) == 2
