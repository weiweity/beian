# ADR-007：包装 3D 渲染真实感、清晰度与能力合同

- 日期：2026-09-04
- 状态：ACCEPTED PLAN — `/plan-eng-review` 已完成，D1–D8 已锁定；实现、L1、L2、UAT 均未开始
- 目标执行者：Grok / Codex 等编码代理，人工负责人负责选择、金标与发布闸门
- 关联：`docs/adr-005-packaging-structure-v2.md`、`DESIGN.md`、`workers/packaging/README.md`、`docs/pouch-v1-acceptance.md`
- 基线：`origin/main` `b39f147`，版本 `0.21.25.0`

## 1. 结论先行

这不是“再调亮一点”或“给白盒加一圈描边”的问题。四个表象——真实感弱、白盒吃边、盒型通用性差、字体模糊——来自同一个缺口：现有结构链路已经版本化并可验证，但结构确认之后没有同等级别的**渲染合同**。`workers/packaging/blender/render_job.py` 把所有任务交给同一个六面方盒、同一套纸材、固定三灯棚和固定输出策略；浏览器又把 1440 卡图缩到 canvas 后停在那里，虽预取了全图却不升级显示源。

推荐在现有 `workers/packaging` 内部增加版本化 `packaging-render-spec/1`，并让它成为切面像素预算、family 几何、纸材/涂层、相机、棚光、输出和质量报告的唯一输入。保留 Hono、现有作业队列、`ResolvedPackagingJob`、Blender 后台进程、六面贴图、GLB 验证和现有文件 key；不新建 HTTP 服务，不复制第二套流水线。旧单采用版本化输出代际：既可按 `compat-legacy-v0` 重渲，也可显式生成新版 profile；ready 代不可变，当前展示代通过单一原子指针切换。

第一阶段只把**矩形纸盒**做成可解释、可测、可复现的高质量模型。现有膜袋继续明确标为 `pouch_thin_card_v1`，即 3 mm 薄盒预览；它不能因为画面更好就改名成真实软袋。其他异形盒、圆筒、瓶罐、带侧褶/插底袋必须逐 family 接入结构事实、几何生成器、材质合同、GLB 验证和 L2 金标，未知类型继续失败关闭。

## 2. 已继承且不重审的边界

以下决定已经由现有代码、ADR-005、AGENTS 和此前工程评审锁定，本 ADR 不推翻：

1. `apps/web/server` 仍是唯一 HTTP 产品边界，产品端口仍只有 `:8787`；不得增加 Python HTTP 或第三个端口。
2. 打样台仍只调用 `workers/packaging`；缺 Blender 必须明确失败。
3. `PackagingStructure` / `ResolvedPackagingJob` 仍是结构事实源；不按颜色、普通图层名、bbox、模板或任务 ID 猜结构。
4. 只有结构接受后才进入 Blender；GLB 继续核对毫米尺寸、六面贴图来源、方向、镜像、Alpha 和闭合 Core。
5. 产品 RGBA、ground pass、white-set pass 分离；网页背景切换和灯光调节不重新排 Blender。
6. `read_front` / `read_back` 等切面图是验字事实源；3/4 静帧和 GLB 主要用于看形，不能宣称替代印刷面核字。
7. 不引入 Blender HDRI。棚必须可复现，且不会把用户稿或第三方资产带进运行时。
8. Mac L0、杭州 L1、真实稿 L2 和刘籽烨 UAT 分开；没有 L2/UAT 不写“生产质量完成”。
9. 真稿、人工真值与金标输出不进 Git，也不得在没有书面许可时送到外部模型。

## 3. 问题定义与完成标准

### 3.1 用户看到的四个问题

| 症状 | 不是 | 真正要完成的结果 |
|---|---|---|
| 3D 假、光影平 | 不是只把曝光拉高 | 纸板有厚度、边缘、折角和可辨材质；棚光随尺寸稳定；正反两张看起来属于同一摄影棚 |
| 白盒融进背景 | 不是给白色任务写特判描边 | 白卡、银底、白墙白台上仍有连续轮廓、面间层次和接触关系；深色盒不被同一规则压黑 |
| 很多模型不能做 | 不是承诺“任意包装都能做” | 能力矩阵公开、family 显式分派；支持的必过完整合同，不支持的明确停住；新增模型不改 Hono 和其他 family |
| 字体模糊 | 不是末端加锐化 | 能追踪每次栅格和缩放；切面像素由最终投影反推；全图加载后替换卡图；下载使用全尺寸；验字仍回到 `read_*` |

### 3.2 Definition of Done

本 ADR 的实现只有同时满足以下条件才算完成：

- 新任务的 `resolved_job.json` 含经过验证的 `packaging-render-spec/1` 和稳定 hash；重渲棚消费同一合同。
- 矩形花盒不再由散落的隐式常量决定几何、材质、相机和灯光；所有可变项来自已验证 profile。
- `packaging_family` 不再被 Blender 忽略；未知 family 返回稳定、可执行错误，不回落方盒。
- 每个切面记录源像素密度、目标像素密度、相机投影密度和缩放次数；预算不足时明确失败，不静默降采样。
- 打样单首屏仍可快速显示 1440 卡图，但全图 decode 完成后原位无闪烁升级；开发态/测试能证明当前 canvas 使用的是 card 还是 full。
- 全尺寸下载不经过卡图；输出尺寸、Alpha、色彩变换和合同 hash 可从结果文件追溯。
- 合成白盒、深色盒、细长盒、矮宽盒与文字标定样片通过自动门；杭州私有真稿完成 A/B 与人工评分。
- 旧已出图单继续打开、合成、下载；首次变更前导入不可变原始代；旧版重渲和新版升级分别生成独立代，失败不改变当前展示代。
- `npm test`、质量门、类型、显式 Blender 质量命令、杭州 L1、L2 和 UAT 的证据分别记录，不互相冒充。

## 4. 当前链路与证据

### 4.1 当前数据流

```text
.ai
  │
  ▼
Illustrator / sidecar
  │  PackagingStructure + artwork PDF
  ▼
structure_v2 resolver
  │  ResolvedPackagingJob/3：dimensions + six faces + packaging_family?
  ▼
render_face_assets
  │  PyMuPDF vector raster → Pillow BICUBIC affine → panel_*.png
  ▼
pipeline.py
  │  template.render + outputs → resolved_job.json
  ▼
Blender render_job.py
  │  add_box（当前所有 family）+ 固定材质 + 固定三灯棚
  ├──────────▶ .blend / .glb + 六面合同验证
  └──────────▶ full product / ground / set PNG
                         │
                         ▼
                 Pillow LANCZOS → 1440 card
                         │
                         ▼
             createImageBitmap 默认 low resize
                         │
                         ▼
             browser canvas compositor / download
```

### 4.2 现有实现已经做对的事

不得为了重构而重建这些能力：

- `structure_v2` 已把结构语义、拓扑、人工确认和 Blender 分开。
- `render_face_assets()` 已按物理面裁切源 PDF，保留透明未印刷区，并至少提供 `20 px/mm`；超像素预算会失败关闭。
- `resolved_job.json` 已集中保存尺寸、六面资产、输出路径、模板 render 配置和结构 hash。
- `render_job.py` 已使用毫米单位、正交相机、产品/ground/set 分 pass，并能保存 `.blend`、导出 GLB。
- `glb_verify.py` 已验证六面纹理绑定、UV 方向/镜像、尺寸、表面积、体积和闭合 Core。
- `write_review_cards()` 只生成派生卡图，全尺寸静帧仍在磁盘。
- 浏览器下载路径已重新加载 full 产品/ground/set，再按当前灯光合成；下载没有使用 card。
- `POST /api/mockups/:id/relight` 已能只重跑 Blender，不重跑 Illustrator。

### 4.3 直接证据

| 位置 | 当前事实 | 对症状的影响 |
|---|---|---|
| `render_job.py:add_box` | 一个 cube Core + 六个平面；固定 `0.45 mm` Core bevel、`0.065 mm` panel gap | 纸板、折边、封口和 family 差异都被压成方盒外观 |
| `render_job.py:main` | 无条件调用 `add_box(job)` | `packaging_family=pouch` 虽已进入 job，Blender 仍不消费 |
| `make_material` | 印刷纹理统一乘 `PAPER_ALBEDO_LINEAR=0.70`；统一 roughness/specular；Image Texture 为 `Linear` | 白盒有一定压暗，但纸、油墨、膜和局部工艺没有分层 |
| `add_studio` | 固定灯位/能量、固定世界白、`Standard` 变换、8-bit PNG | 极端长宽比和不同白度不一定稳定；参数来源不可追踪 |
| 模板 | 默认 3000×3600、`camera_ortho_scale_mm=224`、`raster_width_px=10000` | 只有参考花盒接近手工配平，其他尺寸靠部分自动相机补偿 |
| `render_face_assets` | 矢量转 RGBA 后做一次 BICUBIC 仿射 | 必要的几何映射已经发生一次有损采样，后续必须受预算约束 |
| `write_review_card` | full 再 LANCZOS 缩到最长边 1440 | 卡图适合首屏，不适合当最终清晰源 |
| `MockupPage.previewSource` | card/full 又按 canvas 尺寸 `createImageBitmap`，未指定 `resizeQuality` | 浏览器默认是 low；卡图发生第二次派生缩放 |
| `GroundedShot` | full 只预取到缓存，没有替换 `previewRef` | 网络空闲后页面仍停留在卡图；“原图”按钮之外不会自动变清 |

## 5. 根因模型

### 5.1 真实感

真实感是几何、材质、光照、相机、色彩变换和输出采样的乘积。当前每一层都“能出图”，但没有一份合同说明它们共同要达到什么：

- 结构告诉 Blender 六面是什么，却不告诉渲染器应该用哪种可视几何 family。
- Core 是完整方块，面片是零厚度；可见边缘主要来自固定 bevel 与灯光，不是材质/纸板参数。
- 素材颜色与纸面反射混在一个 Base Color 链；无法表达未涂布白卡、覆膜、整体上光和纸边。
- 灯以绝对毫米和绝对能量摆放，对 50×50×180 mm 参考盒尚可，对极端比例没有同等覆盖。
- `Standard`、`Khronos PBR Neutral`、`AgX` 没有经过同一金标对照；现值是实现默认，不是质量结论。

### 5.2 白盒吃边

白盒边界不是单一 CSS 问题。它取决于：

1. 纸面显示亮度是否与背景完全重合；
2. 面法线、微倒角和软箱是否产生连续但不过曝的明暗变化；
3. 产品 Alpha 边缘在透明 PNG 和 canvas 上是否出现白边/黑边；
4. 地面与产品底边之间是否有接触影；
5. 卡图缩放是否抹掉 1–2 px 的轮廓线索。

因此正确修复是建立“白色主体分离”质量门，验证白底、银底和白墙白台三种组合；不能写 `if box_is_white`、不能用任务 ID，也不能只给 UI 加边框。

### 5.3 通用性

当前结构通用性与渲染通用性被混为一谈：

- ADR-005 回答“能否证明六面与成盒关系”。
- 本 ADR 回答“这个结构 family 应该生成什么可视几何和材质”。
- 产品能力矩阵回答“用户可以期待哪些包装类型”。

只有三者都通过，才可称该 family 受支持。仅能把两张袋片压成 3 mm 方盒，不等于拥有真实膜袋建模能力。

### 5.4 字体模糊

字体清晰度链路至少有四次采样：

1. PDF 矢量 → PyMuPDF RGBA；
2. RGBA → Pillow 仿射映射到 face；
3. face texture → Blender 斜面投影、抗锯齿与像素滤波；
4. full → card → `ImageBitmap` → canvas。

8-bit PNG 会影响色阶和渐变精度，但不是文字模糊的首要根因；盲目改成 16-bit 或末端锐化不会消除重复缩放。根治顺序必须是：记录投影需求 → 保证源纹理采样 → 控制 Blender 像素滤波 → 页面从 card 升级 full → 最后才评估是否需要可解释的轻量锐化。

## 6. 方案比较

### 方案 A：继续在 `render_job.py` 调常量

做法：继续修改 `PAPER_ALBEDO_LINEAR`、灯能量、背景灰、bevel 和 CSS filter。

优点：改动少、短期能让某一张白盒更顺眼。

缺点：参数没有 family、材质和版本归属；换一个尺寸/颜色又要补丁；缓存不知道渲染含义已变；无法回答字体在哪一层丢失；不能扩展模型能力。

结论：拒绝。可把这些参数当 Phase 0 候选，但必须通过渲染合同解析并纳入 hash。

### 方案 B：现有流水线内增加版本化渲染合同

做法：结构确认后生成 `packaging-render-spec/1`；切面、Blender 和质量报告消费同一 spec；family 用内部生成器分派；UI 修正渐进源升级。

优点：复用全部现有边界；错误可在 Blender 前消除；参数可追踪、缓存可失效、测试可覆盖；新增 family 只实现明确接口。

缺点：需要跨 Python、Blender 与 React 的分阶段改动；必须先建基线，否则容易把“不同”误写成“更好”。

结论：推荐。

### 方案 C：新建独立 3D 服务或引入文本生成 3D

