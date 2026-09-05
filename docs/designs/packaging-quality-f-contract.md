# F 候选接入版本化渲染合同

范围：显式可选的 F profile，保留所有原 profile 和模板默认。本批包含 F 合同与旧任务 registry 兼容，不包含网页高光保护或代际存储。下面的合成验证记录来自原开发工作树，不替代本次 ship、Windows 或真实稿 L2；业务仍未开放。

## 设计取舍

比较了两种接入：原位修改 `compat-legacy-v0`，或追加独立版本。选后者，避免旧 profile 身份不变却改变画面，不增加 UI 参数入口，也不让产品依赖实验 wrapper。复用原 resolver → persistable plan → execution snapshot → Blender → nonce 结果校验链。

追加 `packshot-f-v1`，只声明已有矩形纸盒能力，继承兼容 profile 的几何、材质、相机、采样和输出合同，不宣称新增闭合细节或膜袋能力。

## 参数与消费路径

- `studio.profile = normalized-three-area-f-v1`；参考最长边 180 mm，参考目标 `(0,0,90)`，当前目标盒身中心。
- 灯位、灯尺寸按最长边比例缩放，功率按比例平方缩放；不读取颜色、稿件内容或夹具名称。
- Fill 功率乘 0.35；Key 绕盒中心降 15°，半径、方位角、功率、面积保持不变。
- `renderer.shadow_pool_size_mb = 1024`。这些参数进入 profile SHA、resolved spec、render contract hash、平面 render 和既有 fingerprint token。
- F 缺参数、错参数、缺阴影预算均失败；旧 profile 不被注入新默认字段，保留旧 profile SHA。
- Blender 在原 `add_studio` 中消费平面 render，不导入实验工具；不支持该阴影池属性、赋值失败或读回不一致时明确失败，禁止静默退回 512 MB。

## 成功语义

产品 Blender 子进程增加 `--python-exit-code 1`。父进程保存完整 stdout/stderr 后，检查已复现的英文 `Shadow buffer full` 和中文阴影缓冲满警告；即便 exit 0 也以 `render_shadow_pool_exhausted` 失败，不生成核对卡、不接受结果成功。原日志和临时产物保留用于诊断，不删除用户文件。

这不是所有 GPU/所有本地化文本的通用错误解析器；不把零已知警告等同于完整视觉验收。原 ground/set 的其他可选 pass 失败规则不变。

## 验证入口与边界

单测覆盖：参数缺失/变异、旧 profile 身份与默认不变、膜袋拒绝、资源属性缺失/拒绝/静默忽略、英文/中文 stdout/stderr 警告、exit 0 不发布核对卡。质量门未扩大已有基线。

真实入口合成验证目录 `/tmp/beian-f-contract-BFI10O`：从既有合成六面资产构造新的 F plan，复制到独立目录，由产品 `run_blender_job` 启动原 `render_job.py`，完整生成静帧、GLB、结果清单及卡图。不是加载旧 F blend 冒充新入口执行；运行结果以目录中的 `report.json` 为准。

实测结果：

- 合同/资源测试最终 96 passed；流水线 64 passed；实验工具/GLB 92 passed；RF-00/缩略图/导出 88 passed、4 skipped。分批执行，共 340 个不同测试通过；没有把旧轮 UI 结果算成本轮重跑。
- 显式指定既有后端虚拟环境的 Python 后，`npm run quality` 通过，59 条既有基线；未改质量基线。第一次未指定解释器时因本工作树没有 `.venv` 失败，后续复用已装依赖，没有安装或修改环境。
- 白盒 54.0 s、宽盒 57.0 s、深色盒 61.6 s、文字盒 67.4 s；四轮完整产品入口成功，24 张 3000×3600 pass、4 个 GLB 合同验证通过，所有日志零已知阴影溢出。保存了产品结果清单及六张派生卡图/盒。
- 重新读取四个新 blend：阴影池均 1024；逐灯灯位、角度、功率、尺寸与用户已确认 F 回执比较，最大字段差约 0.00001526，容差 0.001 内。属于浮点精度差异，不是声明参数变化。
- 与上轮阴影修复图比较：24 张 Alpha 全部一致；白/深色/文字盒最大通道差 1，宽盒产品最大 3、ground 最大 3、set 最大 4。不能称为像素完全相同。详细均值和 SHA 在 `pixel-verification.json`、`scene-verification.json`、`report.json` 中。
- CLI `--help`、`git diff --check` 通过。本轮未重跑浏览器、完整 npm test、Windows L1 或真实稿 L2。

尚未修改模板 profile 选择、产品默认、批准基线或生产数据。新增 registry 项会改变 registry 身份，旧持久化 spec 的严格身份行为仍遵守现有合同，不能自动改写或重签旧任务。正式启用前仍需检查重试/旧任务策略、Windows 资源预算、全套灯光交互、真实稿 L2，并走独立发布授权。

旧任务通过固定哈希的受信任历史快照复验，不改写身份；合同见 `packaging-quality-f-compatibility-and-lighting.md`。本节测试数量保留为原开发阶段历史记录，本次完整发布门结果记录在对应 PR；网页预览及高光保护留待后续批次。
