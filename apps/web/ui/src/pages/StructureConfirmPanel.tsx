import { useMemo, useState } from "react";
import { Alert, App, Button, Segmented, Select } from "antd";
import { api, type MockupJob } from "../api";
import {
  BOX_FACE_LABEL,
  BOX_FACE_ROLES,
  selectedFaceDecisions,
  structureIssueCopy,
  structurePolygonPoints,
  structureViewBox,
  type BoxFaceRole,
  type FaceChoice,
} from "./mockupStructure";

type Props = {
  job: MockupJob;
  canAdmin: boolean;
  onConfirmed: (job: MockupJob) => void;
};

function faceLabel(index: number, size?: [number, number]): string {
  const dimensions = size ? ` · ${size[0]}×${size[1]} mm` : "";
  return `面 ${index + 1}${dimensions}`;
}

export function StructureConfirmPanel({ job, canAdmin, onConfirmed }: Props) {
  const { message, modal } = App.useApp();
  const faces = job.structure_preview?.faces || [];
  const [choices, setChoices] = useState<Record<string, FaceChoice>>({});
  const [submitting, setSubmitting] = useState(false);
  const decisions = useMemo(() => selectedFaceDecisions(faces, choices), [choices, faces]);
  const selectedRoles = new Map<BoxFaceRole, string>();
  for (const [faceId, choice] of Object.entries(choices)) {
    if (choice.role) selectedRoles.set(choice.role, faceId);
  }
  const viewBox = structureViewBox(faces).join(" ");

  function update(faceId: string, patch: Partial<FaceChoice>) {
    setChoices((current) => {
      const existing = current[faceId] ?? { role: "", quarterTurns: 0 };
      return {
        ...current,
        [faceId]: { ...existing, ...patch },
      };
    });
  }

  function submit() {
    if (!decisions || !canAdmin) return;
    modal.confirm({
      centered: true,
      title: "确认这六个盒面？",
      content: "确认结果会绑定当前源稿。源稿一旦变化，本次确认自动失效；确认后才会进入 Blender。",
      okText: "确认并开始打样",
      cancelText: "再检查一下",
      onOk: async () => {
        setSubmitting(true);
        try {
          const next = await api.confirmMockupStructure(job.id, decisions);
          onConfirmed(next);
          message.success("结构已确认，开始打样。");
        } catch (error) {
          message.error(error instanceof Error ? error.message : "结构确认失败");
          throw error;
        } finally {
          setSubmitting(false);
        }
      },
    });
  }

  const issue = structureIssueCopy(job);
  if (job.structure_status === "unsupported" || !faces.length) {
    return (
      <div className="structure-confirm">
        <Alert
          type={job.structure_status === "unsupported" ? "error" : "warning"}
          showIcon
          title={job.structure_status === "unsupported" ? "这类结构暂不支持自动打样" : "结构需要处理后再打样"}
          description={issue}
        />
      </div>
    );
  }

  return (
    <div className="structure-confirm">
      <Alert
        type="warning"
        showIcon
        title="闭合面已经识别，请确认六个盒面"
        description="系统只计算闭合关系，不猜正反和方向。折舌、粘口等面保持“不作为盒面”。"
      />
      <div className="structure-confirm-layout">
        <div className="structure-map-shell">
          <svg className="structure-map" viewBox={viewBox} role="img" aria-label="包装展开结构面预览">
            {faces.map((face, index) => {
              const [left, top, right, bottom] = face.bounds_mm;
              const choice = choices[face.id];
              const outline = structurePolygonPoints(face);
              return (
                <g key={face.id} className={choice?.role ? "is-selected" : ""}>
                  {outline ? (
                    <polygon points={outline} />
                  ) : (
                    <rect
                      x={left}
                      y={top}
                      width={right - left}
                      height={bottom - top}
                      rx={0.8}
                    />
                  )}
                  <text x={face.centroid_mm[0]} y={face.centroid_mm[1]} dominantBaseline="central">
                    {choice?.role ? BOX_FACE_LABEL[choice.role] : index + 1}
                  </text>
                </g>
              );
            })}
          </svg>
          <p>紫色面是已选择的六面。右侧可调整正反、侧面和旋转方向。</p>
        </div>
        <div className="structure-face-list">
          {faces.map((face, index) => {
            const choice = choices[face.id] || { role: "", quarterTurns: 0 };
            return (
              <div className="structure-face-row" key={face.id}>
                <div>
                  <strong>{faceLabel(index, face.size_mm)}</strong>
                  {!face.rectangular ? <span>非矩形，暂不能作为六面</span> : null}
                </div>
                <Select
                  aria-label={`${faceLabel(index, face.size_mm)}角色`}
                  value={choice.role || undefined}
                  placeholder="不作为盒面"
                  allowClear
                  disabled={!face.rectangular || !canAdmin}
                  options={BOX_FACE_ROLES.map((role) => ({
                    value: role,
                    label: BOX_FACE_LABEL[role],
                    disabled: selectedRoles.has(role) && selectedRoles.get(role) !== face.id,
                  }))}
                  onChange={(value) => update(face.id, { role: (value || "") as FaceChoice["role"] })}
                />
                <Segmented
                  aria-label={`${faceLabel(index, face.size_mm)}方向`}
                  size="small"
                  disabled={!choice.role || !canAdmin}
                  value={choice.quarterTurns}
                  options={[
                    { label: "0°", value: 0 },
                    { label: "90°", value: 1 },
                    { label: "180°", value: 2 },
                    { label: "270°", value: 3 },
                  ]}
                  onChange={(value) => update(face.id, { quarterTurns: value as FaceChoice["quarterTurns"] })}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="structure-confirm-actions">
        <span>
          {canAdmin
            ? decisions
              ? "六面已齐，可以继续。"
              : `已选 ${Object.values(choices).filter((choice) => choice.role).length} / 6 面`
            : "只有管理员可以确认结构；其他人仍可查看这单。"}
        </span>
        <Button type="primary" disabled={!decisions || !canAdmin} loading={submitting} onClick={submit}>
          确认并开始打样
        </Button>
      </div>
    </div>
  );
}
