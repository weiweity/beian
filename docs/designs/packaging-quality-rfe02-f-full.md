# F 全尺寸、双视角与产品合成回归

> 历史实验报告，随第 04 批归档。下文状态、授权、测试数量和临时产物只描述当时实验；本批没有重新运行 Blender 或产品合成矩阵。后续阴影处理见 `packaging-quality-rfe02-shadow-budget.md`，已独立交付的显式可选 F profile 见 `packaging-quality-f-contract.md`；不据本报告宣称当前默认切换或真实稿验收通过。

状态：本机机器合同验证完成，阴影可靠性未通过；暂不接入产品默认。用户已确认 F 的上一轮合成视觉效果都可以，并批准继续全尺寸、双视角与合成验证。此授权不是自动 ship / 部署。

## 本轮执行

目录 `/tmp/beian-f-full-nZC3LH`，`verify_f.py` 分别启动四个 Blender 进程（白盒、宽盒、深色盒、文字盒），均 exit 0。继续读取原合成 normalized-rig-v1 保存场景，F 的 Fill ×0.35、主灯绕盒心仰角 -15°与前轮回执精确一致；没有继续调灯。

直接复用当前产品 `render_job.render_views`、`export_model`、`verify_glb`，将所有输出改到新的临时目录；源 blend、resolved_job 与六面资产哈希前后相同。复用保存场景，不是重新经过 V2 输入提案/任务入队的端到端测试，不将源 render_profile 冒称 F 已注册。

- 四个作业各六个 pass：正/反产品 RGBA、正/反 ground、正/反 set，共 24 张 3000×3600。
- 各导出新的 blend/GLB。四个 GLB 均重新导入验证：材质及嵌入纹理、六面来源绑定、UV 方向/镜像、纸板内核、轴向毫米尺寸。不是只检查文件存在。
- 作业耗时约：白盒 61.5s、宽盒 79.3s、深色盒 90.2s、文字盒 68.4s。部分并发，不能把这几个耗时简单相加为墙钟。
- 回执绑定源文件、脚本、render_job、glb_verify、camera_frame 与输出 SHA，逐 pass 记录相机与模型旋转；24 张分辨率、身份检查通过。

## 产品合成器

`compose.mjs` 将当前 `mockupStudio.ts` 编译到隔离 Chromium 页面，复用 `composeStudioStill` 与 `blobFromStudioStill`，不改产品源码。四盒 × 两视角 × 白/银/白桌白墙，共 24 张新合成 PNG，均 3000×3600；预览 canvas 与下载 PNG 解码像素逐项相同。源 pass 与合成输出哈希检查通过，报告为 `compositor-report.json`。

本轮使用真实默认 `productLight=backgroundLight=1`，包含现有 `contrast(1.04)`；默认白底为 RGB 238，银底 196/201/208，不是前轮纯白/浅灰观察底。白/银不叠地面，白桌白墙使用本轮 set，不乘旧 ground。未覆盖滑条全部值或整页 Hono 作业状态。

复核页 `index.html` 四盒/三背景共 12 个状态的 24 张图片加载通过，实际截图为 `page-white-set.png`。页面有原始像素查看、全图下载及印刷面/GLB 文件链接；没有交互式 GLB 查看器。相关 pytest 34 passed；UI 合成与预览测试 29 passed。没有本轮产品代码变化，不重复宣称全仓测试已重跑。

## 未关闭的风险

文字盒 Blender 进程在输出与 GLB 校验完成后打印多条：`阴影缓冲满了，可能导致阴影缺失和性能降低`，例如 `(2347 / 2048)`。退出码仍为 0，说明“渲染完成/合同通过”不能充当阴影质量通过。日志输出顺序不足以定位到具体 pass，不假定只影响文字盒地面或完全不影响成片。

只读检查保存场景：EEVEE `shadow_pool_size=512`、`shadow_resolution_scale=1.0`；三盏灯 `shadow_maximum_resolution≈0.001`。Blender [官方说明](https://docs.blender.org/manual/en/5.0/render/eevee/light_settings.html) 将此类警告解释为阴影内存不足，并列出阴影池/分辨率限制作为处理方向。这是下一轮验证假设，不是本轮已修复结论；未修改这些设置，也未降低阴影质量绕过。

上一轮用户对 F 的认可仅绑定诊断产品层；本轮白桌白墙、接触影与实际产品合成效果仍需视觉复核。英文合成文字不能证明中文真实稿可读、条码可扫描；整条物理文字 ROI 投影未结案。没有 Windows L1/L2、生产 UAT 或新盒型能力证据。

下一检查点：固定 F 不变，定位阴影警告的 pass 与资源需求，保留失败证据后做有界重跑；只有阴影门和视觉检查闭合，才考虑版本化产品配置。当前未 commit / push / PR / merge / deploy，未写批准基线。
