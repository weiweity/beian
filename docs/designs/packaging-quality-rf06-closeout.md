# RF-06 本地交付记录

日期：2026-09-07。状态：**RF-06 PR 候选，未合并、未发布**。范围：显式纸材/油墨/整体工艺合同、分层材质与微法线、GLB 可导出子集校验。分支 `codex/rf06-materials`，基线 `66380894fc37463be49e1fa22ac472e5898bac1b` / `0.21.39.0`。本轮进入 `/ship` 提交、推送与 PR 准备；合并和部署不在本轮授权内。RF-07 棚光与色彩变换不在范围。

## 实现与兼容边界

- 材质至少四个概念：substrate、process ink、overall finish、unsupported spot。白卡与显式 `kraft-card-v1`；`none` / `overall-matte-lamination-v1` / `overall-gloss-varnish-v1`。未知纸材/工艺、无独立 mask 的局部工艺失败关闭。不按文件名、颜色、SKU、图层名推断。
- 新 schema 字段（`ink_color_space`、`core_roughness`、`core_specular_ior_level`、`coat_*`、`substrate_micro_normal`、`glb_export`）只在显式声明时进入规范化 spec/hash。旧 profile 不注入这些字段，已发布 hash 不变。纸边与印刷层反射分开：已发布纸边保持 Blender 默认 Specular IOR Level=0.5、Roughness=0.6、不上光；整体上光只作用在印刷层。Core 网格无 UV，不贴微法线。
- 候选 profile 在 `workers/packaging/profiles/experiments/rf06-materials.v1.json`，只经 `render_plan_for_experimental_material_job` / `load_experimental_material_registry` 诊断入口使用。未改 `workers/packaging/profiles/render-profiles.v1.json`、生产默认注册、模板 `compat-legacy-v0`、F 灯光或 `Standard` view transform。
- 材质只在 `render_contract.resolved_material_layers` / `material_runtime_from_job` 解析一次，贯穿 spec、flat render 可选键、fingerprint 与 Blender。Blender 不再散落猜测 roughness/coat/法线。
- 颜色纹理强制 sRGB，微法线 Non-Color、固定 16/32/64/128 px 与 seed，六面共用一张。Alpha 仍是 MASK 物理覆盖；不透明纸板壳职责不变。
- GLB 支持子集以实际产物校验：roughnessFactor、`KHR_materials_clearcoat`（仅印刷面）、normalTexture 像素/scale（省略=1）/texCoord+UV、拒绝 metallicRoughnessTexture 与未实现扩展覆盖。`compare_glb_artifact_contract` 从可信 `render_spec` 解析材质并纳入 PBR；`render_generation` 独立产物门同样走该入口。静帧有 coat/法线而 GLB 声明不导出时给出机器可读 differences，不把未导出写成支持。不接受调用者自选 required extension 绕过。

四个诊断 profile：`packshot-material-white-none-v1`、`packshot-material-kraft-none-v1`、`packshot-material-white-matte-v1`、`packshot-material-white-gloss-v1`。几何沿用 RF-05 纸板壳，灯光/色彩沿用 `packshot-carton-geometry-v1`。

## 验证与顾问收尾

实现由 Grok 完成，Codex 独立复核并补齐两个旧原生合成夹具的显式材质字段。生产渲染器继续拒绝缺失材质的 spec；没有增加宽松回退。

| 验证 | 实际结果 | 证据 |
|---|---|---|
| 初始红测 | 30 failed / 3 passed / 1 deselected，exit 1 | `rf06/red-test-packaging-render-materials.txt` |
| Grok 修正后相关普通回归 | 477 passed / 5 skipped / 1 deselected，exit 0 | `rf06/review-fixes/green-related-python.txt` |
| 顾问完整普通 Python 回归 | 1114 passed / 9 skipped / 6 deselected，exit 0 | `rf06-adviser/beian-verify-hWDH2s/receipt.json` |
| 质量工具合同与扫描 | 59 tests passed；quality PASS，原有 59 项基线，无新增发现 | `rf06-adviser/beian-verify-jxwHA2/receipt.json` |
| Grok 显式原生 GLB | Blender 5.2.0 LTS，1 passed，exit 0 | `rf06/review-fixes/green-native-export.txt` |
| 顾问旧导出兼容 | legacy / shell / pouch 三项 passed，61 deselected，exit 0 | `rf06-adviser/compatibility-fixed/receipt.json` |
| 顾问完整合成渲染 | 四材质 × 正反两视角；8 张 3000×3600 RGBA、4 GLB、4 Blend 与核对卡；全部经实际 pipeline 和独立 GLB 校验 | `rf06-adviser/native-matrix/report.json` |
| 顾问实际 GLB 篡改复验 | 原始导出通过；法线强度归零、移除清漆、篡改粗糙度全部拒绝 | `rf06-adviser/validator-probes-fixed.json` |

