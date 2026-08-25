# ADR-002 HTTP 产品层改为 TypeScript

日期：2026-08-19

## 决定

对外 HTTP（:8787）改为 `apps/web/server`（Hono + TypeScript）。  
对照引擎与 3D 流水线仍是 Python worker，由 TS 用子进程调用。

## 原因

- 审稿台 UI 已是 TS。产品层同语言，类型和目录更整齐。
- 对照规则（漏字/空格/`normalize`）不能一夜搬到 TS，搬了等于重写引擎。
- Blender / Illustrator / OCR 不是网页语言的活。

## 不做

- 不把 `fields.py` / 百度 OCR / Blender 脚本改写成 TypeScript。
- 不删旧 FastAPI 源码（遗留测试仍会 import `app.main`）。旧 vanilla `frontend/` 后来已删除，产品页面只由 React UI + Hono 提供。

后续设计约束见 `docs/adr-004-ousterhout-design.md`（深模块、唯一 HTTP 入口、8/31 前不搬迁 FastAPI）。不扩大本 ADR 的原始决定。
