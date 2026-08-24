import { waitLoaderLetters, type WaitKind } from "../pages/waitCard";

/** Generating 圆盘。字母用对照中 / 对红中 / 打样中，不要英文 Generating。 */
export function WaitLoader({ kind }: { kind: WaitKind }) {
  return (
    <div className="wait-loader" aria-hidden>
      {waitLoaderLetters(kind).map((ch, i) => (
        <span key={`${kind}-${i}`} className="wait-loader-letter" style={{ animationDelay: `${i * 0.1}s` }}>
          {ch}
        </span>
      ))}
      <div className="wait-loader-disc" />
    </div>
  );
}
