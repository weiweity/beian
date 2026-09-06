"""Keep private artwork and native applications outside the default L0 suite."""

import pytest


def pytest_addoption(parser):
    group = parser.getgroup("beian test boundaries")
    group.addoption("--run-real-artwork", action="store_true", help="Explicitly enable marked private artwork tests.")
    group.addoption("--run-native", action="store_true", help="Explicitly enable marked native application tests.")


def pytest_collection_modifyitems(config, items):
    # Directory availability and a caller's -m selection cannot opt a test in.
    # A test carrying both markers requires both explicit options.
    excluded, selected = [], []
    for item in items:
        requires_opt_in = any(
            item.get_closest_marker(marker) is not None and not config.getoption(option)
            for marker, option in (("real_artwork", "--run-real-artwork"), ("native", "--run-native"))
        )
        (excluded if requires_opt_in else selected).append(item)
    if excluded:
        items[:] = selected
        config.hook.pytest_deselected(items=excluded)