做法：另起 HTTP/队列/云模型，让 AI 从图片或提示词直接生成 mesh/渲染。

优点：演示上可能快速得到多样外观。

缺点：破坏唯一 Hono 和单一 worker 边界；无法证明毫米尺寸、六面来源和镜像；生成结果不确定；增加稿件出境、费用、部署和可用性风险；与“备案包装必须可核验”冲突。

结论：拒绝。Astra/Grok 可以帮助分析、写代码和看 A/B 图，不能成为生产 mesh 的事实源。

## 7. 目标架构

```text
                        ┌──────────────────────────────┐
                        │ ADR-005: structure truth     │
                        │ dimensions / faces / family  │
                        └──────────────┬───────────────┘
                                       │
                                       ▼
┌────────────────────────────────────────────────────────────────────┐
│ workers/packaging/render_contract.py                               │
│ load strict profile registry + validate + normalize + pixel budget │
│ output: packaging-render-spec/1 + render_contract_hash              │
└──────────────┬──────────────────────┬──────────────────────┬────────┘
               │                      │                      │
               ▼                      ▼                      ▼
      render_face_assets       Blender renderer       quality evidence
      per-face target ppm      family dispatch        pipeline_result
      bounded/fail-closed      geometry/material      metrics + versions
                                      │
                         ┌────────────┼────────────┐
                         ▼            ▼            ▼
                    product RGBA    ground        set
                         └────────────┬────────────┘
                                      ▼
                         generation staging + verify
                                      │
                                      ▼
                 immutable .render-generations/<generation_id>
                                      │
                         atomic current-generation pointer
                                      │
                                      ▼
                         existing output keys + GLB
                                      │
                                      ▼
                       browser progressive compositor
                         card first → full source swap
```

### 7.1 深模块边界

| 模块 | 对外接口 | 隐藏内容 | 不负责 |
|---|---|---|---|
| `structure_v2`（已有） | accepted `ResolvedPackagingJob/3` | Illustrator、拓扑、候选、锚点、六面推导 | 光影、纸材、浏览器 |
| `render_contract`（新增，一个 Python 深模块） | `resolve_render_spec(structure_job, profile_id, output_request) -> dict`、`validate_render_spec(dict)` | profile registry、family 映射、采样公式、兼容迁移、hash | Blender API、HTTP |
| Blender renderer（现有内重构） | `render(resolved_job)` | geometry builder、materials、studio、shots、passes | 结构猜测、用户权限 |
| `glb_verify`（已有加深） | 当前 compare/load 函数 + family 验证分派 | glTF/GLB 解析、UV、材质、Core | 视觉审美评分 |
| render generation registry（Hono 内新增深模块） | create candidate、activate、resolve current、page history、recover orphan | 隐藏目录、代际状态、原子指针、旧单导入、磁盘准入 | Blender 参数、结构推断、图片合成 |
| UI compositor（已有加深） | product/ground/set → canvas/download | card/full 生命周期、DPR、采样质量、Alpha 合成 | 重跑 Blender、验字 |
| quality eval（新增工具，不是服务） | fixture/result → JSON/HTML contact sheet | 指标、基线差异、版本信息 | 自动业务签字 |

只新增两个有独立复杂度的深模块：Python `render_contract` 隐藏渲染规则，Hono render generation registry 隐藏输出代际事务；其余都是加深现有模块。不要创建 `GeometryService`、`MaterialService`、`LightingService` 等只转发参数的浅类。

## 8. `packaging-render-spec/1`

### 8.1 生成时点

当前 `pipeline.py` 先调用 `render_face_assets()`，再组装 `resolved_job.json`。新顺序必须是：

1. `structure_v2` 得到 accepted structure job；
2. 从结构模板取得受限 profile ID，从唯一 registry 解析完整 profile 与 family，生成 render spec；
3. 用 render spec 的相机/主输出推导每个 face 的像素需求；
4. `render_face_assets()` 依据 per-face 目标出图；
5. 写 `resolved_job.json`，其余字段和输出 key 保持兼容；
6. Blender 验证 spec 后再建模。

### 8.2 顶层示例

下例表达字段形状，不锁死 Phase 0 尚未测出的纸张数值：

```json
{
  "schema": "packaging-render-spec/1",
  "renderer": {
    "engine": "BLENDER_EEVEE_NEXT",
    "minimum_blender_version": "project-supported",
    "profile": "packshot-neutral-v1"
  },
  "geometry": {
    "family": "rectangular_carton_v1",
    "outer_dimensions_mm": {"width": 47.5, "depth": 47.5, "height": 177.5},
    "substrate_profile": "white-card-default-v1",
    "closure_detail": "closed-carton-visual-v1"
  },
  "material": {
    "print_layer": "process-ink-v1",
    "finish_profile": "none",
    "spot_finish_mask": null
  },
  "shots": {
    "projection": "ORTHOGRAPHIC",
    "master_resolution_px": [3000, 3600],
    "views": ["front_right", "back_left"],
    "studio_profile": "three-softbox-no-hdri-v1",
    "view_transform_candidate": "KHRONOS_PBR_NEUTRAL"
  },
  "sampling": {
    "minimum_face_pixels_per_mm": 20,
    "maximum_face_pixels_per_mm": 64,
    "maximum_face_pixels": 32000000,
    "oversample_ratio": 1.5,
    "per_face_target_pixels_per_mm": {
      "front": 24.2,
      "right": 20.0,
      "back": 24.2,
      "left": 20.0,
      "top": 20.0,
      "bottom": 20.0
    }
  },
  "outputs": {
    "product_rgba": true,
    "ground_pass": "optional",
    "white_set_pass": "optional",
    "review_card_max_edge_px": 1440,
    "preserve_legacy_keys": true
  }
}
```

示例里的 `per_face_target_pixels_per_mm` 只演示结果，不是可复制的固定值；实现必须从当前尺寸、相机和输出分辨率计算。

### 8.3 验证规则

- schema、engine、family、profile、shots 必须在白名单；未知值失败关闭。
- 所有数值必须有限、为正并在现有资源预算内；布尔值不能冒充整数。
- `outer_dimensions_mm` 必须逐项等于 accepted structure 的尺寸，不能由 render template 覆盖。
- `geometry.family` 只能由 structure family + 明确兼容映射得到，不能从文件名或颜色推断。
- 未声明材质时使用版本化 `white-card-default-v1`；牛皮纸、深色纸、覆膜不能从图像均值猜。
- `spot_finish_mask` 非空时必须绑定可验证的独立语义资产；否则返回 `render_finish_mask_unsupported`。
- `master_resolution_px`、相机和 per-face sampling 必须互相自洽；无法在上限内满足时返回 `render_texture_budget_exceeded`。
- 合同规范化后按稳定 JSON 编码求 SHA-256，写 `render_contract_hash`；hash 进入 `job_fingerprint`。
- 新任务缺 spec 不得进入 Blender；旧 resolved job 的兼容合成见第 15 节。

### 8.4 Profile registry（D6 已决定）

- 唯一事实源为仓库内 `workers/packaging/profiles/render-profiles.v1.json`；生产运行时不读取远端配置、用户设置或环境变量覆盖视觉语义。
- 初始只登记 `compat-legacy-v0`、`packshot-neutral-v1`、`smoke-v1`。每项完整声明 geometry、material、studio、color、sampling 与 outputs；禁止 profile 间运行时多重继承。
- `render_contract.py` 是唯一 loader：拒绝未知顶层/嵌套字段、重复 ID、非法数值、引用环和 family/profile 不兼容；其他模块只能消费已经规范化的 render spec。
- 结构模板只保存 `render_profile_id` 以及白名单内的 output request；不得继续保存纸材、灯位、world strength、view transform 或 SKU 相机常量。
- 未发布候选可以在 P0 A/B 中调整；profile ID 一旦随生产 VERSION 发布，其视觉语义不可原位修改。后续改变任一会影响像素的值，都必须新建 ID，并使合同 hash 与 cache fingerprint 改变。
- registry 每个 profile 带由其规范化内容计算的声明 hash；`render_contract.py` 运行时重算并核对。CI 再通过同一 loader 比较 merge base：已发布 ID 不得删除、改名或改变规范化 hash，只允许追加新 ID。不能靠开发者同步修改测试常量来“批准”原位变更。
- registry 原始字节 SHA-256、所选 profile 的规范化 hash 与最终 contract hash 都写入质量报告，便于区分“配置文件变了”和“本单解析结果变了”。
- Blender、杭州 smoke 和 quality eval 不自行读取 registry；它们只接收同一个 `render_contract.py` 产生并验证的 spec，避免出现第二套默认解析器。

## 9. Family 与几何

### 9.1 能力矩阵

| 产品/结构 | 当前 `0.21.25.0` | 本 ADR 第一交付 | 宣称 |
|---|---|---|---|
| 矩形花盒 / RSC 类闭合纸盒 | 六面方盒 | `rectangular_carton_v1` 高质量闭合纸盒 | L2/UAT 后可称受支持 |
| 外盒 + 内衬 | 选中一套完整候选后各自仍方盒 | 仍一次只渲染被选中的完整 carton | 不做同场装配 |
| 膜袋两片 v1 | 3 mm `add_box` | 显式映射 `pouch_thin_card_v1`，保持现状与诚实文案，不套用 carton 真实感验收 | 只能称薄盒预览 |
| 有插底/侧褶/热封边的软袋 | 不支持 | 不支持 | 必须新 family + L2 |
| 异形盒、天地盖、抽屉盒 | 结构未建完整合同 | 不支持 | 不能回落矩形盒 |
| 圆筒、瓶、罐、软管 | 不属于当前刀模六面模型 | 不支持 | 另立产品与输入合同 |

### 9.2 分派合同

Blender 入口从无条件 `add_box(job)` 改成白名单分派：

```python
builders = {
    "rectangular_carton_v1": build_rectangular_carton,
    "pouch_thin_card_v1": build_pouch_thin_card_preview,
}
builder = builders.get(spec["geometry"]["family"])
if builder is None:
    raise RenderContractError("render_family_unsupported", ...)
model = builder(job, spec)
```

这只是同一个 Blender 脚本里的函数分派，不是插件系统、服务发现或第二条流水线。

### 9.3 `rectangular_carton_v1`

第一版目标不是做完整折叠动画，而是让闭合盒具有稳定、可验证的物理线索：

- accepted dimensions 始终表示最终外尺寸；纸板厚度和面片位置不能把 GLB 外框放大到容差外。
- Core、印刷表面与纸边有明确角色；面片不再依赖“离 Core 0.065 mm”作为全部厚度错觉。
- 倒角、纸板厚度和微法线来自 `substrate_profile`，并按尺寸夹限；不得对特定 SKU 写值。
- 六面 UV 仍来自现有 face assets；任何几何重排后继续通过 `compare_glb_surface_contract`。
- 可见接缝/折痕只有在结构合同能提供可靠 closure hint 时才出现；第一版不从颜色或图片线条猜折痕。
- 未印刷 Alpha 区显示声明的纸板 Core；不能填白、拉伸或改半透明。
- `.blend` 和 GLB 中保留可识别的 family/profile/hash 元数据。

### 9.4 `pouch_thin_card_v1`

- 继续使用 3 mm 深度和正反真实 artwork；侧面为纸面。
- family 名、warning、结果报告必须明确 `preview_fidelity=thin_card`。
- 不增加鼓包、封边或随机形变；那会让错误几何看起来更可信。
- 未来真实软袋必须新建 `flexible_pouch_v1`：输入需要封边、袋口、插底/侧褶、厚度/充填状态；GLB 验证不能复用六面 Core 断言。

### 9.5 新 family 接入清单

任何新增 family 必须一次性交付：

1. 可验证的结构输入与 schema；
2. family → render family 显式映射；
3. geometry builder；
4. UV/材质绑定；
5. 相机/shot 适配；
6. GLB 几何与材质验证；
7. 合成 L0 正负样本；
8. 杭州 L2 金标；
9. UI 能力/失败文案；
10. README/TODOS/CHANGELOG 同步。

少一项就仍是实验，不进入受支持矩阵。

## 10. 材质合同

### 10.1 分层

材质至少分四个概念，不能继续把它们压成一个 Base Color 乘数：

| 层 | 来源 | 影响 | 未知时 |
|---|---|---|---|
| substrate | 显式 profile | 纸边颜色、粗糙度、微法线、厚度 | 白卡 default v1 |
| process ink | `panel_*.png` | 印刷颜色与 Alpha 覆盖 | 必须存在六面或 paper_only |
| overall finish | 显式 profile | 整体哑膜/亮膜/上光的 roughness、coat | none |
| spot finish | 独立语义 mask | 局部 UV/烫印区域 | 无 mask 就不支持 |

### 10.2 初始 profile

第一交付只需要少而稳的 profile：

- `white-card-default-v1`：兼容现有未知白卡；值由 Phase 0 标定并锁版本。
- `kraft-card-v1`：只有显式配置才用；不得从棕色印刷面猜。
- `overall-matte-lamination-v1`：显式整体哑膜。
- `overall-gloss-varnish-v1`：显式整体上光。
- `none`：无额外涂层。

深色纸、金属纸、珠光纸、透明窗口、烫金/烫银和局部 UV 在取得语义 mask 与金标前都返回“不支持该材质工艺”或按无工艺基础纸预览并清楚标记；不得静默伪造。

