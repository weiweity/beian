# Design: 对照 PDF 入稿与证据路由 V2

Status: IMPLEMENTED（`0.16.0.0` 发布候选）

Scope: `apps/web/backend` 对照 worker + 审稿页证据消费

Related: `review-job-module.md`、`../adr-004-ousterhout-design.md`

## Problem

旧流程把“这个 PDF 有没有文字层”当成整份文档的单一判断。真实包装稿会同时出现活字页、转曲页、整页图片和少量尺寸标注；全局信任文字层会漏掉转曲文案，全量 OCR 又会重复识别活字、制造重框和额外误差。证据定位还会把区域上下文误当字段命中，给人工终审画出并不存在的绿框。

V2 不重写 `fields.py`，也不增加 HTTP 或 OCR 引擎。它在现有 CLI 内建立一个稳定的入稿边界：先按页判源，再让字段核对只消费一份合并文本和一份权威词框。

## Decision

选择“按页自适应路由”，不选以下两种方案：

- 全文只信 PDF 文字层：快，但混合稿会漏掉转曲或图片页。
- 每页同时跑多套 OCR 后取并集：召回看似更高，但框会重复，供应商差异泄漏到字段层，也无法说明哪个结果可信。

数据流固定为：

```text
PDF
  -> render_pdf（高清核对面）
  -> ingest（逐页 live_text / outlined / image）
  -> ocr（只跑非 live_text 页，单次百度 accurate）
  -> layout（稳定区域与旧 zones 兼容输出）
  -> match（既有 fields 规则）
  -> field_verify（单钉证据预算）
```

## Page classification

`pdf_ingest.py` 复用 PyMuPDF 的文字层和图形统计，不复制抽字实现。

- `live_text`：去掉乱码和刀版尺寸后，可用字符达到阈值；40–79 个字符只有在路径不密集时才算活字。
- `outlined`：可用字符不足且路径密集，按转曲稿处理。
- `image`：几乎没有可用文字，也不像密集转曲路径。
- `mixed`：文档内各页模式不一致；只作为文档诊断，实际路由仍逐页执行。

刀版尺寸过滤覆盖单值、`29.35×56×30mm`、`W29.35 H56` 等组合格式；纯整数日期或批号不因斜杠/短横线被直接删除。高路径密度的尺寸页不能因此跳过 OCR。

公开任务 JSON 只保留模式、页级计数和短警告。文字层全文、span 和内部块不越过 worker 边界。

## Source routing and merge

- 全活字文档不调用 OCR，词框来自映射后的 PDF span。
- `outlined` / `image` 页各跑一次百度 `accurate`；不启用 Paddle、zone boost 或多引擎并框。
- 混合文档中，同页定位以 OCR 词框为准，未跑 OCR 的页保留 PDF 词框。
- 只要某页进入 OCR 路由，其识别文本就必须进入 `pack_text`；不能因为该页残留一个尺寸 span 就丢掉短条码或短文案。

## Layout and evidence contract

`pack_layout.py` 从权威词框推导稳定区域，供品名主视觉和长字段选框；旧 `layout_zones` 继续作为兼容输出。区域是定位依据，不是字段结论。

`field_verify.py` 在既有 `compare_fields` 之后执行：

- 每字段最多保留 1 个真实 `hit` 和 1 个 `check` / `miss_anchor`。
- `context` 只表示区域上下文，永远不能提升为真实命中；没有真框时必须 `no_bbox=true`。
- 多页警告不合成跨页巨框；优先显示明确 `check`，字段页跟随警告框，确保前端能切到正确页。
- 中英文品名可共用一个联合钉，但仍保留两条字段、两份人工结论；任一字段有独立警告时不配对。前端按 `bilingual_pair_id` 只画一个共享钉。

这些约束只减少虚假证据，不改变“一致 / 疑点 / 缺失”的人工终审语义。

## Compatibility and failure semantics

- HTTP 仍只有 Hono `:8787`；Python 仍只由 `python -m app.cli compare|rework` 调用。
- CLI stdout 最后一行仍是结果 JSON；新增阶段只通过 `STAGE ingest|layout` 暴露。
- `jobs.ts` 继续是任务文件唯一写者，并把 `pack_layout`、`ingest` 等诊断字段纳入受控合并。
- 看板阶段百分比按 `render_pdf -> ingest -> ocr -> layout -> match` 单调前进；没有真实阶段仍不猜百分比。
- 旧任务无需迁移；`engine_version` 低于 `tvt-lite-2.0` 时按既有规则提示重建。
- OCR 失败、无真实 bbox 或分类不确定时保留人工确认，不静默伪造成功。

## Verification

L0 必须覆盖：

- 活字、转曲、图片和混合页分类；组合刀版尺寸不能触发活字误判。
- 活字页跳过 OCR；混合页只 OCR 非活字页；同页词框不重复、跨页文本不丢失。
- 区域选择、单钉预算、context-only 失败闭合、跨页警告页和中英文共享钉。
- 新阶段在服务端映射，并在看板/等待卡中保持单调。

L0 只证明合同和合成夹具。真实稿准确率仍以人工核定金标为 L2，不以单测或 Mac 结果代替杭州 Windows 验收。
