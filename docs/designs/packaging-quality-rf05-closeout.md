# RF-05 本地交付记录

日期：2026-09-06。状态：**独立 RF-05 候选，当前验证在下方另列**。范围：同一 packaging Blender 流水线中的 family 分派、矩形纸盒几何与 GLB 合同。分支 `codex/rf05-carton-geometry-ship` 基于 RF-04，版本 `0.21.38.0`。提交和 PR 不代表合并或部署，生产注册和网页 upgrade 仍关闭。

下述原开发阶段的本机 Blender、checkpoint 及耗时为历史记录，本次 `/ship` 不将其算作当前分支重新验收。

## 实现与兼容边界

- 新增显式 `packshot-carton-geometry-v1`，只支持 `rectangular_carton_v1`。沿用 `packshot-neutral-v1` 的材质、灯光、颜色、采样和输出设置，不改变 F、任何现有 profile、模板默认选择或 approved baseline。RF-06 材质和 RF-07 棚光不在本轮范围。
- 新 profile SHA：`74a17949ac80cd1f3fa34640dcaf246a8a656dc78989e0b08589cb2306860aca`。当前 registry 追加 profile；追加前字节作为 `history/pre-rf05.v1.json` 固定，SHA `1f490d26590ddcb5a100fa3087d9d36649b7a98e4722cf521f6f342da718ad07`。四个旧 profile 的规范化内容及旧合同 hash 均保持，pre-f / pre-rf05 合同可校验重放。
- Blender 主入口在建目录/清场前验证 spec、顶层身份、结构 hash、family 与尺寸，然后白名单分派。未知 family、V2 缺 spec、厚度篡改、family/尺寸/身份漂移均失败；非 V2 命令行诊断兼容路径保留，不成为网页回退。
- `pouch_thin_card_v1` 仍为 3 mm 薄盒；结果明确 `preview_fidelity=thin_card`。不增加鼓包、热封边或软袋形变，也不宣称真实膜袋能力。

## 几何选择

比较了六块独立倒角厚板与单个闭合纸板壳：前者会在六面交界制造没有结构依据的拼缝/叠层，选用后者。纯 Python `render_geometry.py` 负责有界坐标、拓扑及验证，现有 Blender 脚本负责创建 mesh；没有第二条流水线或插件系统。

`closed-carton-shell-v1` 包含一个不透明 Core（外边界 + 反向内边界）及六个弯曲印刷面。accepted dimensions 始终是最终印刷外包络；Core 和内壁向内偏置，不把纸厚加到外框。未提供可靠 closure hint 时不画拼缝/折痕，不按图片线条猜结构。

- 白卡声明厚度 0.4 mm、Core 倒角 0.6 mm、印刷间隙 0.002 mm、倒角细分 4；参数进入 profile/spec/hash。
- 厚度最多为最短尺寸的 8%，间隙最多为有效厚度的 5%，外倒角最多为最短尺寸的 20%；Core 倒角下限按厚度推导，确保内壁不塌陷。普通尺寸下有效外倒角为 0.602 mm、Core 倒角 0.600 mm。
- 六面完整 UV `[0,1]²` 沿现有方向映射到圆角外表面，不裁 artwork、不刷白边、不把 Alpha 改为半透明；Alpha 缺印刷区由声明色的不透明纸板承接。
- 默认模型为 972 个印刷三角形 + 1,944 个 Core 三角形；索引仍在既有 GLB 有界读取预算内。外壳/内腔方向相反，纸板体积为正。
- `.blend` 与 GLB mesh 保留 family、profile、合同 hash、模型 ID 和有效厚度。结果几何标签必须与执行快照一致，不能靠 Blender 自报改变合同。

## 验证方法与原开发历史证据

旧 GLB 仍用严格六块平面 + 实心 Core 断言。新几何只有在受信任合同显式声明纸板壳时才启用对应校验；按导出实际三角形匹配完整曲面、闭合内外壁及绕序，再核对六面 UV/镜像/贴图字节、Alpha、材质和轴向外尺寸。新 GLB 元数据必须与预期 family/profile/hash 一致，但元数据本身不能证明几何通过。

第一 checkpoint 为 9 项失败测试（几何模块尚不存在），最小实现后全部转绿。随后增加六面独立 UV 标记、正体积、缺内壁、反绕序、重复三角形、缺面、离面、镜像、实心芯冒充、profile/尺寸篡改等失败路径。测试只生成合成坐标、PNG/PDF，不读取客户稿或启动 Illustrator。