### 10.3 PBR 与 GLB

- Blender 静帧可以使用 Principled BSDF 的 roughness、coat、normal 等通道。
- GLB 只能依赖 glTF 2.0 与明确列入 `extensionsUsed` 的扩展；不支持的 Blender 节点不能假装已经导出。
- 新材质 profile 必须同时定义：静帧表现、GLB 可导出子集、验证规则和降级文案。
- 微法线属于 Non-Color 数据；颜色纹理按 sRGB 解码。两者不能共享错误色彩空间。
- Image Texture 的 `Linear`、`Cubic` 不凭直觉切换。用文字/线条标定片比较放大与缩小时的边缘宽度、锯齿和耗时；`Closest` 只适合像素艺术，不是印刷稿默认。

## 11. 相机、棚光与白盒分离

### 11.1 相机

- 保持正交相机，延续当前交付语言和 GLB/静帧一致性。
- 相机位置、target、ortho scale 继续从成盒尺寸推导；模板只允许声明 profile，不再用单一参考盒的 `224 mm` 静默覆盖不匹配尺寸。
- 记录每个 shot 中各 face 的像素投影矩阵，供切面采样和质量报告使用。
- 继续输出 `front_right` / `back_left`，不新增用户要理解的角度选项。

### 11.2 尺寸归一的三灯棚

保留 key / fill / rim 三盏 Area Light，但参数由 `studio_profile` 按相机坐标和模型包围盒解析：

- 位置以模型对角线或相机 frustum 的倍数表达，不写 SKU 绝对坐标。
- 软箱尺寸相对投影跨度表达，保证长盒、扁盒都有连续高光。
- 能量缩放需通过参考距离/面积标定；不得只把当前 `light_energy_scale=4` 复制到所有尺寸。
- key/fill/rim 比例固定在版本化 profile；正反 shot 使用相机空间对称规则，避免一面吃边、一面过曝。
- world 只做低强度环境填充；无 HDRI。
- ground 与 set 仍是可选 pass，失败不阻断产品 RGBA，但必须删除半成品并写质量 warning。

### 11.3 白色主体分离合同

白盒的通解不读 SKU，也不读整张稿的平均颜色。它使用声明的 substrate profile 和渲染结果测量：

- 白卡表面不能与纯白背景大面积剪成同值；当前“纸面显示约 sRGB 210–225”的经验范围只作 Phase 0 候选。
- rim 应在轮廓处提供可见但不发光的亮度梯度；不能变成后期紫边/灰边。
- 相邻可见面必须有稳定明暗次序，且不改变印刷色相来制造层次。
- 接地边必须有连续接触影；ground/set pass 和 product Alpha 的边缘不能出现黑边、白边或一像素缝。
- 自动评测在白、银、白墙白台三种背景上测边缘连续、局部对比与 Alpha halo；阈值由 Phase 0 基线 + 人工好样冻结。
- UI 的浅色 frame 内描边只是容器边界，不能计入产品轮廓通过。

### 11.4 色彩管理决策方法

Blender 官方把 `Khronos PBR Neutral` 描述为面向 PBR 色彩准确、适合产品摄影的变换；`AgX` 提供更高动态范围和更电影化的高光；`Standard` 更接近直接显示转换。不能只因名字“更专业”就全量切换。

Phase 0 对同一线性场景固定材质和灯，只替换 view transform，比较：

1. 印刷标准色/灰阶误差；
2. 白盒高光是否剪切；
3. 深色盒暗部是否堵死；
4. 纸面是否变塑料；
5. 人工 A/B 偏好；
6. GLB 查看器与静帧的可解释差异。

工程评审决定不预选赢家：`Standard`、`Khronos PBR Neutral`、`AgX` 在同一线性场景中受控对照，几何、纹理、灯位、曝光、分辨率、采样和随机种子全部固定，只替换 view transform。输出匿名编号，同时生成 JSON 与盲看 contact sheet。

选择规则必须在看结果前登记：

- 合成色块的中位与高分位色差不超过 P0 冻结上限；
- 白区高光剪切率不恶化，深色阶仍可区分；
- 浅灰细字、标定线和条码线保留率不下降；
- 白盒在白/银/白桌白墙夹具上的轮廓分离改善或不退化；
- 私有真实稿盲评在纸感、棚光和颜色任一项不能出现 hard reject；
- 多候选打平时选择色差更小、参数更少者；
- 没有候选全部通过时保留 `Standard`，继续修几何、材质和灯光，不强行升级色彩变换。

P0 结束后一次性冻结 transform、look、exposure、阈值、Blender 版本与 fixture hash；写入新 profile ID 和合同 hash。已发布 profile 不原位换 transform。

## 12. 端到端清晰度合同

### 12.1 投影反推切面像素

固定 `20 px/mm` 只说明源纹理有下限，不知道最终 shot 会把某个面投影成多大。新算法在切面前计算每个 face 的 2×2 局部毫米→输出像素 Jacobian：

```text
J_face = project(camera, shot, face_basis, 1 mm local steps)
projected_max_ppm = largest_singular_value(J_face)
projected_min_ppm = smallest_singular_value(J_face)

target_face_ppm = clamp(
  max(minimum_face_ppm, projected_max_ppm * oversample_ratio),
  minimum_face_ppm,
  maximum_face_ppm
)
```

- `projected_max_ppm` 防止源纹理低于屏幕需要。
- `projected_min_ppm` 记录斜面压缩后的可读性；它低不是加大源纹理就能完全修复，UI 仍需 `read_*`。
- `oversample_ratio` 初始候选 1.5，必须经标定；不能散落在模板。
- 对两个 shot 取同一 face 的最大需求，避免正面清晰、反面重渲时变糊。
- 超过 `maximum_face_ppm` 或 32MP 预算时返回稳定错误和所需/允许像素；不静默缩小。

### 12.2 栅格次数预算

目标链路允许的有损步骤：

1. PDF 矢量经 PyMuPDF 高分辨率栅格；
2. 为把任意旋转/仿射 artwork 映到物理 face，允许一次高质量 affine resample；
3. Blender 在最终相机采样纹理；
4. 页面把 card 或 full 一次缩到 DPR canvas。

禁止：先输出低分全页图再切面、full→card→另一个中间尺寸→canvas、下载从 card 放大、重复 JPEG、有损截图作为源。

### 12.3 Blender 采样

- 保持 EEVEE 抗锯齿；提高 sample 与减小像素 filter 宽度必须一起评测锐度、锯齿和耗时。
- 不把 Image Texture 直接改 `Closest`；它会把文字模糊换成闪烁/锯齿。
- 输出 master 继续无损 PNG；16-bit 只用于已证明的 banding/合成精度问题，不能当字体修复。
- 在 `blender_result.json` 记录 engine、Blender version、samples、pixel filter、view transform、master resolution 和每 face 投影密度。

### 12.4 浏览器渐进升级

当前预览必须改成明确的两阶段状态机：

```text
idle
  └─ visible → loading-card
       ├─ card ok → showing-card ─┬─ full ok → showing-full
       │                          └─ full fail → showing-card + retryable warning
       └─ card fail → loading-full
                            ├─ full ok → showing-full
                            └─ full fail → failed
```

实现要求：

- `createImageBitmap` 如带 resize，显式 `resizeQuality: "high"`；HTML 标准允许 quality preference，但跨浏览器仍由像素回归验证。
- 更优路径是 full decode 后直接作为 CanvasImageSource，在 `drawImage` 时只做一次 DPR 缩放；`ctx.imageSmoothingEnabled=true`，可用时设 `imageSmoothingQuality="high"`。
- full 完成后必须替换 `previewRef` 并重绘，而不是只放进 `stillLoads` 缓存。
- 组件卸载/尺寸变化时关闭旧 `ImageBitmap`、撤销 blob URL，防止内存泄漏。
- ResizeObserver 或已有尺寸触发必须防止旧请求覆盖新尺寸；用 generation token，不新增全局状态库。
- 开发态可在 DOM `data-preview-source="card|full"` 暴露非敏感来源状态，便于 E2E；生产 UI 不增加按钮或技术文案。
- 原图灯箱直接使用 full，不从当前 canvas 截图。

### 12.5 下载与验字

- 下载继续加载 full product/ground/set，在 full 尺寸 canvas 合成；输出尺寸写进质量报告。
- 调灯后的下载与预览使用同一合成函数和参数，不能出现“页面清楚、下载模糊”或相反。
- 3D 静帧必须尽量保留品牌字，但法规小字、成分、条码仍只由 `assets/panel_*.png` 的 `read_*` 区核对。
- 不能把 3D OCR 分数拿去改变审核结论；它只评估渲染链路是否损失了已知标定文本。

## 13. 质量证据合同

### 13.1 结果位置

不新增公开下载 key。质量证据嵌入内部 `pipeline_result.json` / `blender_result.json`：

```json
{
  "render_quality": {
    "schema": "packaging-render-quality/1",
    "render_contract_hash": "sha256:...",
    "engine": "BLENDER_EEVEE_NEXT",
    "blender_version": "...",
    "master_resolution_px": [3000, 3600],
    "face_sampling": {
      "front": {
        "source_ppm": 30.1,
        "target_ppm": 24.2,
        "projected_min_ppm": 12.8,
        "projected_max_ppm": 16.1,
        "resample_count": 2
      }
    },
    "passes": {
      "product": "pass",
      "ground": "pass",
      "white_set": "warn"
    },
    "machine_metrics": {
      "runtime_integrity": "pass",
      "fixture_regression": "not-run",
      "visual_observations": "warn"
    },
    "human_acceptance": "pending"
  }
}
```

机器指标与 `human_acceptance` 必须分字段。任何代理不得把 `machine_metrics=pass` 翻译成“籽烨已验收”。

### 13.2 合成质量夹具

Git 内夹具不得使用真实品牌稿，至少包含：

- 白卡盒：纯白、大面积浅灰、细灰字、黑字、透明未印刷角。
- 深色盒：大面积黑/深紫、白字，验证暗部和反光不过度。
- 几何比例：细长、接近立方、矮宽、宽深不等。
- 文字标定：中英文、数字、1D 条码线、QR 风格方块、0.15/0.20/0.30 mm 线宽和多档字号。
- Alpha 标定：透明覆盖边、纸板底、斜边，分别合成到白/灰/深色背景。
- family 负样本：未知 family、真实软袋声明、缺 profile、超像素预算。

### 13.3 三层自动门（D7 已决定）

自动指标用于抓回归，不假装定义审美；三层结果必须分开记录，禁止合成一个容易被误读的总分。

#### A. 真实 generation runtime hard gate

- render spec/schema/profile/hash 完整，registry/profile/contract hash 与六面资产 hash 自洽。
- family/profile 组合受支持；所有数值有限，像素、内存和磁盘准入未越界。
- 两张产品 full、对应 card 与 GLB 存在、可解码；分辨率、Alpha 模式和 `source_ppm >= target_ppm`。
- 沿用并扩展 GLB hard gate：毫米尺寸、闭合 Core、六面贴图来源、UV、方向和镜像。
- generation manifest、文件 hash、staging→ready 原子事务完整。任一失败都不得发布或切换 current generation。

#### B. 脱敏固定夹具 regression hard gate

- 标定线 10–90% edge spread、过冲和锯齿率不超过冻结基线容差。
- 同一产品合成到白/深背景时 Alpha halo 达标，轮廓连续性不下降。
- 已知合成字符串、条码线和 QR 风格块的渲染前后保留率不下降；只测固定夹具，不调用外部 OCR。
- 固定白盒在白/银/白桌白墙夹具上的最小轮廓分离达到 Phase 0 冻结阈值。
- fixture、registry、profile、contract、Blender 与 baseline 身份一致，否则结果是 `baseline_mismatch`，不能假 pass。

这层运行在显式 Blender 质量套件；杭州 L1 使用其小型 smoke 子集。它可以阻止相应代码/发布门，但不能把某个真实客户任务判成业务不合格。

#### C. warning / human only

- 纸张是否像纸、棚光是否高级、正反是否协调、ground/set 接触是否自然。
- 深色、透明、留白或艺术化设计的亮度排序；真实稿 OCR 或“字体看起来清楚”。
- 印刷色是否可接受，以及相对基线的小幅性能/体积变化。

这些观察写 JSON 和 contact sheet，不能阻止真实任务 ready。只有超过明确资源上限、硬超时或确定性完整性错误才从性能维度 hard fail。

### 13.4 人工量表

杭州 L2/UAT 对每个 gold case 盲看旧/新 A/B，1–5 分：

1. 盒型可信；
2. 纸而非塑料/发光块；
3. 白盒边缘完整；
4. 正反棚光一致；
5. 主标题和品牌字不因渲染明显糊；
6. 印刷色没有不可接受偏移；
7. ground/set 接触自然；
8. GLB 与静帧六面一致。

记录评审人、时间、源稿 hash、旧/新合同 hash、结论和拒绝原因。真实截图留在私有证据目录。

## 14. 测试分层

### 14.1 L0：默认 `npm test`

不要求 CI 安装 Blender。新增纯逻辑与源码合同测试：