以上证据相对父目录 `/Users/hutou/Documents/Codex/audits/beian-rf06-rf07-20260907/`。完整 Python / quality 回执执行期间源码稳定；其后只补齐两个原生夹具的材质字段，补丁对应三项原生复验，不影响先前普通测试和产品源码。上述为本地实现阶段证据；本轮 `/ship` 的最终候选门禁另行记录。

合成渲染逐单调用现有 `pipeline.run_blender_job`，每单 300 秒上限，不跳过磁盘合同、execution nonce、渲染器内 GLB 校验或独立产物复核。每单 11.9–17.2 秒；产物及产品源码哈希保存在矩阵报告和 `source-manifest.json`，执行期间产品源码未变。没有客户稿、Illustrator、OCR、服务或生产调用。

顾问已查看 `native-matrix/contact-sheet.png`：八张成片完整，正反面标签可区分，显式牛皮纸在合成稿透明覆盖区露出棕色基底，上光与哑膜在相同 Standard 灯光下可区分。这是合成输出观察，不能当成真实纸材金标或画质批准。

### 顾问发现与关闭证据

| ID | 第一轮问题 | 修复与独立复验 |
|---|---|---|
| F1 | 共享材质函数把印刷层 specular 0.08 写到纸边，主线纸边为 0.5 | core/ink 分路；本机节点实测 specular=0.5、roughness≈0.6、coat=0；纸边不贴无 UV 的法线 |
| F2 | 实际导出 normalTexture.scale=0 仍被判有效 | 新校验同时验证强度、UV 绑定和不支持的纹理覆盖；对本轮真实导出归零后明确失败 |
| F3 | 清漆丢失只使独立 PBR 失败，artifact/generation 仍接受 | 汇总门纳入可信材质；从本轮真实导出删除 clearcoat 后汇总门明确失败 |

初始红测与修正红测留作过程记录；修正红测同时暴露了夹具缺失，不能把每个红测都等同产品缺陷。F1–F3 的缺陷依据是顾问第一轮实际节点/GLB 探针，关闭依据是上表独立复验。

GLB 声明并核验的子集为 roughness、印刷面的 clearcoat、normalTexture；Blender 还写出 `KHR_materials_specular`，该扩展不在本轮认证子集。微法线在六个印刷面共用，裸纸边未实现 UV 法线。静帧和 GLB 不宣称完整视觉等价。

实现阶段 `git diff --check` 通过；本轮 `/ship` 将版本升至 `0.21.40.0` 并更新 CHANGELOG。已发布 registry、F 灯光、Standard 和正式 baseline 均未更改。杭州 L1、真实稿 L2、UAT 与正式视觉 baseline 审批未执行。

### PR 准备复核

独立覆盖审计复现了额外 UV accessor 引用不存在时被放行的问题。材质校验现复用已有二进制 accessor 解析，核对引用有效性、VEC2 类型、有限值及与 POSITION 的数量一致性；回归与完整发布门禁结果见本轮 PR。

## 未交范围

- RF-07 尺寸归一棚光与 Standard / Khronos PBR Neutral / AgX 实验。
- 生产 generation 注册、网页 upgrade、默认 profile 切换。
- 深色纸、金属、珠光、透明窗口、烫金/局部 UV。
- Windows 原生、真实稿验证和人工画质批准。

本轮冻结后完整 `/ship` 回执：服务端 727 passed / 1 skipped，界面 342 passed，Python 1127 passed / 9 skipped / 6 deselected；`test:quality` 59 passed、quality PASS（原有 59 项基线）、typecheck/UI build PASS，四步均 exit 0，执行期间源码稳定。证据：仓库外 `beian-rf06-ship-20260907/full/beian-verify-ss6N3D/receipt.json`。第一轮因审计补测试期间源码变化被判无效，未用作最终凭据。

独立计划审计 15/15 Done；独立覆盖审计新增 13 个参数化行为测试并关闭无效法线 UV accessor 误放行；独立 Codex 代码审查未发现剩余范围内问题。覆盖清单 27/30 组为 AI 评估，非实测行覆盖率，剩余三组为 Blender socket、颜色空间拒绝赋值与缓存 IO 故障注入。Claude 原生调用返回未登录，按 Skill 非阻断规则记录不可用；未把 MiniMax 路由标为 Claude。最终 PR HEAD CI 仍须单独核对。
