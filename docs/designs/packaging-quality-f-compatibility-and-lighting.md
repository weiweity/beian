# F：旧任务兼容

本批范围：显式可选 F profile 与受信任历史 registry 回放。模板默认不切换，不包含网页预览、调光曲线或高光保护；这些属于后续独立 PR。下方真实入口记录来自原开发阶段，不冒充本次 ship 重跑或 Windows/L2 验收。

## 旧任务兼容根因与修复

加入 F 后 registry 原始字节 SHA 改变，旧 spec 即使视觉参数未变也会被原严格比较拒绝。比较直接放宽哈希/重签任务与固定历史快照两种方案，选择后者。

- 历史文件为源控内的 `profiles/history/pre-f.v1.json`，字节 SHA 固定为 `38ee501b794e9979a8ab06f2e0e1a476271ea9c7897c41eed3460d0f0acfc77b`。
- 路径不接受任务输入，不扫描任意文件；当前 registry 必须继续完整保留所有历史 profile 身份。
- 旧 spec 继续按历史 registry 校验字段、profile hash、合同 hash、顶层身份和平面 render；不改写、不重签，不为未知 SHA 兜底；旧表不能授权 F。
- 新任务仍解析当前 registry；缓存命中沿用 fingerprint 合同，不强行跨代复用。

## 原开发阶段的合成证据

原记录目录 `/tmp/beian-f-compat-Pj0m1I`：复制旧合成白盒资产到隔离目录，用实际 `run_blender_relight` 重渲并保留原身份；随后注入 exit 0 + Shadow buffer full，确认失败且原输出字节保持不变。

`replay-report.json` 保存身份摘要；`last-blender.log` 是最后一次注入失败日志，不是之前成功日志。本次 ship 未重跑真实 Blender，不据历史产物宣称当前 Windows 或视觉验收通过。

## 当前回归与待完成门

本批单测覆盖历史 replay、不重签、旧表拒绝 F、未知 SHA、profile/材质/平面 render 篡改、历史文件篡改及当前 profile 漂移。完整发布测试以本次 PR 的验证结果为准。

Windows F 资源预算、真实稿 L2 和默认 F 启用仍需独立验证/批准；网页调光和高光保护不在本批，不影响本批旧任务身份保护的判断。