- render spec schema、默认映射、unknown family/profile、NaN/布尔/越界、稳定 hash。
- structure dimensions 不可被 template 覆盖。
- per-face Jacobian、正反 shot 最大值、像素 clamp、32MP 失败路径。
- cache fingerprint 含 render contract/profile 版本。
- 旧 resolved job 合成兼容 spec；新任务缺 spec 失败。
- `render_job.py` family 分派、无条件 `add_box` 消失、结果写 engine/version/hash。
- profile 默认无 spot finish；没有 mask 时失败或明确降级。
- card 尺寸/Alpha 保留；full 不被覆盖。
- UI 状态机：card 成功→full 成功替换、card 失败→full、full 失败保留 card、resize 竞态、卸载释放。
- download 只请求 full keys；背景切换/灯光不 enqueue。

### 14.2 显式 Blender 质量套件

新增一个不随默认 L0 运行的命令，例如：

```bash
apps/web/backend/.venv/bin/python workers/packaging/tools/render_quality_eval.py \
  --blender /Applications/Blender.app/Contents/MacOS/Blender \
  --fixtures workers/packaging/fixtures/render-quality \
  --output /tmp/beian-render-quality
```

要求：

- 没 Blender 明确失败/skip 原因，不能伪造绿灯。
- 输出 contact sheet、JSON 指标、Blender 版本、合同 hash、耗时和基线差异。
- `--update-baseline` 必须显式调用，普通测试不能自动改 baseline。
- 基线缩小/阈值放宽需要评审；不能因为新实现失败就自动接受新图。
- 输出目录默认 Git 外；Git 只放脱敏输入和经评审的小型基线/阈值。

### 14.3 L1：杭州发版环境

第一版不把整套像素回归塞进每次 `release.ps1`，但每次可信 `main` 发布都必须在 transaction fence 内阻塞执行小型 Blender 合同冒烟。L1 至少：

- 确认 Blender 可执行文件、版本和 EEVEE Next 能力；
- 跑一个很小的脱敏 render-contract smoke，验证 spec→Blender→PNG/GLB→quality report；
- 验证 `render_contract_hash`、六面、Alpha、输出 key 与当前 VERSION；
- 有在途 Illustrator/Blender 作业时遵守 transaction fence，不抢单；
- 失败保持上一生产版本，不能用 Mac 图代替。

冒烟使用仓库内脱敏 fixture 与专用低分辨率 smoke profile，输出只写 `RUNNER_TEMP`，不得调用产品上传/队列、不得读取 `WB_DATA_DIR` 的客户任务。它仍要经过 render spec、`rectangular_carton_v1` dispatcher、六面绑定、产品/ground/set、GLB verifier 与 generation staging/ready；`finally` 清理临时目录。

初始硬超时设为 90 秒候选值，必须在 P0/P4 用杭州同机实测后冻结。超时、Blender 缺失、版本不符、contract/hash/GLB/generation 任一 hard gate 失败，都保持 drain 并走现有 release recovery。该 smoke 只证明 Windows 运行链可用，不证明真实感、字体清晰度或真实稿 L2/UAT。

### 14.4 L2 / UAT

- L2：杭州真实 Illustrator→结构→切面→Blender→网页合成完整链。
- UAT：刘籽烨从上传、等待、三栏看形、切背景、调灯、原图、下载、印刷面读字走完整流程。
- 至少覆盖白盒、深色盒、细长盒、矮宽盒、膜袋正样本和“袋装花盒”负样本。
- 膜袋薄盒通过不等于真实软袋通过；量表必须显示能力标签。

### 14.5 端到端测试覆盖图

下面不是“测试都已经通过”的宣称，而是 Grok 实施时必须逐条落地的覆盖地图。`[PLAN]` 表示当前只有计划、没有实现证据；每条在相应切片合并前必须变成可重复的自动测试或明确的 L2/UAT 人工证据。`HARD` 失败会阻止 generation ready 或发布，`WARN` 只形成证据，`E2E` 表示必须从用户动作穿过真实前端状态机。

```text
上传/旧单
├─ 新单 ResolvedPackagingJob
│  └─ render_contract.resolve() [PLAN][HARD]
│     ├─ registry schema/version/unknown field/duplicate id [PLAN]
│     ├─ family × substrate × finish × studio capability [PLAN]
│     ├─ finite number/range/default normalization [PLAN]
│     ├─ canonical JSON + stable sha256 [PLAN]
│     └─ dimensions cannot be overridden by template [PLAN]
└─ 旧单 resolved_job.json
   ├─ read-only current root outputs [PLAN]
   ├─ compat-legacy-v0 synthesis [PLAN]
   └─ unsafe/missing family evidence fails closed [PLAN]

render spec
├─ rectangular_carton_v1 dispatcher [PLAN][HARD]
│  ├─ accepted outer dimensions [PLAN]
│  ├─ core/surface/bevel/substrate separation [PLAN]
│  ├─ six artwork sources + paper-only alpha [PLAN]
│  └─ front/right/back/left/top/bottom UV orientation [PLAN]
├─ pouch_thin_card_v1 compatibility dispatcher [PLAN][HARD]
│  └─ 3 mm + thin_card warning; no flexible-pouch claim [PLAN]
└─ unknown/new family [PLAN][HARD]
   └─ render_family_unsupported; never add_box fallback [PLAN]

camera + face sampling
├─ both shots produce per-face Jacobian [PLAN]
├─ max projected ppm across shots [PLAN]
├─ min/max ppm clamp and 32 MP admission [PLAN][HARD]
├─ vector PDF → one affine resample → face PNG [PLAN]
└─ cache fingerprint changes with profile/contract/hash [PLAN]

Blender
├─ product RGBA [PLAN][HARD]
├─ ground pass [PLAN][WARN on isolated failure]
├─ white-set pass [PLAN][WARN on isolated failure]
├─ two full stills + 1440 cards [PLAN][HARD]
├─ blender_result quality identity [PLAN][HARD]
└─ GLB verifier
   ├─ size/core/mesh/finite bounds [EXISTING + EXTEND][HARD]
   └─ six texture source/UV/orientation/mirror [EXISTING + EXTEND][HARD]

generation transaction
├─ import legacy root → staged g0 → ready [PLAN][HARD]
├─ legacy relight creates immutable generation [PLAN][HARD]
├─ upgrade creates immutable generation [PLAN][HARD]
├─ staging failure/timeout leaves current unchanged [PLAN]
├─ ready rename then crash → recovered index, not auto-activate [PLAN]
├─ current pointer + derived files single atomic save [PLAN]
├─ stale/busy/invalid/disk-guard stable errors [PLAN]
├─ activation checks access + public generation id [PLAN]
├─ pagination does not scan ready directories [PLAN]
└─ whole-job deletion is the only history reclamation path [PLAN]

Hono/API
├─ old detail/list/file routes remain compatible [PLAN]
├─ history cursor page and access isolation [PLAN]
├─ relight/upgrade/activate double-click idempotency [PLAN]
├─ two-tab stale activation [PLAN]
└─ file download resolves current full, never card [PLAN]

UI compositor [E2E]
├─ card ok → full ok → source=full [PLAN]
├─ card fail → full ok [PLAN]
├─ card ok → full fail → card + retryable warning [PLAN]
├─ both fail → explicit failed state [PLAN]
├─ resize/unmount cancels stale decode and closes bitmap [PLAN]
├─ generation activation invalidates old preview token [PLAN]
├─ white/silver/set switch does not enqueue Blender [EXISTING + REGRESS]
├─ light controls affect preview and downloaded full identically [PLAN]
├─ original lightbox uses full [PLAN]
└─ read_* remains the small-text truth surface [EXISTING + REGRESS]

quality/release
├─ deterministic runtime hard gates [PLAN]
├─ fixed synthetic regression + baseline identity [PLAN]
├─ --update-baseline explicit only [PLAN]
├─ anonymous Standard/Neutral/AgX P0 comparison [PLAN][HUMAN]
├─ trusted-main Windows Blender smoke in release fence [PLAN][HARD]
│  ├─ success + temp cleanup [PLAN]
│  ├─ missing Blender/version/hash/GLB failure [PLAN]
│  └─ timeout preserves drain and invokes existing recovery [PLAN]
└─ private real-art L2 + 刘籽烨 UAT [PLAN][HUMAN]
```

新逻辑当前共有 **47 个计划覆盖节点**。这是实施待办数量，不是 47 个已发现的线上 bug；任何切片都不能用“主路径跑通”代替其中对应的失败路径。由于本 ADR 不改变 LLM prompt、模型路由或自动决策，本轮不需要 LLM eval；Astra/Grok 视觉意见只作为离线人工观察，不进入自动 gate。

### 14.6 建议测试文件与关键断言

| 层 | 文件 | 必须覆盖的行为 |
|---|---|---|
| Python L0 | 新增 `apps/web/backend/tests/test_packaging_render_contract.py` | registry 严格 schema、重复/未知字段、profile 不可变身份、能力矩阵、默认值、NaN/布尔/越界、canonical hash、旧合同合成、新任务缺 spec 失败 |
| Python L0 | 扩 `test_packaging_structure_artwork.py` | 两个 shot 的 Jacobian、每面最大 projected ppm、一次 affine、source/target ppm、32MP 超限返回所需值与上限、不落低分辨率半成品 |
| Python L0 | 扩 `test_packaging_pipeline_v2.py` | spec 进入 fingerprint/resolved/result；profile 或 registry hash 变化导致 cache miss；旧 profile 保持旧行为 |
| Python 源码合同 | 扩 `test_packaging_structure_artwork.py` 或新 `test_packaging_render_dispatch.py` | `render_job.py` 不再无条件 `add_box`；未知 family 必须抛稳定错误；pouch 仍标 `thin_card` |
| Blender 显式套件 | 新增 `apps/web/backend/tests/test_packaging_render_quality.py` 与 `workers/packaging/tools/render_quality_eval.py` | PNG/Alpha/尺寸/卡图、边缘、线宽、白盒分离、输出 hash、baseline mismatch、显式 baseline update；无 Blender 时给可诊断 skip/fail |
| GLB | 扩 `test_packaging_glb_verify.py` | 新 carton core/surface/倒角不破坏外尺寸；六面来源、UV、方向、镜像继续 hard fail；不支持材质扩展不伪装已导出 |
| Server L0 | 新增 `apps/web/server/src/renderGenerations.test.ts` | g0 导入、staging/ready、atomic pointer、append-only index、orphan recovery、ready 永不自动删除、磁盘 guard、游标分页、路径穿越拒绝 |
| Server L0 | 扩 `jobs.test.ts` | generation mutation 与全局 Blender 槽互斥；失败 current 不变；双击不重复建代；release drain 能看见在途 Blender |
| Server HTTP | 扩 `mockup-http.test.ts` / `mockup-files.test.ts` | 权限隔离、旧详情兼容、history/activate/relight/upgrade、stale 409、invalid 422、当前 full 下载、不暴露磁盘路径 |
| UI 纯函数 | 扩 `mockupStudio.test.ts`，必要时新增 `mockupPreviewSource.test.ts` | card/full 状态转移、generation token、resize 竞态、失败降级、资源释放、full 下载和同参数合成 |
| Browser E2E | 新增 `apps/web/ui/e2e/mockup-generations.spec.ts` | 用户从旧代升级、生成期间仍看旧代、完成后切换、历史切回、两 tab stale、刷新保持、card→full、背景/调灯不新建作业 |
| Windows 合同 | 扩 `windows-release-script.test.ts` + 新 smoke 脚本自测 | smoke 在 drain 内、只写 `RUNNER_TEMP`、90 秒候选超时、失败不打开 drain、调用既有 recovery、finally 清理 |
| 私有 L2/UAT | Git 外证据表 | 白/深/细长/矮宽 carton；膜袋正负能力标签；旧/新盲评、合同 hash、参数、评审人、结论、拒绝理由 |

## 15. 兼容、输出代际与回滚

### 15.1 新任务

- `pipeline_version` 和 fingerprint 包含 render contract/profile 版本；视觉语义变化必须使缓存失效。
- 新任务必须持久化完整 render spec，Blender 不再从散落缺省值猜。
- 输出 key、HTTP 文件路由、job status 和 UI API 不变。

### 15.2 旧已出图单

- 只读打开：继续用磁盘现有产品/ground/set/card/GLB；不回写 spec。
- 下载：继续按现有 full keys。
- “按旧版重渲”：从旧 `resolved_job.json` 生成 `compat-legacy-v0` spec，明确记录 `source=legacy_synthesized`，只复现旧几何、材质、相机和色彩语义，再应用允许调整的棚光参数。
- “升级新版效果”：显式生成当前 `packshot-neutral-v1` 合同和新输出代；不得借用“重渲棚”按钮静默升级。
- 旧 job 没有 family 时只在结构证据符合现有矩形 carton 合同时映射；不能把所有旧 job 默认成真实纸盒。

### 15.3 输出代际合同（D2 已决定）

每单在现有 job 目录下增加隐藏目录；目录名以 `.` 开头，使现有 `collectOutputs()` 默认不会把历史代误当成当前文件：

