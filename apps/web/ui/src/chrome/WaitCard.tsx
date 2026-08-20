import { useEffect, useState } from "react";
import { api } from "../api";
import { feishuReadyFromHealth, waitCardCopy, type WaitKind } from "../pages/waitCard";

type Job = "对照" | "对红" | "打样";

const VISUAL: Record<Job, { steps: string[]; orbit: string }> = {
  对照: {
    steps: ["读 Excel", "OCR 包装", "标疑点"],
    orbit: "/brand/ui/fox-orbit.svg",
  },
  对红: {
    steps: ["读 Excel", "OCR 包装", "标疑点"],
    orbit: "/brand/ui/fox-orbit.svg",
  },
  打样: {
    steps: ["读平面", "建盒", "渲染白底", "导出 GLB"],
    orbit: "/brand/ui/fox-orbit-pack.svg",
  },
};

function waitKind(job: Job): WaitKind {
  if (job === "对红") return "rework";
  if (job === "打样") return "mockup";
  return "compare";
}

type Props = {
  job: Job;
  activeSteps?: number;
  queueAhead?: number;
  stageLabel?: string;
  etaS?: number;
  hint?: string;
  jobStatus?: string;
  feishuReady?: boolean;
};

export function WaitCard({
  job,
  activeSteps = 2,
  queueAhead,
  stageLabel,
  etaS,
  hint,
  jobStatus,
  feishuReady,
}: Props) {
  const [ready, setReady] = useState(Boolean(feishuReady));
  useEffect(() => {
    if (feishuReady != null) {
      setReady(feishuReady);
      return;
    }
    let cancelled = false;
    void api
      .health()
      .then((h) => {
        if (!cancelled) setReady(feishuReadyFromHealth(h));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [feishuReady]);

  const visual = VISUAL[job];
  const copy = waitCardCopy({
    kind: waitKind(job),
    job_status: jobStatus,
    job_stage_label: stageLabel,
    job_eta_s: etaS,
    queue_ahead: queueAhead,
    feishuReady: ready,
  });
  return (
    <div className="wait-wrap">
      <div className="wait-card" role="status" aria-live="polite">
        <div className="fox-ball">
          <img className="fox-orbit" src={visual.orbit} alt="" width={200} height={200} />
          <img className="fox-body" src="/brand/ui/fox-body.svg" alt="" width={148} height={148} />
          <img className="fox-face" src="/brand/logo-mark.png" alt="" width={88} height={88} />
        </div>
        <h2 className="wait-title">{copy.title}</h2>
        <p className="wait-eta">{copy.eta}</p>
        <p className="wait-hint">{hint ?? copy.hint}</p>
        <div className="wait-bar" aria-hidden>
          <span className={job === "打样" ? "wait-bar-fill is-slow" : "wait-bar-fill"} />
        </div>
        <div className="wait-steps">
          {visual.steps.map((s, i) => (
            <span key={s} className={i < activeSteps ? "wait-chip is-on" : "wait-chip"}>
              {s}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
