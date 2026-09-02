import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Checkbox } from "antd";
import { api, type MockupJob } from "../api";
import {
  preferredStructureTurn,
  sameStructureLayerSelection,
  selectedStructureLayerIds,
  defaultStructureLayerIds,
  selectedStructureAnchor,
  structureConfirmationErrorCopy,
  structureIssueCopy,
  illustratorLayerPreviewD,
  structurePolygonPoints,
  structureProposalHasRealPolygons,
  structureViewBox,
  validTurnsForFace,
} from "./mockupStructure";

const STRUCTURE_INPUT_GUIDE_KEY = "beian:structure-input-guide:v1";
const STRUCTURE_PREVIEW_ZOOMS = [1, 1.5, 2, 3, 4, 6] as const;

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
    () => (structureInput ? defaultStructureLayerIds(structureInput) : []),
  );
  const [selectingLayers, setSelectingLayers] = useState(false);
  const [layerSelectionError, setLayerSelectionError] = useState<string | null>(null);
  const [hoveredLayerId, setHoveredLayerId] = useState("");
  const [previewedPlateId, setPreviewedPlateId] = useState("");
  const [previewScale, setPreviewScale] = useState(1);
  const [showLayerGuide, setShowLayerGuide] = useState(false);
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
  const layerPreview = structureInput?.preview;
  const layerPreviewPaths = useMemo(
    () => new Map(
      (layerPreview?.layers || []).map((layer) => [layer.candidate_id, illustratorLayerPreviewD(layer.paths)]),
    ),
    [layerPreview],
  );
  const previewTruncatedIds = useMemo(
    () => new Set((layerPreview?.layers || []).filter((layer) => layer.truncated).map((layer) => layer.candidate_id)),
    [layerPreview],
  );

  useEffect(() => {
    if (!canConfirmStructure || currentLayerIds.length || !structureInput?.proposal_layers.length) return;
    try {
      setShowLayerGuide(window.localStorage.getItem(STRUCTURE_INPUT_GUIDE_KEY) !== "done");
    } catch {
      setShowLayerGuide(true);
    }
  }, [canConfirmStructure, currentLayerIds.length, job.id, structureInput?.proposal_layers.length]);

  function dismissLayerGuide() {
    setShowLayerGuide(false);
    try {
      window.localStorage.setItem(STRUCTURE_INPUT_GUIDE_KEY, "done");
    } catch {
      // The guide remains safely dismissible when storage is unavailable.
    }
  }

  function changePreviewScale(direction: -1 | 1) {
    const currentIndex = STRUCTURE_PREVIEW_ZOOMS.findIndex((scale) => scale === previewScale);
    const nextIndex = Math.min(
      STRUCTURE_PREVIEW_ZOOMS.length - 1,
      Math.max(0, (currentIndex < 0 ? 0 : currentIndex) + direction),
    );
    setPreviewScale(STRUCTURE_PREVIEW_ZOOMS[nextIndex]);
  }

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
    if (checked) dismissLayerGuide();
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
          title={hadSelection ? "这组线组不成花盒" : "请选择刀版或刀线所在图层"}
          description={hadSelection
            ? `${issue} 可以只留刀版再识别；系统仍会检查连续盒身和上下封口。`
            : "系统已盘点本稿中的刀版/刀线和描边层。请勾选「刀版」或「刀线」，再交给拓扑引擎验证。烫金等工艺板只用来看，不会当成刀线。"}
        />
        <div className="structure-confirm-layout structure-input-layout">
          <div className="structure-map-shell structure-input-preview">
            <div className="structure-input-preview-toolbar" aria-label="结构图层预览缩放">
              <span>高清分层预览</span>
              <Button
                aria-label="缩小结构预览"
                disabled={previewScale === STRUCTURE_PREVIEW_ZOOMS[0]}
                onClick={() => changePreviewScale(-1)}
                size="small"
              >
                −
              </Button>
              <span className="structure-input-preview-scale">{Math.round(previewScale * 100)}%</span>
              <Button
                aria-label="放大结构预览"
                disabled={previewScale === STRUCTURE_PREVIEW_ZOOMS[STRUCTURE_PREVIEW_ZOOMS.length - 1]}
                onClick={() => changePreviewScale(1)}
                size="small"
              >
                +
              </Button>
              <Button
                aria-label="适应结构预览"
                disabled={previewScale === 1}
                onClick={() => setPreviewScale(1)}
                size="small"
              >
                适应
              </Button>
            </div>
            <div className="structure-input-preview-viewport">
              <div
                className="structure-input-preview-stage"
                style={{ width: `${previewScale * 100}%`, height: `${previewScale * 100}%` }}
              >
                {structureInput.image_url && layerPreview ? (
                  <svg
                    aria-label="当前 Illustrator 稿件与所选图层路径"
                    className="structure-input-layer-map"
                    preserveAspectRatio="xMidYMid meet"
                    role="img"
                    viewBox={`0 0 ${layerPreview.page_size_points[0]} ${layerPreview.page_size_points[1]}`}
                  >
                    <image
                      height={layerPreview.page_size_points[1]}
                      href={structureInput.image_url}
                      preserveAspectRatio="none"
                      width={layerPreview.page_size_points[0]}
                      x="0"
                      y="0"
                    />
                    {layerPreview.layers.map((layer) => {
                      const selected = selectedLayerSet.has(layer.candidate_id);
                      const hovered = hoveredLayerId === layer.candidate_id
                        || previewedPlateId === layer.candidate_id;
                      const path = layerPreviewPaths.get(layer.candidate_id);
                      if ((!selected && !hovered) || !path) return null;
                      return (
                        <g
                          className={selected ? "is-selected" : "is-hovered"}
                          data-candidate-id={layer.candidate_id}
                          key={layer.candidate_id}
                        >
                          <path className="structure-input-layer-halo" d={path} />
                          <path className="structure-input-layer-stroke" d={path} />
                        </g>
                      );
                    })}
                  </svg>
                ) : structureInput.image_url ? (
                  <img src={structureInput.image_url} alt="当前 Illustrator 稿件预览" />
                ) : (
                  <div className="structure-input-preview-empty">原稿预览暂不可用，请按 Illustrator 中的图层核对。</div>
                )}
              </div>
            </div>
            <div className="structure-map-caption">
              <p>
                {layerPreview
                  ? "移到或勾选右侧图层，左侧会涂亮真实路径。紫色只表示当前选择；系统不会按颜色、白色区域或图层名称判断结构。"
                  : "这份稿没有分层路径快照。重新识别后才能在勾选时涂亮真实刀线；系统不会伪造路径。"}
              </p>
            </div>
          </div>

          <div className="structure-guide-card">
            {showLayerGuide ? (
              <div
                aria-label="三步完成结构确认"
                aria-modal="false"
                className="structure-input-coachmark"
                role="dialog"
              >
                <strong>三步完成结构确认</strong>
                <span>1 选择候选图层　2 看左侧真实路径涂亮　3 点右下角重新识别完整盒型</span>
                <Button onClick={dismissLayerGuide} size="small" type="primary">开始选择</Button>
              </div>
            ) : null}
            <div className="structure-guide">
              <div className="structure-guide-step">
                <span className="structure-step-index">1</span>
                <div>
                  <strong>点选图层，看左侧真实路径涂亮</strong>
                  <span>选择实际承载刀线、折线的纯描边层；鼠标移入可临时预览，分开放在多层时可以一起选。</span>
                </div>
              </div>
              <div className="structure-guide-step">
                <span className="structure-step-index">2</span>
                <div>
                  <strong>点右下角重新识别完整盒型</strong>
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
                    onFocus={() => setHoveredLayerId(candidate.id)}
                    onChange={(event) => toggleLayer(candidate.id, event.target.checked)}
                    onMouseEnter={() => setHoveredLayerId(candidate.id)}
                    onMouseLeave={() => setHoveredLayerId("")}
                  >
                    <strong>{candidate.name}</strong>
                    <small>
                      {candidate.stroke_only_path_count} 条纯描边路径
                      {layerPreviewPaths.has(candidate.id)
                        ? previewTruncatedIds.has(candidate.id) ? " · 预览已安全截取" : " · 可在左侧涂亮"
                        : " · 本次无分层预览"}
                    </small>
                  </Checkbox>
                ))}
              </div>
              {structureInput.preview_plates?.length ? (
                <div className="structure-preview-plates" role="group" aria-label="工艺与印刷板">
                  <strong>工艺 / 印刷板</strong>
                  <span>点一下只在左侧涂亮查看，不会当成刀线折盒。</span>
                  {structureInput.preview_plates.map((plate) => (
                    <button
                      aria-pressed={previewedPlateId === plate.id}
                      className={hoveredLayerId === plate.id || previewedPlateId === plate.id ? "is-hovered" : ""}
                      data-candidate-id={plate.id}
                      key={plate.id}
                      onBlur={() => setHoveredLayerId("")}
                      onClick={() => setPreviewedPlateId((current) => (current === plate.id ? "" : plate.id))}
                      onFocus={() => setHoveredLayerId(plate.id)}
                      onMouseEnter={() => setHoveredLayerId(plate.id)}
                      onMouseLeave={() => setHoveredLayerId("")}
                      type="button"
                    >
                      {plate.name}
                    </button>
                  ))}
                </div>
              ) : null}
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
                    : "当前账号不能选择结构图层。"}
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
                重新识别完整盒型
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
          : "当前账号不能选择产品正面或生成打样图。"}
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
                  : "可以查看这单，但不能提交。"}
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