```text
mockups/<tid>/
├── job.json                         # 唯一 current_generation_id 指针
├── assets/panel_*.png               # 六面事实资产，代际共享但逐代绑定 hash
├── <legacy current outputs>         # 首次导入前继续兼容读取
└── .render-generations/
    ├── index.jsonl                   # append-only 历史事件；游标分页
    ├── g0-legacy-original/
    │   ├── generation.json          # 不可变合同、来源、hash、文件表、质量状态
    │   └── outputs/...
    ├── g1-legacy-relight/...
    └── g2-packshot-neutral-v1/...
```

`job.json` 只增加当前代指针与当前文件派生镜像，不能把永久增长的 generation 列表塞进每次列表页都会加载的 job 文件：

```json
{
  "current_render_generation_id": "g2-packshot-neutral-v1-<hash8>",
  "files": [
    {"key": "white_a", "path": "/canonical/data/mockups/<tid>/.render-generations/g2-.../outputs/...", "name": "..."}
  ]
}
```

`files[].path` 继续沿用当前服务端的 canonical absolute path 约定并通过 `underJobDir()` 校验，便于 generation-aware 代码回滚到旧 `fileOf()` 时仍能只读当前文件；它永不进入公开响应。不要为了 JSON 好看改成相对路径并破坏回滚兼容。

全部历史由 `.render-generations/index.jsonl` 追加索引，每代自己的 `generation.json` 才是该代事实源。索引至少含 `ready`、`activated` 和 `recovered` 事件；Hono 通过游标分页返回，不把全量历史嵌入 `publicMockupSummary()`。

约束：

- generation id 由 mode、合同 hash、创建代次生成；不接受客户端传路径、profile 或文件名。
- `generation.json` 和 ready 目录不可变；再次调灯或升级总是生成新代，禁止原位覆盖 ready 代。
- `assets/panel_*.png` 不复制，但 generation 必须记录六面文件 SHA-256；贴图变化后旧代仍可查看，不能拿旧代继续重渲。
- 公开详情只返回当前 generation 摘要和 `has_render_generations`；分页历史接口返回 generation id、mode、profile、时间、操作者显示所需字段、质量状态和 `current`，绝不返回磁盘路径。
- `/api/mockups/:id/files/:key`、既有 key、下载与 compositor 不变；`fileOf()` 根据 `current_render_generation_id` 解析内部路径。
- 新增显式动作：旧版重渲、升级新版、激活某个 ready 代。Hono 重新校验当前登录者可访问该单；客户端只能提交服务端已公开的 generation id。
- 初次对旧单执行任一变更前，先把当前 root 输出复制到 staging、校验 hash/PNG/GLB 后原子改名为 `g0-legacy-original`；完成前不动当前展示。

建议冻结为三个小接口，避免每个按钮各造一套事务：

```text
GET  /api/mockups/:id/render-generations?cursor=<opaque>&limit=20
POST /api/mockups/:id/render-generations
     { client_request_id, mode: "legacy_relight" | "upgrade",
       source_generation_id, expected_current_generation_id,
       studio_adjustment?: { product_light, background_light } }
POST /api/mockups/:id/render-generations/:generation_id/activate
     { expected_current_generation_id }
```

- `POST render-generations` 只接收动作语义和服务端公开的 source/current ID；profile、路径、输出文件名、合同字段一律由服务端解析，客户端不能指定。
- 尚未 materialize generation 的旧单，详情返回由服务端根据 job id + 当前 root output hashes 计算的虚拟 `legacy-current-<hash8>` ID；第一次 mutation 只能引用这个 ID。g0 导入成功后服务端把它映射成真实 ready generation，客户端不需要也不能猜目录名。
- Hono 通过既有 create 权限和 owner 校验后持久化 mutation request，立即返回 `202` 与 mutation 摘要；不在 HTTP 请求里等待 Blender，也不新建 `/api/jobs`。
- 旧 `/api/mockups/:id/relight` 保留兼容，但内部只转成 `mode=legacy_relight` 的同一请求，不得走旧的原位覆盖实现；返回语义同步为立即排队。旧客户端没有 `client_request_id` 时，服务端按当前虚拟/真实 source + canonical adjustment 复用该单仍在途的 mutation，避免双击重复出图。
- job 本身继续 `status=done`，因此生成期间仍能看 current 产物；详情增加小型 `render_mutation` 摘要（id/mode/status/stage/error），列表只给一行阶段所需字段。
- mutation 请求与 staging manifest 持久化在隐藏 generation 目录；`jobs.ts` 仍是调度和 `job.json` 当前指针的唯一写者，`renderGenerations.ts` 负责验证、文件事务、索引和返回待提交 patch，不能出现两个模块各自 `saveMockup()`。
- 同一 `client_request_id + source_generation_id + mode + canonical adjustment` 幂等；重复 POST 返回原 mutation。`expected_current_generation_id` 不符返回 `render_generation_stale`。
- `activate` 不占 Blender 槽，但与同 job mutation 的最终 pointer commit 共用 job 级互斥；成功返回更新后的公开详情，不接受“latest”或数组下标。
- history cursor 是服务端签发的不透明事件偏移/身份，不允许路径；默认/最大页大小都固定，尾部不完整事件不作为可激活代返回。

### 15.4 生成与切换事务

```text
request relight/upgrade
        │
        ▼
validate access + source generation + persist mutation request; return 202
        │
        ▼
jobs.ts waits for and claims existing Blender slot
        │
        ▼
.render-generations/.staging-<id>
        │ render + required files + hashes + quality hard gates
        ├──────── failure ───────▶ delete/tombstone staging; current unchanged
        │
        ▼
atomic rename staging → ready generation directory
        │
        ▼
single jobs.ts saveMockup(job.json): finish mutation + switch current pointer + derived files
        │
        ▼
public files resolve from the new current generation
```

- 只有最后一次 `saveMockup()` 改变当前展示；生成期间页面继续读旧代。
- `job.files` 作为兼容派生镜像，与 `current_render_generation_id` 在同一次 `replaceFile()` 中更新，不能成为第二事实源。
- 进程在 ready rename 后、索引追加或指针切换前中断，会留下不可见 orphan ready 代；启动恢复按 `generation.json` 校验后追加 `recovered` 事件，绝不自动切换或删除 ready 代。
- 激活历史代只改 `job.json` 的 current pointer 与派生 `job.files`；不复制大文件、不重跑 Blender。
- 同一任务同时只能有一个 generation mutation；仍共用全局单 Blender 槽。切换历史代不占 Blender 槽，但与生成完成的指针提交互斥。

### 15.5 回滚

- 每个实现切片保持现有 output keys，因此可回滚代码而不迁数据库。
- 不自动删除任何 ready 代；旧 `unlinkSameGenerationStills` 只允许清未完成 staging，不能遍历历史 generation。旧 root 输出成功导入 `g0` 并切换指针后，可以清除已校验一致的重复副本，但不能删除 `g0`。
- 新 spec 解析失败时任务失败并保留日志；不得回落到未验证的当前常量路径。
- 已生成的新 GLB 若使用旧代码无法验证，旧代码只读展示既有文件；不得重新盖写。
- 回滚到 generation-aware 之前的代码时，旧 `fileOf()` 依靠 `job.files` 中的 canonical absolute path 仍应能只读/下载当前 hidden generation；它不理解历史分页、激活和 mutation。P1 必须先用真实旧代码提交做只读回滚演练，证明这一点后才能清 root 重复副本并允许 P2 产生新版代；若演练失败就保留 root 副本，不得凭设计推断删除。

## 16. 错误语义与可观测性

新增稳定内部错误建议：

| code | 含义 | 用户/操作员下一步 |
|---|---|---|
| `render_contract_invalid` | spec 畸形或字段冲突 | 重新打样；日志列 problem/cause/fix |
| `render_family_unsupported` | 没有对应 geometry builder | 明确该包装暂不支持，不套方盒 |
| `render_profile_unsupported` | 材质/棚 profile 未登记 | 选择已登记 profile 或新增完整能力 |
| `render_texture_budget_exceeded` | 投影清晰度在像素上限内无法满足 | 降低主输出需求或人工确认新的资源预算 |
| `render_finish_mask_unsupported` | 声明局部工艺但没有可验证 mask | 去掉工艺预览或补语义资产 |
| `render_quality_failed` | hard metric 失败 | 保留证据，不交付该代产物 |
| `render_generation_stale` | 请求引用的源代已变或不存在 | 刷新详情后重新选择 |
| `render_generation_invalid` | generation 清单、hash 或必需文件不完整 | 保留当前代；查看 problem/cause/fix |
| `render_generation_busy` | 同一单已有生成或切换事务 | 等当前动作结束后重试 |
| `render_generation_disk_guard` | 剩余空间低于生成前安全水位 | 删除不再需要的整单或扩容；不自动删历史代 |

日志必须写 `problem + cause + fix`，并带 job id、family、profile、contract hash、Blender version；不记录真实稿正文或密钥。

ground/set 仍是 optional：失败可以让主 job `done`，但 quality report 必须 `warn`、删除坏文件，UI 走既有回退。产品 PNG、GLB、六面绑定和 render spec 属于 hard gate，失败不得伪造完成。

### 16.1 失败模式矩阵

| 环节 | 现实失败 | 如何注入/复现 | 合同处理 | 用户可见结果 |
|---|---|---|---|---|
| registry | JSON 截断、重复 ID、未知顶层字段 | 临时 fixture | 启动/作业 fail closed，不加载半份默认值 | “渲染配置无效，请联系管理员” |
| contract | 模板试图覆盖成盒尺寸、数值为 NaN/布尔 | 单元输入 | `render_contract_invalid`；不调用 Blender | 打样失败，日志有 problem/cause/fix |
| capability | `flexible_pouch_v1` 或未登记 finish | 合成 job | `render_family_unsupported` / `render_profile_unsupported` | 明确暂不支持，不套方盒 |
| legacy mapping | 老单缺足够结构证据 | 老 schema fixture | 可继续只读旧图；禁止新版升级 | 旧图可看，升级动作说明原因 |
| face raster | PDF 页框非法、某面缺 basis | 合成坏 PDF/IR | 删除本次 face staging；不留旧新混合纹理 | 重新打样提示，不生成盒图 |
| pixel budget | 细长盒某面需求超过 32MP | 极端比例 fixture | `render_texture_budget_exceeded`，返回 required/allowed | 不静默变糊，提示资源上限 |
| Blender launch | 可执行缺失、版本/engine 不符 | fake binary / probe stub | 产品 job 明确失败；L1 保持 drain | 缺 Blender 或版本不符的具体原因 |
| Blender render | 进程非零、硬超时、结果 JSON 缺失 | test hook / timeout | staging tombstone/清理，current 不动 | 仍显示上一代；新代失败可重试 |
| optional pass | ground 或 set 单独崩溃/PNG 坏 | pass stub / invalid PNG | 删除坏 pass，quality=`warn`，产品代可 ready | 对应背景隐藏或退已有近似 |
| hard output | 产品 PNG/GLB/card 缺失或 hash 不符 | 删除/篡改 fixture | `render_quality_failed`，禁止 ready | 不展示半成品 |
| GLB | 外尺寸漂移、底面空纹理、UV 镜像 | glTF mutation fixture | verifier hard fail | 不交付错误可旋转模型 |
| generation import | g0 复制中磁盘满/进程退出 | fs hook | root/current 保持原状；staging 可恢复清理 | 旧图不丢，操作失败 |
| generation commit | ready rename 后、index/pointer 前崩溃 | failpoint | 启动校验为 recovered；不自动激活、不删除 | 当前仍是旧代；历史可见恢复代 |
| activation | 两个 tab 同时切代、源代已变化 | HTTP 并发测试 | job 级互斥；旧 revision 返回 409 stale | 刷新后重选，不覆盖别人刚完成的代 |
| disk guard | 永久历史导致安全水位不足 | 可控磁盘统计 hook | 新建代前拒绝；不得删任一 ready 代 | 提示删除整单或扩容 |
| history index | 尾行半写、事件指向缺目录 | 截断 JSONL fixture | 忽略/隔离不完整尾事件，校验 ready manifest；记录告警 | 当前代不受影响；坏历史不可激活 |
| file route | 客户端传路径或他人 generation id | HTTP 负例 | 只接受公开 id + owner 校验 + underJobDir | 404/403，不泄露路径 |
| browser decode | card 415/full 网络失败 | E2E route abort | card→full 回退；full 失败保留 card + 重试告警 | 不出现空白画布或无限等待 |
| browser race | resize/切代后旧 decode 晚到 | 延迟 E2E | generation token 丢弃旧结果，close bitmap | 画面不会跳回旧代/旧尺寸 |
| browser memory | 多次切背景、开原图、下载 | E2E/heap 手工检查 | 释放 bitmap/object URL/export canvas | 长时间使用不持续涨内存 |
| baseline | profile/Blender/fixture 已变却复用旧阈值 | identity mutation | `baseline_mismatch`，不能报 pass | 要求重建并评审基线 |
| release smoke | 成功渲染后清理失败，或 smoke 超时 | PowerShell contract test | 失败保持 transaction fence，走既有 recovery | 上一版继续服务，不宣称升级成功 |
| human quality | 指标过线但纸感/颜色被人拒绝 | 私有盲评 | 自动层保留 pass；`human_acceptance=rejected` 独立 | 不把机器绿灯写成 UAT |

