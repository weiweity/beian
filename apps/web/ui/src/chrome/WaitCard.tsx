type Job = "对照" | "打样";

const COPY: Record<
  Job,
  { title: string; eta: string; hint: string; steps: string[]; orbit: string }
> = {
  对照: {
    title: "对照中",
    eta: "大约还要 40 秒",
    hint: "读表 + OCR 包装。机审只标疑点，不会自动过审。",
    steps: ["读 Excel", "OCR 包装", "标疑点"],
    orbit: "/brand/ui/fox-orbit.svg",
  },
  打样: {
    title: "打样中",
    eta: "大约还要 4 分钟",
    hint: "本机 Blender。白底不要带尺寸标注再交备案。",
    steps: ["读平面", "建盒", "渲染白底", "导出 GLB"],
    orbit: "/brand/ui/fox-orbit-pack.svg",
  },
};

type Props = {
  job: Job;
  activeSteps?: number;
};

export function WaitCard({ job, activeSteps = 2 }: Props) {
  const copy = COPY[job];
  return (
    <div className="wait-wrap">
      <div className="wait-card" role="status" aria-live="polite">
        <div className="fox-ball">
          <img className="fox-orbit" src={copy.orbit} alt="" width={200} height={200} />
          <img className="fox-body" src="/brand/ui/fox-body.svg" alt="" width={148} height={148} />
          <img className="fox-face" src="/brand/logo-mark.png" alt="" width={88} height={88} />
        </div>
        <h2 className="wait-title">{copy.title}</h2>
        <p className="wait-eta">{copy.eta}</p>
        <p className="wait-hint">{copy.hint}</p>
        <div className="wait-bar" aria-hidden>
          <span className={job === "打样" ? "wait-bar-fill is-slow" : "wait-bar-fill"} />
        </div>
        <div className="wait-steps">
          {copy.steps.map((s, i) => (
            <span key={s} className={i < activeSteps ? "wait-chip is-on" : "wait-chip"}>
              {s}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
