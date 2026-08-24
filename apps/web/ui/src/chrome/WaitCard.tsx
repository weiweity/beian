import { useEffect, useState } from "react";
import { api } from "../api";
import { feishuReadyFromHealth, waitCardActiveSteps, waitCardCopy, type WaitKind } from "../pages/waitCard";
import { WaitLoader } from "./WaitLoader";

type Job = "对照" | "对红" | "打样";

const STEPS: Record<Job, string[]> = {
  对照: ["读 Excel", "OCR 包装", "标疑点"],
  对红: ["读 Excel", "OCR 包装", "标疑点"],
  打样: ["读平面", "建盒", "渲染白底", "导出 GLB"],
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
  stage?: string;
  stageLabel?: string;
  etaS?: number;
  hint?: string;
  jobStatus?: string;
  feishuReady?: boolean;
};

export function WaitCard({
  job,
  activeSteps,
  queueAhead,
  stage,
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

  const steps = STEPS[job];
  const kind = waitKind(job);
  const copy = waitCardCopy({
    kind,
    job_status: jobStatus,
    job_stage_label: stageLabel,
    job_eta_s: etaS,
    queue_ahead: queueAhead,
    feishuReady: ready,
  });
  const stepsOn = activeSteps != null ? activeSteps : waitCardActiveSteps(kind, jobStatus, stage, stageLabel);
  return (
    <div className="wait-wrap">
      <div className="wait-card" role="status" aria-live="polite">
        <WaitLoader kind={kind} />
        <h2 className="wait-title">{copy.title}</h2>
        <p className="wait-eta">{copy.eta}</p>
        <p className="wait-hint">{hint ?? copy.hint}</p>
        <div className="wait-bar" aria-hidden>
          <span className={job === "打样" ? "wait-bar-fill is-slow" : "wait-bar-fill"} />
        </div>
        <div className="wait-steps">
          {steps.map((s, i) => (
            <span key={s} className={i < stepsOn ? "wait-chip is-on" : "wait-chip"}>
              {s}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