关键原则是：任何新错误要么在更上游通过严格接口消除，要么保留上一份可用产物并给出稳定、可执行的错误；不得“失败后自动换一套参数再试”，否则合同 hash 与视觉因果都会失真。

## 17. 性能与资源预算

### 17.1 不应变化的并发模型

- 杭州仍是一条 Blender 槽；不因渲染重构增加进程并发。
- 背景三键和页面灯光仍在浏览器即时完成，不 enqueue。
- `relight` 仍只消费现有 resolved job 与六面资产，不重跑 Illustrator。
- 历史 generation 放在隐藏目录，不被 `collectOutputs()` 或列表页全盘扫描；历史页通过 append-only 索引游标分页。

### 17.2 预算

- 保留 face `1–64 px/mm` 验证范围和单 face 32MP 上限，除非压测和内存证据支持修改。
- master 初始仍 3000×3600，以减少本轮输出/API 变化；Phase 0 记录实际主体占比和有效 projected ppm 后再决定是否按 profile 调整。
- card 仍最长边 1440，只修 full 自动升级，不先扩大 card。
- 每个额外 pass 都记录耗时；不为“更真实”无限增加样本或新增多个棚图。
- 每代记录总字节数，所有 ready 代永久保留；不做自动逐代清理。创建前根据 P0 实测的单代峰值和生产盘安全水位做保守准入，不足时拒绝新 generation，只有用户删除整单才释放历史代。
- 目标不是固定 4 分钟假 ETA；目标是相对参考基线无不可接受回归，并保留真实 stage/耗时。

### 17.3 内存与浏览器

- card 与 full 切换后立即释放不再使用的 ImageBitmap；避免同时常驻 product/ground/set 的 card 与 full 六张大图。
- full 可按 product→当前 backdrop 所需 pass 的优先级加载；未选 backdrop 不必同时解码全部 full set。
- ResizeObserver 触发去抖/代次取消，避免连续创建大 bitmap。
- 下载才创建 full-size export canvas，结束后释放引用和 object URL。

### 17.4 性能验收表

P0 先测现状，后续每片在相同 fixture、Blender 版本、线程和机器上比较；不能用不同机器的绝对秒数判断回归。

| 指标 | P0 基线 | 计划门 | 采集位置 |
|---|---|---|---|
| contract 解析与 hash | 待测 | p95 不应成为总时长可见占比；目标候选 `<50 ms/job`，以 P0 冻结 | `pipeline_result.json` |
| 六面 raster 峰值 RSS | 待测 | 不超过现有 32MP 预算对应峰值；超限在分配前失败 | Python worker 指标 |
| Blender product pass | 待测 | 每个 profile 与 baseline 比；显著回归需拆出原因 | `blender_result.json` |
| ground / set 各 pass | 待测 | 独立计时；optional pass 不能拖死产品 ready | `blender_result.json` |
| 单 generation 总耗时 | 待测 | 不编造固定 ETA；展示真实 stage，P0 后冻结告警阈值 | Hono job stage |
| 单 generation 总字节 | 待测 | 写 manifest；生成前按峰值乘安全系数做磁盘准入 | `generation.json` |
| history API p95 | 不存在 | 页大小固定，耗时与当前页线性，不随 ready 目录全盘扫描 | Server test/日志 |
| card 可见时间 | 待测 | 不因 full 自动升级退化现有首屏 | E2E trace |
| full 替换时间 | 当前未替换 | 网络完成后一个绘制帧内切换，无闪白 | E2E trace |
| 连续切代/resize JS heap | 待测 | 稳态回落；不得按操作次数单调增长 | Browser 手工/trace |
| Windows L1 smoke | 不存在 | 初始 90 秒硬上限仅为候选，P0/P4 同机冻结 | release log |

如果视觉改进必须靠显著增加 samples 才过，先检查倒角、法线、灯面积、色彩变换和重复缩放；不能把计算量当真实感的替代品。永久保留所有 ready 代是已批准的产品选择，它把容量风险显式转成“生成前准入 + 人工整单删除”，所以磁盘水位、预计新代字节与拒绝原因必须可观测。

## 18. 安全、隐私与供应链

- 生产运行时不调用 OpenAI、Grok、Astra 或任何外部 3D API。
- Astra/Grok 看图前必须使用脱敏合成夹具；真实稿只有取得书面许可才可离开杭州私有证据环境。
- 不下载来源不明的 HDRI、木纹、纸纹或法线贴图。第一版纸张微表面优先程序化且可复现。
- 若以后引入材质资产，必须记录许可、哈希、来源和版本；不得把客户稿当公共 fixture。
- 不读取或提交 `.env`、运行时数据、真实稿、金标输出和 gitignored 杭州 cutover 文档。

## 19. Astra 能借鉴什么、不能借鉴什么

OpenAI 官方把 GPT-6 Astra描述为适合复杂推理、编码、computer use 和专业软件的端到端模型；模型页列出的模态是文字输入/输出与图片输入，没有公开声明“专门 3D 资料库”、原生 CAD/mesh 输出或 Blender 渲染 API。因此本项目可以借鉴它的**工作方式**，不能把它当成确定性 3D 引擎。

可借鉴：

- 长链路保持：同时读结构合同、渲染 spec、Blender 脚本、图片与测试结果。
- 工具闭环：生成脱敏样片 → 运行 Blender → 看 contact sheet → 读指标 → 提出下一次受控修改。
- 结构化观察：按 geometry/material/light/camera/sampling/compositor 分类，不给“更高级一点”的空泛意见。
- 跨样本一致性：同一改动必须看白盒、深色盒和极端比例，不对单张图过拟合。

不能借鉴：

- 让模型凭图猜毫米尺寸或六面映射；
- 让模型直接生成生产 mesh 并跳过 GLB 验证；
- 用模型主观评分替代杭州 L2/UAT；
- 在生产请求里上传真实稿作为自动质检；
- 因为 Astra 比 5.6 更强，就假设它有未公开的 3D 专训或更可靠的物理事实。

可选的离线视觉评审输出必须是建议 JSON，例如：

```json
{
  "schema": "render-visual-critique/1",
  "observations": [
    {
      "category": "lighting",
      "shot": "front_right",
      "region": "top-right silhouette",
      "severity": "medium",
      "evidence": "edge contrast drops relative to the left edge",
      "suggested_experiment": "change rim ratio only; keep material fixed"
    }
  ],
  "unsupported_inferences": [],
  "acceptance_authority": "human"
}
```

官方资料：

