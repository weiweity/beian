"""Exercise pytest discovery in isolated synthetic projects, never real samples."""

import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


@pytest.mark.parametrize("samples_present", [False, True])
@pytest.mark.parametrize("flags, expected", [
    ([], {"ordinary"}),
    (["-m", "real_artwork"], set()),
    (["--run-real-artwork"], {"ordinary", "artwork"}),
    (["--run-native"], {"ordinary", "native"}),
    (["--run-real-artwork", "--run-native"], {"ordinary", "artwork", "native", "both"}),
])
def test_opt_in_is_independent_of_available_files(tmp_path, samples_present, flags, expected):
    shutil.copyfile(Path(__file__).with_name("conftest.py"), tmp_path / "conftest.py")
    (tmp_path / "pytest.ini").write_text("[pytest]\nmarkers =\n    real_artwork: private\n    native: native\n")
    if samples_present:
        (tmp_path / "samples").mkdir()
    (tmp_path / "test_fixture.py").write_text('''
from pathlib import Path
import pytest

def record(name):
    Path(name + ".ran").touch()

def test_ordinary(): record("ordinary")

@pytest.mark.real_artwork
def test_artwork(): record("artwork")

@pytest.mark.native
def test_native(): record("native")

@pytest.mark.real_artwork
@pytest.mark.native
def test_both(): record("both")
''')
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "--strict-markers", *flags],
        cwd=tmp_path, capture_output=True, text=True, timeout=30,
        env={**os.environ, "PYTEST_ADDOPTS": "", "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1"},
    )
    assert result.returncode == (0 if expected else 5), result.stdout + result.stderr
    assert {path.stem for path in tmp_path.glob("*.ran")} == expected