| 验证 | 原开发工作树历史结果 |
|---|---|
| render contract / geometry / GLB / pipeline V2 完整相关单测 | 291 PASS，3 SKIP；跳过的是显式 Blender 导出 |
| render generation 完整单测 | 109 PASS，2 SKIP；两个实际完整 Blender 测试另行 opt-in |
| Blender 实际导出：legacy / shell / pouch | 3 PASS；包含透明贴图、实际尺寸/UV/材质及新模型元数据篡改拒绝 |
| 新 profile 实际完整临时 registry 链路 | PASS；首次 91.40 秒（Blender 本体 52.635 秒），元数据绑定加强后复验 88.34 秒；3000×3600 产品图、1440 卡图、GLB、runtime_verified/current 封存均通过 |
| compat 实际完整临时 registry 链路 | PASS，72.45 秒；旧 profile 未改分辨率/参数 |
| `npm run quality` / `git diff --check` | PASS；59 个既有 baseline findings（knip 57、vulture 2），无新增豁免 |

两处既有防篡改测试桩最初未透传新增关键字参数，出现 TypeError；已修正测试桩继续透传到真实验证器，未削弱防篡改断言。留存证据时曾将 basetemp 选在 macOS 的 `/tmp`，被 canonical `os.tmpdir()` 生产注册禁用门拒绝；改用正常系统临时根复验，没有放宽门或修改生产配置。

最终本机合成证据位于 `/var/folders/tz/wswl3q3117v437rw68yd90gh0000gn/T/beian-rf05-evidence.bES86FsGZK/carton-full-test/`，未放进仓库或正式 baseline。该目录是系统临时存储，不承诺永久保留；测试命令与合成 fixture 可重建证据。

本机 Blender 为 5.2.0 LTS / Darwin，build hash `fbe6228777e7`；最终纸盒复验 Blender 本体 49.310 秒，测得 30×20×50 mm（报告精度下三轴误差均 0.0000 mm）。整个临时 registry 测试的 88.34 秒还包含预检、采样/卡图/GLB 校验、封存与测试开销，不是纯渲染耗时。

## 本次独立候选验证

本次独立工作树重新执行：服务端 **727 PASS、1 SKIP**，UI **342 PASS**，Python **1059 PASS、10 SKIP、4 DESELECTED**（203.28 秒）。四项 deselect 是真实客户稿，原生 Blender 导出/全链仍为 opt-in，没有启动 Blender 或 Illustrator。

`npm run typecheck`（含 UI build）、`npm run test:quality`（47 PASS）及 `npm run quality`（59 个既有 baseline findings）通过。质量检查首次与其合同测试并行时读到了测试临时 probe；按独立顺序重跑后通过，未增加豁免。继承的 CI 预算断言已随 RF-03 基线同步。

上述完整 L0 之后继承 RF-04 的 CI 测试修正：合成 fixture 通过普通 `resourcePolicy` 将实际磁盘预留从 4 GiB 改为 8 MiB，并采用有界的 60/65/75 秒等待。该修正在 RF-04 服务端重跑取得 727 PASS；RF-05 产品源码未变，但完整 L0 未在继承该修正后再次运行，不能将两轮证据合称为一次全套复验。

独立覆盖审计新增 **15 项合成 GLB 二进制行为回归**，覆盖实际序列化/解析及身份、内壁、UV、贴图篡改；合并行为覆盖为 16/18（88.9%，非行覆盖）。余下两条原生 Blender 分派/导出及完整封存本轮未重跑。独立 Codex 与 MiniMax 审查未发现确认 P1/P2，旧 profile 与历史 registry 字节已核对。源码哈希与上述完整验证候选一致。

## 复验命令与未交范围

```bash
apps/web/backend/.venv/bin/python -m pytest -q \
  apps/web/backend/tests/test_packaging_render_contract.py \
  apps/web/backend/tests/test_packaging_render_geometry.py \
  apps/web/backend/tests/test_packaging_glb_verify.py \
  apps/web/backend/tests/test_packaging_pipeline_v2.py \
  apps/web/backend/tests/test_packaging_render_generation.py

# 明确 opt-in；只用本机 Blender 和临时合成数据，不属于默认 L0。
PATH=/Applications/Blender.app/Contents/MacOS:$PATH BEIAN_TEST_BLENDER_EXPORT=1 \
  apps/web/backend/.venv/bin/python -m pytest -q \
  apps/web/backend/tests/test_packaging_glb_verify.py -k actual_blender_export
PATH=/Applications/Blender.app/Contents/MacOS:$PATH BEIAN_TEST_BLENDER_FULL=1 \
  apps/web/backend/.venv/bin/python -m pytest -q \
  apps/web/backend/tests/test_packaging_render_generation.py \
  -k normal_local_runtime_with_actual_synthetic_blender_full_card_glb
```

原开发阶段没有 UI 布局/文案改动，没有执行 ship、合并、部署或改变生产 current。本次独立 ship 只包含提交、推送和 PR；当前测试在独立验证一节记录。样图只是带非对称角标的合成色块盒，不能证明真实 PDF 小字、白卡商品质感或人工盲评通过。Windows L1、杭州真实稿 L2、UAT、正式视觉 baseline、RF-06+ 仍需各自取证。
