import { useMemo, useState } from "react";
import { Alert, App, Button, Segmented, Select } from "antd";
import { api, type MockupJob } from "../api";
import {
  selectedStructureAnchor,
  structureIssueCopy,
  structurePolygonPoints,
  structureViewBox,
} from "./mockupStructure";

type Props = {
  job: MockupJob;
  canAdmin: boolean;
  onConfirmed: (job: MockupJob) => void;
};

type QuarterTurns = 0 | 1 | 2 | 3;

function dimensions(size?: [number, number]): string {
  return size ? ` · ${size[0]}×${size[1]} mm` : "";
}

export function StructureConfirmPanel({ job, canAdmin, onConfirmed }: Props) {
  const { message, modal } = App.useApp();
  const preview = job.structure_preview;
  const faces = preview?.faces || [];
  const proposals = preview?.net_proposals || [];
  const [proposalId, setProposalId] = useState("");
  const [frontFaceId, setFrontFaceId] = useState("");
  const [quarterTurns, setQuarterTurns] = useState<QuarterTurns>(0);
  const [submitting, setSubmitting] = useState(false);
  const proposal = proposals.find((item) => item.id === proposalId) || proposals[0];
  const proposalFaceIds = useMemo(() => new Set(proposal?.face_ids || []), [proposal]);
  const proposalFaces = useMemo(
    () => faces.filter((face) => proposalFaceIds.has(face.id)),
    [faces, proposalFaceIds],
  );
  const facesById = useMemo(() => new Map(faces.map((face) => [face.id, face])), [faces]);
  const bodyIndex = useMemo(
    () => new Map((proposal?.body_face_ids || []).map((faceId, index) => [faceId, index])),
    [proposal],
  );
  const effectiveFrontId = proposal?.body_face_ids.includes(frontFaceId) ? frontFaceId : "";
  const anchor = useMemo(
    () => selectedStructureAnchor(proposal, effectiveFrontId, quarterTurns),
    [effectiveFrontId, proposal, quarterTurns],
  );
  const viewBox = structureViewBox(proposalFaces.length ? proposalFaces : faces).join(" ");
  const pageSize = preview?.page_size_mm;
  const artworkImage = preview?.image_url;
  const hasArtwork = Boolean(artworkImage && pageSize);
  const confirmedAnchor = hasArtwork ? anchor : null;

  function selectProposal(nextId: string) {
    setProposalId(nextId);
    setFrontFaceId("");
    setQuarterTurns(0);
  }

  function submit() {
    if (!confirmedAnchor || !canAdmin) return;
    modal.confirm({
      centered: true,
      title: "确认正面和阅读方向？",
      content: "系统会从完整盒型自动推导右侧、反面、左侧、顶部和底部，并在进入 Blender 前再次校验闭合关系、相对面尺寸和六面贴图。",
      okText: "确认并开始打样",
      cancelText: "再检查一下",
      onOk: async () => {
        setSubmitting(true);
        try {
          const next = await api.confirmMockupStructure(job.id, confirmedAnchor);
          onConfirmed(next);
          message.success("正面已确认，开始打样。");
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

  if (!proposals.length || !proposal) {
    return (
      <div className="structure-confirm">
        <Alert
          type="warning"
          showIcon
          title="这单需要重新识别结构"
          description="这单是旧版零散候选，或当前线稿还不能形成完整六面。请在 Illustrator 补齐结构语义后重新上传；系统不会继续让你逐个猜盒面。"
        />
      </div>
    );
  }

  return (
    <div className="structure-confirm">
      <Alert
        type="info"
        showIcon
        title="完整盒型已经找出，只需确认正面"
        description="点击原稿上真正的产品正面，再确认文字朝向。其余五面由连通关系自动推导；推导不唯一或尺寸不闭合时会拒绝进入 Blender。"
      />
      <div className="structure-confirm-layout">
        <div className="structure-map-shell">
          <svg className="structure-map" viewBox={viewBox} role="img" aria-label="完整包装展开结构预览">
            {hasArtwork && artworkImage && pageSize ? (
              // 原稿预览与结构面共用毫米坐标；保持逐点映射，避免自适应留白让点击面错位。
              <image
                className="structure-map-artwork"
                href={artworkImage}
                x={0}
                y={0}
                width={pageSize[0]}
                height={pageSize[1]}
                preserveAspectRatio="none"
              />
            ) : null}
            {proposalFaces.map((face) => {
              const [left, top, right, bottom] = face.bounds_mm;
              const candidateIndex = bodyIndex.get(face.id);
              const isBody = candidateIndex !== undefined;
              const isFront = face.id === effectiveFrontId;
              const outline = structurePolygonPoints(face);
              const label = isFront ? "正面" : isBody ? String.fromCharCode(65 + candidateIndex) : "封口";
              return (
                <g
                  key={face.id}
                  className={`${isBody ? "is-body" : "is-cap"}${isFront ? " is-selected" : ""}`}
                  role={isBody ? "button" : undefined}
                  tabIndex={isBody && canAdmin && hasArtwork ? 0 : undefined}
                  aria-label={isBody ? `选择正面候选 ${label}` : "自动推导封口面"}
                  onClick={isBody && canAdmin && hasArtwork ? () => setFrontFaceId(face.id) : undefined}
                  onKeyDown={isBody && canAdmin && hasArtwork ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setFrontFaceId(face.id);
                    }
                  } : undefined}
                >
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
                    {label}
                  </text>
                </g>
              );
            })}
          </svg>
          <p>
            {hasArtwork
              ? "A–D 是四个连续盒身面；点击印有产品主视觉的那一面。封口面无需手工指定。"
              : "原稿预览暂不可用，不能可靠判断正面；请重新识别后再确认。"}
          </p>
        </div>

        <div className="structure-anchor-card">
          {proposals.length > 1 ? (
            <label className="structure-anchor-field">
              <span>完整盒型</span>
              <Select
                value={proposal.id}
                disabled={!canAdmin}
                options={proposals.map((item, index) => ({
                  value: item.id,
                  label: `盒型方案 ${index + 1} · 六面连通`,
                }))}
                onChange={selectProposal}
              />
            </label>
          ) : (
            <div className="structure-net-found">
              <span>完整盒型</span>
              <strong>六面连通 · 已通过拓扑筛选</strong>
            </div>
          )}

          <div className="structure-front-choices" aria-label="选择产品正面">
            <span>产品正面</span>
            <div>
              {proposal.body_face_ids.map((faceId, index) => {
                const face = facesById.get(faceId);
                const selected = faceId === effectiveFrontId;
                return (
                  <Button
                    key={faceId}
                    type={selected ? "primary" : "default"}
                    disabled={!canAdmin || !hasArtwork}
                    onClick={() => setFrontFaceId(faceId)}
                  >
                    候选 {String.fromCharCode(65 + index)}{dimensions(face?.size_mm)}
                  </Button>
                );
              })}
            </div>
          </div>

          <label className="structure-anchor-field">
            <span>文字朝向</span>
            <Segmented
              block
              disabled={!effectiveFrontId || !canAdmin || !hasArtwork}
              value={quarterTurns}
              options={[
                { label: "不旋转", value: 0 },
                { label: "右转 90°", value: 1 },
                { label: "转 180°", value: 2 },
                { label: "左转 90°", value: 3 },
              ]}
              onChange={(value) => setQuarterTurns(value as QuarterTurns)}
            />
          </label>

          <div className="structure-derived-copy">
            <strong>系统随后自动完成</strong>
            <span>右侧、反面、左侧、顶部、底部角色</span>
            <span>相对面尺寸、折叠连通与六面贴图复核</span>
          </div>
        </div>
      </div>
      <div className="structure-confirm-actions">
        <span>
          {canAdmin
            ? confirmedAnchor
              ? "正面和方向已确认，可以继续。"
              : hasArtwork
                ? "请在原稿或右侧候选中选择产品正面。"
                : "原稿预览不可用，不能确认正面。"
            : "只有管理员可以确认结构；其他人仍可查看这单。"}
        </span>
        <Button type="primary" disabled={!confirmedAnchor || !canAdmin} loading={submitting} onClick={submit}>
          确认并开始打样
        </Button>
      </div>
    </div>
  );
}