- [GPT-6 Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [OpenAI latest-model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [Blender Color Management](https://docs.blender.org/manual/en/4.5/render/color_management.html)
- [Blender Image Texture interpolation](https://docs.blender.org/manual/en/4.2/render/shader_nodes/textures/image.html)
- [Blender Bevel Modifier](https://docs.blender.org/manual/en/4.4/modeling/modifiers/generate/bevel.html)
- [Khronos glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
- [MDN createImageBitmap resizeQuality](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap)
- [HTML Canvas image smoothing](https://html.spec.whatwg.org/multipage/canvas.html)

## 20. 实现切片（工程评审已锁定）

完整目标跨越 8 个以上文件，不能在一个无中间证据的大改里完成。建议按行为轴切片；每片都从当时最新 `origin/main` 建独立 `codex/` 或执行者约定分支，前一片合并后下一片再变基。

### P0：文档与基线

目标：不改产品行为，冻结 current 与评测输入。

- 新增本 ADR、整理 README/TODOS/历史状态。
- 新增脱敏 render-quality fixture 设计和基线采集命令草案。
- 记录当前主线的 full/card 尺寸、采样链、Blender 版本和耗时。
- 输出：baseline JSON/contact sheet；不宣称质量改善。

### P1：render contract 与 generation substrate（无视觉变化）

P1 分成两个可独立评审的结构性切片；两片都完成后才进入 P2 视觉行为变化。

#### P1a：render contract

建议文件：

- 新增 `workers/packaging/render_contract.py`
- 修改 `workers/packaging/pipeline.py`
- 新增唯一 `workers/packaging/profiles/render-profiles.v1.json`，结构模板只迁移为 profile ID + output request
- 新增 `apps/web/backend/tests/test_packaging_render_contract.py`
- 补 `test_packaging_structure_artwork.py` / `test_packaging_dieline.py`

任务：

- 规范化 family；生成/验证/hash spec。
- 严格加载唯一 profile registry；未知字段/ID/family 组合失败关闭。
- 先让 compatibility profile 精确复现现有参数。
- 把 spec 放入 fingerprint、resolved job 与 result。
- 新任务缺 spec fail；旧重渲合成 legacy spec。
- L0 先红后绿。

#### P1b：输出代际事务

建议文件：

- 新增 `apps/web/server/src/renderGenerations.ts`
- 修改 `apps/web/server/src/mockup.ts`、`jobs.ts`、`index.ts`
- 修改 `workers/packaging/pipeline.py`，让 blender-only 输出到 staging 代
- 修改 `apps/web/ui/src/api.ts`、`MockupPage.tsx`
- 新增服务端行为测试、崩溃恢复测试与最小 UI 测试

任务：

- 旧 root 输出安全导入 `g0-legacy-original`；失败时 current 不变。
- hidden staging → 完整性/hash/质量验证 → atomic ready rename。
- `job.json` 单一 current pointer；`job.files` 同次写入的兼容派生镜像；历史写 append-only `index.jsonl` 并走游标分页。
- 旧版重渲、新版升级、激活历史代三个显式 Hono 用例；不增加端口或 Python HTTP。
- 启动恢复 orphan generation；历史目录不进入 `collectOutputs()`；ready orphan 只恢复索引，不自动激活或删除。
- 所有 ready 代永久保留；新增磁盘安全水位准入与整单删除释放测试，不做自动逐代 GC。
- 只用小型合成 fixture 验证多代，不对生产旧单批量迁移。

### P2：矩形 carton 几何、材质、棚光

建议文件：

- `workers/packaging/blender/render_job.py`
- `workers/packaging/camera_frame.py`
- `workers/packaging/glb_verify.py`
- `workers/packaging/render_contract.py`
- 相应 Python tests / 脱敏 fixtures

任务：

- family dispatcher；`rectangular_carton_v1` 与 `pouch_thin_card_v1`。
- 纸板/印刷/整体 finish 分层；未知白卡兼容。
- 尺寸归一三灯棚和候选 view transform。
- 保持外尺寸、六面、GLB、output keys。
- 运行显式 Blender A/B；只接受达到冻结门的 profile。

### P3：投影采样与浏览器 full 升级

建议文件：

- `workers/packaging/render_contract.py`
- `workers/packaging/structure_v2/artwork.py`
- `workers/packaging/pipeline.py`
- `apps/web/ui/src/pages/MockupPage.tsx`
- `apps/web/ui/src/pages/mockupStudio.ts`
- 对应 Python/UI tests 与 E2E

任务：

- per-face projected ppm；上限错误。
- preview 两阶段状态机、generation token、资源释放。
- full 自动替换；一次高质量 DPR 缩放。
- 下载/full/read_* 不变。

### P4：质量工具与杭州门

建议文件：

- 新增 `workers/packaging/tools/render_quality_eval.py`
- 新增脱敏 fixtures / threshold manifest
- 相关 test
- 最小修改 `scripts/windows/release.ps1`，新增独立 Blender smoke 脚本、fixture 与 PowerShell 合同测试
- README/TODOS/CHANGELOG

任务：

- contact sheet、JSON metrics、基线 diff。
- 手工 baseline update。
- 每次可信 `main` 在 transaction fence 内运行脱敏 Blender smoke；失败触发现有 recovery。
- 私有 L2 表与 UAT，不提交真稿。

### P5：新 family（独立立项）

只有 `rectangular_carton_v1` 的 L2/UAT 通过后，才从真实业务失败样本选下一个 family。真实软袋、天地盖、抽屉盒、圆筒不能一起打包；每个 family 按第 9.5 节完整交付。`pouch_thin_card_v1` 只保留兼容能力和薄盒标签，不因纸盒画面改善而继承真实软袋宣称。

### 20.6 依赖图与 worktree 并行计划

```text
P0 baseline/fixtures
        │
        ▼
P1a render contract + registry ─────────────┐
        │                                    │
        ├──────────────┐                     │
        ▼              ▼                     ▼
P1b generation     P2 carton core       P3b UI preview shell
        │              │                     │
        │              └──────────┐          │
        │                         ▼          │
        └────────────────────▶ P3a projection/sampling
                                  │          │
                                  └────┬─────┘
                                       ▼
                             P4 quality + Windows smoke
                                       │
                                       ▼
                                L2 / UAT evidence
```

并行不是让多个执行者同时改同一批深模块。建议最多四条 lane：

| lane | 可开始条件 | 负责范围 | 明确不碰 | 合流条件 |
|---|---|---|---|---|
| A — contract/core | P0 完成 | `render_contract.py`、registry、pipeline 接入，随后 carton Blender core | Hono/UI/generation 存储 | P1a L0 全绿并冻结 schema 后，才允许 B/C 依赖 |
| B — generations | P1a schema/hash 冻结 | `renderGenerations.ts`、mockup/jobs/routes、事务与恢复 | Blender 视觉参数、UI canvas | server 行为/HTTP/崩溃恢复全绿；可读旧单 |
| C — UI clarity | output key 与 generation API 冻结 | card→full 状态机、资源释放、history UI、E2E | Python raster/Blender builder | 纯函数 + E2E 全绿；下载仍用 full |
| D — quality/release | P2 输出和 quality schema 冻结 | eval 工具、fixtures、baseline、Windows smoke 合同 | 产品队列、生产数据、Illustrator 控制面 | 显式 Blender suite 有证据；PowerShell 合同测试全绿 |

分支/worktree 纪律：

1. 当前 `codex/docs-3d-render-contract` 只承载 ADR 与文档，不混实现。
2. 每片开始前 `git fetch origin`，从当时最新 `origin/main` 建 `codex/3d-p0-baseline`、`codex/3d-p1a-render-contract` 等独立 worktree；不要从本地脏分支继承。
3. P1a 的 schema/hash 是 B/C/D 的接口闸门。未冻结前只能写 fixture 与失败测试，不能各自发明字段。
4. A 与 P3a 都会碰 `render_contract.py` / `pipeline.py`，必须串行；B 与 C 只在 API 类型文件交界，由 B 先冻结响应 schema，C 后消费。
5. P2 与 P3b 可以并行，前提是 output keys 和质量 schema 不变；P3a 只能在 P2 相机/shot 合同冻结后完成最终 Jacobian。
6. 每个 worktree 只改本 lane 的文件；跨 lane 新事实先回写 ADR 或接口 fixture，不能用 cherry-pick 冲突临场定架构。
7. 合流顺序固定为 P0 → P1a → P1b → P2/P3b → P3a → P4；每次合流后下一片从新的 `origin/main` 变基。commit、push、PR、merge、ship、deploy 仍分别等待用户授权。

### 20.7 Grok 可执行任务包

| ID | 优先级 / 估算 | 依赖 | 实施与主要文件 | 完成定义 |
|---|---|---|---|---|
| RF-00 | P0 / M | 无 | 脱敏 fixture 规范、基线采集脚本骨架、当前参数/尺寸/耗时清单 | 同机可重复产出 current JSON/contact sheet；无产品行为变化；记录 fixture/Blender/hash |
| RF-01 | P1 / L | RF-00 | 新 `render_contract.py`、`render-profiles.v1.json`、合同测试 | 严格 registry、能力矩阵、canonical hash、稳定错误全覆盖；compat profile 对现状零视觉变化 |
| RF-02 | P1 / M | RF-01 | `pipeline.py` / resolved/result/fingerprint 接线 | 新任务强制 spec；旧重渲可合成 compat；profile/hash 变化 cache miss；既有 output keys/status 不变 |
| RF-03 | P1 / XL | RF-01, RF-02 | 新 `renderGenerations.ts`、`mockup.ts`、`jobs.ts`、routes/tests | g0 导入、staging→ready、原子 current、索引分页、orphan 恢复、stale/busy/invalid 全测；失败不丢当前图 |
| RF-04 | P1 / M | RF-03 | UI/API generation history、旧版重渲/升级/激活动作 | 权限与双击/双 tab 语义一致；生成中继续看旧代；历史切回不重跑 Blender |
| RF-05 | P2 / XL | RF-02 | `render_job.py` family dispatcher、carton geometry、GLB 扩展测试 | 不再无条件 add_box；carton 有可量纸厚/倒角/纸边；pouch 仍 3mm thin-card；六面/外尺寸 hard gate 全绿 |
| RF-06 | P2 / L | RF-01, RF-05 | substrate/ink/overall finish、微法线、可导出子集 | 无 mask 不伪造 spot finish；Non-Color/sRGB 正确；静帧与 GLB 能力差异有报告与文案 |
| RF-07 | P2 / L | RF-00, RF-05, RF-06 | 尺寸归一三灯棚、受控 view-transform A/B | 几何/纹理/灯/曝光固定；匿名输出；按预登记规则冻结新 profile，否则保留 Standard |
| RF-08 | P3 / L | RF-02, RF-05 | per-face projection/Jacobian、`artwork.py` 像素预算 | 两 shot 最大需求；一次 affine；required/allowed 可诊断；32MP 超限 fail 而不是静默降采样 |
| RF-09 | P3 / L | RF-03 API 冻结 | `MockupPage.tsx` / `mockupStudio.ts` card→full、释放与 E2E | full 自动原位替换；失败回退、resize/切代竞态、unmount 释放、原图/full 下载都有测试 |
| RF-10 | P4 / XL | RF-05–RF-09 | quality eval、阈值/identity、contact sheet | runtime/fixture/human 三层分开；baseline mismatch 失败；更新基线必须显式；输出不含真稿 |
| RF-11 | P4 / L | RF-03, RF-05, RF-10 | 独立 Windows Blender smoke wrapper、复用 `renderGenerations.ts` 的 tsx 入口、`release.ps1`、合同测试 | 每次可信 main 在 fence 内跑；只用 `RUNNER_TEMP`；缺失/超时/hash/GLB 失败保持 drain 并走 recovery；PowerShell 不复制 generation 校验 |
| RF-12 | P4 / M | RF-00–RF-11 | 全量 L0/type/quality/E2E、回滚演练、文档/CHANGELOG | Mac/GitHub 证据完整；旧单/g0/current 回滚路径证明；没有把未跑 L1/L2 写成完成 |
| RF-13 | L2/UAT / 人工 | RF-12 landed + L1 green | 杭州私有真实稿与刘籽烨流程 | 旧/新盲评、合同 hash、操作者与结论齐全；真实 carton 才能宣称通过；证据不进 Git |

估算只表示相对大小：M 为一个聚焦切片，L 为跨 2–4 个深模块，XL 必须再拆成“失败测试/最小实现/集成证据”三个内部 checkpoint；不是工期承诺。每个任务必须先展示红测，再展示绿测；不能用新增 snapshot 覆盖旧失败。

### 20.8 每片统一验收命令

按改动范围先跑最小集，再跑仓库门；命令不存在或依赖缺失时明确记录，不得把“未运行”写成通过。

```bash
# Python 聚焦例子
cd apps/web/backend
.venv/bin/python -m pytest -q \
  tests/test_packaging_render_contract.py \
  tests/test_packaging_structure_artwork.py \
  tests/test_packaging_glb_verify.py

# Server / UI 聚焦例子
npm run test -w beian-server
npm run test -w beian-ui
npm run test:e2e

# 完整 Mac L0 与静态门
npm test
npm run typecheck
npm run test:quality
npm run quality

# 有受支持 Blender 时显式执行，不并入默认 npm test
apps/web/backend/.venv/bin/python workers/packaging/tools/render_quality_eval.py \
  --blender /Applications/Blender.app/Contents/MacOS/Blender \
  --fixtures workers/packaging/fixtures/render-quality \
  --output /tmp/beian-render-quality
```

Grok 不能在杭州生产机跑默认单测，也不能以 Mac Blender 套件替代可信 `main` 的 Windows L1。质量工具的真实最终 CLI 由 RF-10 固化；若与上面草案不同，需同步本 ADR、README 与测试。

## 21. 预计影响文件与复杂度

完整计划预计至少涉及：

1. `workers/packaging/render_contract.py`（新）
2. `workers/packaging/pipeline.py`
3. `workers/packaging/structure_v2/artwork.py`
4. `workers/packaging/blender/render_job.py`
5. `workers/packaging/camera_frame.py`
6. `workers/packaging/glb_verify.py`
7. 默认 render template/profile
   - 具体为唯一 `workers/packaging/profiles/render-profiles.v1.json`，现有结构模板只保留引用
8. `apps/web/backend/tests/test_packaging_render_contract.py`（新）
9. `test_packaging_structure_artwork.py`
10. `test_packaging_dieline.py`
11. `test_packaging_thumbnail.py`
12. `apps/web/ui/src/pages/MockupPage.tsx`
13. `apps/web/ui/src/pages/mockupStudio.ts`
14. UI tests / E2E
15. `workers/packaging/tools/render_quality_eval.py`（新）
16. Windows Blender smoke、`release.ps1` 与合同测试
17. `apps/web/server/src/renderGenerations.ts`（新）
18. `apps/web/server/src/mockup.ts` / `jobs.ts` / `index.ts`
19. generation 服务端测试与恢复测试
20. 文档与 changelog

这已触发 `/plan-eng-review` 的复杂度闸门。用户已选择完整目标按 P0–P4 分阶段交付；不得退回“单分支/单 PR 全做”，也不得把某片代码完成写成全链路完成。

## 22. Grok 执行合同

Grok 开工时先复制以下总提示，再按已批准切片一次只执行一片：

```text
你在 /Users/hutou/Desktop/beian 工作。先完整阅读 AGENTS.md、
docs/adr-005-packaging-structure-v2.md、
docs/adr-007-packaging-render-fidelity.md、DESIGN.md、TODOS.md。

目标：在现有 workers/packaging 流水线内部实现当前被批准的切片。
不得新建 HTTP 服务、Python API、端口、队列或第二套 3D 流水线；不得改写
PackagingStructure V2 的结构事实；不得按颜色、文件名、任务 ID 猜结构或材质；
不得提交真实稿、密钥、运行时数据或 gitignored 文件。

分支：先 fetch origin，从最新 origin/main 创建独立分支。不要 commit、push、开 PR、
merge、ship 或 deploy，除非用户在当次任务明确授权。不要 git add -A。

实施顺序：
1. 用 CodeGraph 追踪当前调用链和 blast radius。
2. 先写会失败的行为测试，覆盖成功、错误、旧单兼容和资源上限。
3. 只实现 ADR 当前切片，不顺手扩 family。
4. 保持 Hono/job status/output keys/GLB 六面合同。
5. 跑该切片列出的最小测试，再跑完整 L0、typecheck、quality；有 Blender 才跑显式质量命令。
6. 报告：分支、变更文件、测试命令与结果、未跑原因、L1/L2/UAT 剩余项。

任何图片“更好看”的结论必须同时给旧/新 A/B、合同 hash、渲染参数和人工结论。
机器指标通过不能写成杭州或籽烨已验收。
```

每片执行结束，Grok 必须交付：

- 变更摘要按用户结果写，不按文件堆砌；
- 精确文件清单；
- 测试证据与失败输出；
- 旧/新数据合同样例；
- 性能与输出体积对比；
- 脱敏 A/B contact sheet；
- 尚未执行的 L1/L2/UAT；
- 是否碰到与 ADR 冲突的新事实。冲突时停下，不自行改 ADR。

## Implementation Tasks

以下任务由本次工程评审问题直接合成；编号与 JSONL 评审产物一致。复选框只能在对应 Verify 实际执行并保留证据后勾选。

- [ ] **T1（P1，human: ~6h / Grok: ~45min）— baseline — 建立可复现的现状渲染基线**
  - Surfaced by: Test Review — 视觉改变缺少固定脱敏基线和完整身份链。
  - Files: `workers/packaging/fixtures/render-quality/`、`workers/packaging/tools/render_quality_eval.py`、`apps/web/backend/tests/test_packaging_render_quality.py`
  - Verify: 同机重复两次得到相同 fixture/profile/Blender/hash 身份；输出 current JSON/contact sheet，无产品行为改变。
- [ ] **T2（P1，human: ~1.5d / Grok: ~3h）— render contract — 实现严格版本化合同与 profile registry**
  - Surfaced by: Architecture D6 — 散落默认值无法复现、校验或安全失效缓存。
  - Files: `workers/packaging/render_contract.py`、`workers/packaging/profiles/render-profiles.v1.json`、`apps/web/backend/tests/test_packaging_render_contract.py`
  - Verify: registry/schema/能力矩阵/数值/canonical hash 的成功与失败测试全绿，compat profile 与现状零视觉差异。
- [ ] **T3（P1，human: ~1d / Grok: ~2h）— pipeline — 接入 resolved job、fingerprint 与结果**
  - Surfaced by: Architecture — Blender 必须只消费 resolved spec，不能继续从模板和常量猜。
  - Files: `workers/packaging/pipeline.py`、`workers/packaging/render_contract.py`、`apps/web/backend/tests/test_packaging_pipeline_v2.py`
  - Verify: 新单缺 spec fail；旧重渲可合成 compat；profile/hash 改变产生 cache miss；output keys/status 不变。
- [ ] **T4（P1，human: ~3d / Grok: ~6h）— generations — 实现不可变代际和原子切换**
  - Surfaced by: Architecture D2/D3 — 当前 relight 原位覆盖，无法保留原图、稳定回滚或解释视觉因果。
  - Files: `apps/web/server/src/renderGenerations.ts`、`mockup.ts`、`jobs.ts`、`renderGenerations.test.ts`
  - Verify: g0 导入、staging→ready、current 原子提交、orphan 恢复、永久保留、磁盘 guard 及 failpoint 全绿。
- [ ] **T5（P1，human: ~1.5d / Grok: ~3h）— Hono API — 收敛历史、创建与激活用例**
  - Surfaced by: Code Quality — 每个按钮单独实现会复制权限、幂等、互斥和事务知识。
  - Files: `apps/web/server/src/index.ts`、`mockup-http.test.ts`、`mockup-files.test.ts`、`apps/web/ui/src/api.ts`
  - Verify: 202 立即排队、owner 权限、幂等、stale 409、invalid 422、分页和不暴露路径测试全绿。
- [ ] **T6（P1，human: ~3d / Grok: ~6h）— renderer — 完成 rectangular_carton_v1 几何内核**
  - Surfaced by: Architecture D5 — 无条件 `add_box` 导致虚假的通解和缺少纸盒物理线索。
  - Files: `workers/packaging/blender/render_job.py`、`camera_frame.py`、`glb_verify.py`、`test_packaging_glb_verify.py`
  - Verify: family dispatcher/未知 family fail；纸厚、纸边、倒角可量；pouch 仍 thin-card；六面与外尺寸 hard gate 全绿。
- [ ] **T7（P1，human: ~2d / Grok: ~4h）— materials — 分离纸基、油墨与整体涂层**
  - Surfaced by: Root Cause — 单一均匀材质让白边消失，也让纸面像塑料。
  - Files: `render_job.py`、`render_contract.py`、profile registry、render quality tests
  - Verify: sRGB/Non-Color 正确；无 mask 不伪造 spot finish；静帧/GLB 能力差异进入报告。
- [ ] **T8（P1，human: ~1.5d / Grok: ~3h）— studio/color — 建立尺寸归一棚光并完成盲化对照**
  - Surfaced by: Architecture D8 — view transform 必须由预登记证据选择，不能凭模型偏好。
  - Files: `render_job.py`、`camera_frame.py`、`render_quality_eval.py`、profile registry
  - Verify: 只替换 transform 的匿名 A/B/C，按冻结规则选择；没有全通过者就保留 Standard。
- [ ] **T9（P1，human: ~2d / Grok: ~4h）— sampling — 按投影反推切面像素**
  - Surfaced by: Root Cause — 固定 20 px/mm 不知道最终画面投影，可能在源端就已不可逆欠采样。
  - Files: `render_contract.py`、`structure_v2/artwork.py`、`pipeline.py`、`test_packaging_structure_artwork.py`
  - Verify: 两 shot 最大 Jacobian、一次 affine、ppm 报告、32MP 边界及 required/allowed 错误测试全绿。
- [ ] **T10（P1，human: ~2d / Grok: ~4h）— UI clarity — 让 card 原位升级 full 并释放资源**
  - Surfaced by: Test/Performance — 当前 full 只预取不替换，且 resize/切代存在旧 decode 与内存风险。
  - Files: `MockupPage.tsx`、`mockupStudio.ts`、`mockupStudio.test.ts`、`e2e/mockup-generations.spec.ts`
  - Verify: 成功/双失败/单失败/resize/切代/unmount 路径全测；原图与下载只用 full。
- [ ] **T11（P1，human: ~3d / Grok: ~6h）— quality — 实现三层质量门与 baseline identity**
  - Surfaced by: Architecture D7 — 确定性完整性、合成回归和人工审美不能混成一个总分。
  - Files: `render_quality_eval.py`、脱敏 fixtures、`test_packaging_render_quality.py`
  - Verify: runtime hard、fixture hard、human warning 分字段；mismatch fail；baseline 只能显式更新；contact sheet 可追溯。
- [ ] **T12（P1，human: ~2d / Grok: ~4h）— release — 接入 Windows Blender 发布冒烟**
  - Surfaced by: Architecture D4 — 可信 main 发布必须证明本机 Blender 合同链可运行且不碰客户数据。
  - Files: `scripts/windows/release.ps1`、新 PowerShell wrapper + tsx smoke 入口、`renderGenerations.ts`、`windows-release-script.test.ts`、`hangzhou-release.yml`
  - Verify: fence 内、`RUNNER_TEMP`、成功清理；tsx 入口复用生产 generation validator；缺失/超时/hash/GLB 失败保持 drain 并调用既有 recovery。
- [ ] **T13（P2，human: ~1.5d / Grok: ~3h）— regression — 跑全量门并演练回滚**
  - Surfaced by: Test Review — 47 个计划节点需要转成真实证据，不能以主路径 smoke 代替。
  - Files: Python/server/UI/E2E tests、`README.md`、`CHANGELOG.md`
  - Verify: `npm test`、`npm run typecheck`、`npm run test:quality`、`npm run quality`、相关 E2E 和显式 Blender suite；记录性能/体积差异。
- [ ] **T14（P3，human: ~1d + 人工评审 / Grok: ~2h support）— acceptance — 执行 L1/L2/UAT**
  - Surfaced by: Scope D1 — 代码与合成绿灯不能闭合杭州生产和业务验收。
  - Files: Git 外私有证据；只在 `TODOS.md` / `CHANGELOG.md` 写脱敏状态。
  - Verify: trusted-main L1、真实 carton 旧/新盲评、合同 hash、评审人和刘籽烨完整流程；真稿/输出不进 Git。

## 23. NOT in scope

- 用生成式模型替代确定性结构、mesh、UV 或 GLB 验证。
- 任意包装“一键通用”、自动猜瓶罐/软袋/异形盒。
- 完整折叠动画、开盒动画、爆炸图或物理仿真。
- 真实软袋、插底袋、侧褶袋、透明窗口、局部 UV、烫金/烫银。
- HDRI 下载、云渲染、第三方材质市场、外部 3D SaaS。
- 新端口、新 HTTP 服务、数据库迁移、通用队列重写。
- 改审稿引擎、OCR 结论、签字逻辑、飞书权限或上传协议。
- 用 3D 静帧代替 `read_*` 印刷面核字。
- 在本计划分支 commit/push/PR/deploy；这些仍需用户单独授权。

## 24. 风险与救援

| 风险 | 早期信号 | 救援 |
|---|---|---|
| 对单张白盒过拟合 | 深色盒变黑、其他比例失光 | 同时跑白/深/长/扁矩阵；profile 不读 SKU |
| 视觉更真但印刷偏色 | A/B 好看、色卡误差增大 | 候选 transform 分离评测；色准是 hard constraint |
| 提高纹理导致 OOM | face 接近 32MP、并发峰值高 | 投影预算前置；超过上限 fail，不静默降采样 |
| 更高 samples 超 SLA | Blender 时间显著增加 | 逐项 benchmark；先修几何/材质/重复缩放 |
| 新几何破坏 GLB | 外尺寸/六面/Alpha 失败 | 保留现有 verifier，先测试后改 builder |
| UI full 升级内存泄漏 | 多次 resize 后 bitmap 累积 | generation token + close/revoke + heap/e2e 检查 |
| 旧重渲混代 | 老 job 没 spec 却使用新默认 | 旧版和升级分动作；每次生成不可变代；current 原子切换 |
| generation 半写入 | 崩溃后出现目录但 job 指针未变 | hidden staging、ready 原子改名、启动恢复 orphan；当前代不动 |
| 历史代撑满磁盘 | 单任务反复调灯生成大量 full/set/GLB | 全量保留但生成前做磁盘水位准入；不足则拒绝新代；只由用户删除整单释放 |
| 模型评审越权 | Astra/Grok 说 pass 就宣称验收 | JSON 只写 observation；human_acceptance 独立 |
| 范围变成 3D 平台重写 | 新服务/插件系统/十几个类 | 坚持一个 render_contract 深模块 + 现有脚本分派 |

## 25. 工程评审决定

- D1（已决定，2026-09-04）：选择完整目标按 P0–P4 分阶段交付。当前文档分支先冻结合同与验收标准；后续实现按行为轴拆分，禁止把结构性重构和全部视觉变化塞进一个大 PR。
- D2（已决定，2026-09-04）：同时保留“按旧版重渲”和“升级新版效果”，每次生成独立不可变代；用户可切换 ready 历史代，当前代通过 `job.json` 单一原子指针发布。
- D3（已决定，2026-09-04）：所有 ready generation 永久保留，不自动逐代清理；`g0` 和当前代都不可被后台删除。生成前做磁盘安全水位准入，空间不足时拒绝新代；只有用户删除整单才释放。
- D4（已决定，2026-09-04）：每次可信 `main` 发布都在 transaction fence 内阻塞执行脱敏小型 Blender 合同冒烟；只写临时目录，硬超时，失败沿现有 release recovery 回滚；不冒充 L2/UAT。
- D5（已决定，2026-09-04）：P1–P4 只交付 `rectangular_carton_v1` 的真实感升级；`pouch_thin_card_v1` 保持兼容与诚实标签。矩形 carton 通过 L2/UAT 后，P5 才按真实失败样本一次新增一个 family。
- D6（已决定，2026-09-04）：唯一事实源为严格版本化 `render-profiles.v1.json`；`render_contract.py` 独占加载、校验、规范化和 hash。模板只引用 ID；Blender/smoke/eval 只消费 resolved spec。已发布 profile ID 不得原位改变视觉语义。
- D7（已决定，2026-09-04）：采用三层质量门。真实 generation 只 hard fail 确定性完整性；脱敏固定夹具 hard fail 可重复像素回归；纸感、棚光、真实稿文字与色彩只 warning + human，机器 pass 不得冒充业务验收。
- D8（已决定，2026-09-04）：先冻结受控对照与盲评规则，再由 P0 证据选择 `Standard`、`Khronos PBR Neutral` 或 `AgX`。没有候选同时过色准、细节、白盒分离和人工拒绝门时保留 Standard；发布后任何变化必须新建 profile ID。

这些决定已经由 `/plan-eng-review` 逐项提出并由用户回答；Grok 只能执行，不得重新默认或替换。后续若代码事实与决定冲突，必须停下并回报。

## 26. 工程评审收束

### 26.1 Completion Summary

- Step 0: Scope Challenge — 完整目标按 P0–P4 分阶段接受；不做单分支大改。
- Architecture Review: 6 个问题已通过 D2、D4–D8 决定并折入计划（代际、生产烟测、family 边界、profile SSOT、质量权限、色彩选择）。
- Code Quality Review: 1 个问题已折入计划（散落默认/同步原位重渲收敛到两个深模块和三个 Hono 用例）。
- Test Review: 已绘制端到端图，47 个待实现覆盖节点均映射到具体测试文件与断言。
- Performance Review: 2 个问题已折入计划（永久代际磁盘增长、浏览器 full/card bitmap 生命周期）。
- NOT in scope: 已写，禁止第二条 3D 流水线、生成式 mesh、虚假 family 通解和外部真稿视觉 API。
- What already exists: 已写；保留结构 V2、PyMuPDF 切面、六面 GLB verifier、现有 Hono/队列/output keys/compositor。
- TODOS.md updates: 0 个额外提案；本轮已把当前未完成项整理为 P1/P2/P3，P5 新 family 在 carton L2/UAT 前仅保留触发条件，不提前进入活跃待办。
- Failure modes: 23 类失败均定义注入方式与保底语义；计划层未留下未覆盖的 critical gap。
- Outside voice: 当前宿主就是 Codex，按 skill 规则跳过嵌套 Codex；完成一次本机反方检查，无新增未决分歧。
- Parallelization: 4 条 lane；P1a 冻结后最多 3 条可并行，6 个合流闸门保持串行。
- Lake Score: 8/8 个交互决定均已选择完整、可执行选项；0 个未决决定。

### 26.2 本机反方检查

1. **是否过度建设 generation 系统**：这是 D2/D3 明确选择带来的必要复杂度；计划用 P1b 无视觉变化切片、单 current 指针、隐藏索引和三个用例约束范围，不扩成数据库或通用队列。
2. **永久历史是否把稳定性换成磁盘事故**：风险真实存在；已按用户选择禁止自动 GC，并把风险转成生成前安全水位、每代字节可观测和整单删除。不能再假设“以后清理”。
3. **每次发布 smoke 是否能证明画质**：不能。它只证明 Windows 上 spec→Blender→PNG/GLB/generation 的合同链；真实感、文字、颜色仍分别由合成质量套件、私有 L2 和刘籽烨 UAT 决定。
4. **是否仍可能只给白盒打补丁**：profile 不读取 SKU/平均颜色，矩阵强制白、深、细长、矮宽同测；几何、材质、灯、色彩、采样分层实验，避免单图参数耦合。

没有独立第二模型输出，因此不能声称“跨模型一致”；本机反方检查未提出需要改变 D1–D8 的新事实。

### 26.3 历史回看

从 `0.21.18.0` 到 `0.21.25.0`，仓库连续在产品/背景灯、地面、白桌白墙、首屏卡、白盒纸面和重渲棚上增量施工；更早 `0.21.5.0`、`0.21.9.0` 又分别处理清晰度与结构选层。这说明现有能力不是空白，但同一症状已经跨多次发布反复触达。ADR-007 因而把下一轮起点放在合同、基线和代际，而不是继续给某一盏灯、某个白盒或某个尺寸加常量。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | SKIPPED (under Codex) | 本机反方检查完成；没有独立第二模型输出 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 56 个发现/计划覆盖缺口均已折入；0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | UI generation/history 与渐进清晰度仍可独立做设计评审 |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT:** ENG CLEARED — ready to implement；这只代表计划可执行，不代表代码、L1、L2 或 UAT 已完成。

NO UNRESOLVED DECISIONS
