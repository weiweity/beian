from __future__ import annotations

from pathlib import Path

from openpyxl import Workbook

from app.fields import parse_excel_fields
from app.layout_zones import skip_sheet_field


def test_skip_sheet_field_names():
    assert skip_sheet_field("工艺说明")
    assert skip_sheet_field("颜色要求")
    assert skip_sheet_field("版本号")
    assert skip_sheet_field("  版本号 ")
    assert skip_sheet_field("更新内容：调整净含量")
    assert not skip_sheet_field("中文品名")
    assert not skip_sheet_field("生产信息及其他")
    assert not skip_sheet_field("备案版本号")
    assert not skip_sheet_field("执行标准版本号")


def test_parse_excel_skips_process_rows(tmp_path: Path):
    wb = Workbook()
    ws = wb.active
    ws.append([1, "中文品名", "达肤妍祛痘细肤面膜", None, ""])
    ws.append([2, "工艺说明", "烫金", None, ""])
    ws.append([3, "颜色要求", "专色", None, ""])
    ws.append([4, "版本号", "26H06A", None, ""])
    ws.append([5, "更新内容", "净含量改为7片", None, ""])
    ws.append([6, "净含量", "7片", None, ""])
    path = tmp_path / "confirm.xlsx"
    wb.save(path)
    fields = parse_excel_fields(str(path))
    names = [f["field"] for f in fields]
    assert names == ["中文品名", "净含量"]
