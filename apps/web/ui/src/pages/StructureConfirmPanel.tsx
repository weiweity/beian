import { useMemo, useRef, useState } from "react";
import { Alert, App, Button, Checkbox } from "antd";
import { api, type MockupJob } from "../api";
import {
  preferredStructureTurn,
  sameStructureLayerSelection,
  selectedStructureLayerIds,
  selectedStructureAnchor,
  structureConfirmationErrorCopy,
  structureIssueCopy,
  structurePolygonPoints,
  structureProposalHasRealPolygons,
  structureViewBox,
  validTurnsForFace,
} from "./mockupStructure";

type Props = {
  job: MockupJob;
  canConfirmStructure: boolean;
  onConfirmed: (job: MockupJob) => void;
};

export function StructureConfirmPanel({ job, canConfirmStructure, onConfirmed }: Props) {
  const { message } = App.useApp();
  const preview = job.structure_preview;
  const structureInput = job.structure_input;
  const faces = preview?.faces || [];
  const proposals = useMemo(
    () => (preview?.net_proposals || []).filter((item) => structureProposalHasRealPolygons(item, faces)),
    [faces, preview?.net_proposals],
  );
  const [proposalId, setProposalId] = useState("");
  const [frontFaceId, setFrontFaceId] = useState("");
  const [selectedLayerIds, setSelectedLayerIds] = useState<string[]>(
    () => structureInput?.selected_ids || [],
  );
  const [selectingLayers, setSelectingLayers] = useState(false);
  const [layerSelectionError, setLayerSelectionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submitLock = useRef(false);
  const proposal = proposals.find((item) => item.id === proposalId) || proposals[0];
  const proposalIndex = Math.max(0, proposals.findIndex((item) => item.id === proposal?.id));
  const proposalFaceIds = useMemo(() => new Set(proposal?.face_ids || []), [proposal]);
  const proposalFaces = useMemo(
    () => faces.filter((face) => proposalFaceIds.has(face.id)),
    [faces, proposalFaceIds],
  );
  const bodyIndex = useMemo(
    () => new Map((proposal?.body_face_ids || []).map((faceId, index) => [faceId, index])),
    [proposal],
  );
  const effectiveFrontId = proposal?.body_face_ids.includes(frontFaceId) ? frontFaceId : "";
  const preferredTurn = preferredStructureTurn(proposal, effectiveFrontId);
  const anchor = useMemo(
    () => preferredTurn === null
      ? null
      : selectedStructureAnchor(proposal, effectiveFrontId, preferredTurn),
    [effectiveFrontId, preferredTurn, proposal],
  );
  const viewBox = structureViewBox(proposalFaces.length ? proposalFaces : faces).join(" ");
  const pageSize = preview?.page_size_mm;
  const artworkImage = preview?.image_url;
  const hasArtwork = Boolean(artworkImage && pageSize);
  const confirmedAnchor = hasArtwork ? anchor : null;
  const selectedLayerSet = new Set(selectedLayerIds);
  const normalizedLayerIds = structureInput
    ? selectedStructureLayerIds(structureInput, selectedLayerIds)
    : [];
  const currentLayerIds = structureInput?.selected_ids || [];
  const sameLayerSelection = structureInput
    ? sameStructureLayerSelection(structureInput, selectedLayerIds)
    : false;

  function selectProposal(nextId: string) {
    setProposalId(nextId);
    setFrontFaceId("");
    setSubmitError(null);
  }

  function selectFront(nextFaceId: string) {
    if (preferredStructureTurn(proposal, nextFaceId) === null) return;
    setFrontFaceId(nextFaceId);
    setSubmitError(null);
  }

  async function submit() {
    if (!confirmedAnchor || !canConfirmStructure || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const next = await api.confirmMockupStructure(job.id, confirmedAnchor);
      onConfirmed(next);
      message.success("已选择正面，开始生成打样图。");
    } catch (error) {
      setSubmitError(structureConfirmationErrorCopy(error));
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  function toggleLayer(candidateId: string, checked: boolean) {
    setLayerSelectionError(null);
    if (checked && !selectedLayerIds.includes(candidateId) && selectedLayerIds.length >= 16) {
      setLayerSelectionError("一次最多选择 16 个结构图层。");
      return;
    }
    setSelectedLayerIds((current) => {
      if (!checked) return current.filter((id) => id !== candidateId);
      if (current.includes(candidateId)) return current;
      return [...current, candidateId];
    });
  }

  async function submitLayers() {
    if (!canConfirmStructure || selectingLayers || !normalizedLayerIds.length || sameLayerSelection) return;
    setSelectingLayers(true);
    setLayerSelectionError(null);
    try {
      const next = await api.selectMockupStructureInput(job.id, normalizedLayerIds);
      onConfirmed(next);
      message.success("已提交结构层，正在重新识别完整盒型。");
    } catch (error) {
      setLayerSelectionError(error instanceof Error ? error.message : "结构层选择失败，请刷新后重试");
    } finally {
      setSelectingLayers(false);
    }
  }

  const issue = structureIssueCopy(job);
  if (job.structure_status === "review_required" && structureInput?.proposal_layers.length && !proposals.length) {
    const hadSelection = currentLayerIds.length > 0;
    return (
      <div className="structure-confirm structure-input-confirm">
        <Alert
          type={hadSelection ? "warning" : "info"}
          showIcon
          title={hadSelection ? "这组结构层还不能组成完整盒型" : "请选择真实结构线所在图层"}
          description={hadSelection
            ? `${issue} 可以增删下方图层后重新识别；系统仍会检查连续盒身和上下封口。`
            : "系统已盘点本稿中的纯描边图层。请由管理员选择真实刀线、折线所在的一层或多层，再交给拓扑引擎验证。"}
        />
        <div className="structure-confirm-layout structure-input-layout">
          <div className="structure-map-shell structure-input-preview">
            {structureInput.image_url ? (
              <img src={structureInput.image_url} alt="当前 Illustrator 稿件预览" />
            ) : (
              <div className="structure-input-preview-empty">原稿预览暂不可用，请按 Illustrator 中的图层核对。</div>
            )}
            <div className="structure-map-caption">
              <p>只展示原稿帮助核对；系统不会按颜色、白色区域或图层名称自动判断结构。</p>
            </div>
          </div>

          <div className="structure-guide-card">
            <div className="structure-guide">
              <div className="structure-guide-step">
                <span className="structure-step-index">1</span>
                <div>
                  <strong>在 Illustrator 里核对图层</strong>
                  <span>选择实际承载刀线、折线的纯描边层；分开放在多层时可以一起选。</span>
                </div>
              </div>
              <div className="structure-guide-step">
                <span className="structure-step-index">2</span>
                <div>
                  <strong>重新识别完整盒型</strong>
                  <span>所选线条还要通过闭合盒身、上下封口和最终正面确认，不会直接进入 Blender。</span>
                </div>
              </div>
              <div className="structure-layer-list" role="group" aria-label="选择结构图层">
                {structureInput.proposal_layers.map((candidate) => (
                  <Checkbox
                    aria-disabled={!canConfirmStructure || selectingLayers}
                    checked={selectedLayerSet.has(candidate.id)}
                    className="structure-layer-option"
                    disabled={!canConfirmStructure || selectingLayers}
                    key={candidate.id}
                    onChange={(event) => toggleLayer(candidate.id, event.target.checked)}
                  >
                    <strong>{candidate.name}</strong>
                    <small>{candidate.stroke_only_path_count} 条纯描边路径</small>
                  </Checkbox>
                ))}
              </div>
              {structureInput.truncated ? (
                <p className="structure-input-truncated">
                  候选图层超过安全展示上限。若正确图层不在列表里，请先在 Illustrator 整理图层后重新上传。
                </p>
              ) : null}
            </div>
            <div className="structure-confirm-actions">
              {layerSelectionError ? (
                <Alert
                  className="structure-confirm-error"
                  type="error"
                  showIcon
                  title={layerSelectionError}
                />
              ) : (
                <span>
                  {canConfirmStructure
                    ? sameLayerSelection && currentLayerIds.length
                      ? "请增删至少一个图层后再试。"
                      : normalizedLayerIds.length
                        ? `已选 ${normalizedLayerIds.length} 个图层，可以重新识别。`
                        : "请至少选择一个真实结构图层。"
                    : "你可以查看候选；等待管理员选择结构图层。"}
                </span>
              )}
              <Button
                type="primary"
                disabled={
                  !canConfirmStructure
                  || !normalizedLayerIds.length
                  || sameLayerSelection
                  || selectingLayers
                }
                loading={selectingLayers}
                onClick={() => void submitLayers()}
              >
                用所选图层重新识别
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
        title="先看展开图，再选产品正面"
        description={canConfirmStructure
          ? "确认左侧是这次要生成的包装，点击印有品名和主视觉的一面，最后点生成打样图。"
          : "这单可以正常查看；只有管理员能选择产品正面并生成打样图。"}
      />
      <div className="structure-confirm-layout">
        <div className="structure-map-shell">
          <svg className="structure-map" viewBox={viewBox} role="img" aria-label="包装展开图">
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
              const candidateIndex = bodyIndex.get(face.id);
              const isBody = candidateIndex !== undefined;
              const isConfirmable = validTurnsForFace(proposal, face.id).length > 0;
              const isFront = face.id === effectiveFrontId;
              const outline = structurePolygonPoints(face);
              const candidateLabel = isBody ? String.fromCharCode(65 + candidateIndex) : "";
              const label = isFront ? "正面" : candidateLabel;
              const interactive = Boolean(isBody && isConfirmable && canConfirmStructure && hasArtwork);
              return (
                <g
                  key={face.id}
                  className={`${isBody ? "is-body" : "is-cap"}${isFront ? " is-selected" : ""}`}
                  role={interactive ? "button" : undefined}
                  tabIndex={interactive ? 0 : undefined}
                  aria-label={interactive ? `选择 ${candidateLabel} 面作为产品正面` : undefined}
                  aria-pressed={interactive ? isFront : undefined}
                  onClick={interactive ? () => selectFront(face.id) : undefined}
                  onKeyDown={interactive ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectFront(face.id);
                    }
                  } : undefined}
                >
                  {outline ? <polygon points={outline} /> : null}
                  {label ? (
                    <text x={face.centroid_mm[0]} y={face.centroid_mm[1]} dominantBaseline="central">
                      {label}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          <div className="structure-map-caption">
            <p>
              {hasArtwork
                ? "A–D 对应四个可选面。找到印有品名和主视觉的一面。"
                : "原稿预览暂不可用，不能可靠判断正面；请重新识别后再确认。"}
            </p>
            {proposals.length > 1 ? (
              <div className="structure-proposal-nav" aria-label="切换展开图">
                <Button
                  size="small"
                  disabled={proposalIndex === 0}
                  onClick={() => selectProposal(proposals[proposalIndex - 1].id)}
                >
                  上一张
                </Button>
                <span>第 {proposalIndex + 1} 张，共 {proposals.length} 张</span>
                <Button
                  size="small"
                  disabled={proposalIndex === proposals.length - 1}
                  onClick={() => selectProposal(proposals[proposalIndex + 1].id)}
                >
                  下一张
                </Button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="structure-guide-card">
          <div className="structure-guide">
            <div className="structure-guide-step">
              <span className="structure-step-index">1</span>
              <div>
                <strong>看一下展开图</strong>
                <span>确认左侧显示的是这次要生成的包装形状。</span>
              </div>
            </div>

            <div className="structure-guide-step">
              <span className="structure-step-index">2</span>
              <div>
                <strong>选择产品正面</strong>
                <span>通常是印有品名、品牌和主视觉的那一面。</span>
              </div>
            </div>

            <div className="structure-front-choices" aria-label="选择产品正面">
              <div>
                {proposal.body_face_ids.map((faceId, index) => {
                  const selected = faceId === effectiveFrontId;
                  const validTurns = validTurnsForFace(proposal, faceId);
                  return (
                    <Button
                      key={faceId}
                      type={selected ? "primary" : "default"}
                      aria-pressed={selected}
                      disabled={!canConfirmStructure || !hasArtwork || !validTurns.length}
                      onClick={() => selectFront(faceId)}
                    >
                      {String.fromCharCode(65 + index)} 面
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="structure-confirm-actions">
            {submitError ? (
              <Alert
                className="structure-confirm-error"
                type="error"
                showIcon
                title={submitError}
              />
            ) : (
              <span>
                {canConfirmStructure
                  ? confirmedAnchor
                    ? "正面已选，可以生成打样图。"
                    : hasArtwork
                      ? "请在展开图或右侧按钮中选择产品正面。"
                      : "原稿预览不可用，不能确认正面。"
                  : "你可以查看这单；等待管理员选择正面并生成。"}
              </span>
            )}
            <Button
              type="primary"
              disabled={!confirmedAnchor || !canConfirmStructure || submitting}
              loading={submitting}
              onClick={() => void submit()}
            >
              生成打样图
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
