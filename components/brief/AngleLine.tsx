// SPEC §7 "Brief components", AngleLine (the siblings' Aside): "Angle →", the text, then its basis: the source's
// refs and "(<shortDate(as_of)>)", or for a metric "Gap metrics, data to <shortDate(as_of)> UTC" linking #gap;
// "Counter-point:" with its text and refs; "Bears on: <claim_id> <claim_text>" when set. The text and the
// counter-point are counted (§4.12 model fields in the total); the labels and the claim are not.
import type { Angle } from "@/lib/schema/draft-brief";
import { shortDate } from "@/lib/format";
import { Counted } from "@/components/ui/Counted";
import { PlainText } from "@/components/ui/PlainText";
import { Aside } from "./brief-parts";
import { SourceRefs, type SourceIndex } from "./sources";

export interface AngleLineProps {
  angle: Angle;
  index: SourceIndex;
}

export function AngleLine({ angle, index }: AngleLineProps) {
  return (
    <Aside label="Angle" className="mt-4 border-l-2 border-rule pl-3">
      <p className="prose-serif text-[16px] md:text-[17px]">
        <Counted text={angle.text} />{" "}
        {angle.source_id ? (
          <>
            <SourceRefs ids={[angle.source_id]} index={index} />{" "}
            <span className="font-mono text-[11px] text-muted">({shortDate(angle.as_of)})</span>
          </>
        ) : (
          <a href="#gap" className="font-mono text-[11px] text-muted">Gap metrics, data to {shortDate(angle.as_of)} UTC</a>
        )}
      </p>
      <p className="mt-1.5 text-[14px] leading-[24px] text-soft">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Counter-point: </span>
        <Counted text={angle.counterpoint} /> <SourceRefs ids={angle.counterpoint_source_ids} index={index} />
      </p>
      {angle.claim_id ? (
        <p className="mt-1.5 text-[13px] text-muted">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em]">Bears on: </span>
          <span className="font-mono text-[12px]"><PlainText text={angle.claim_id} /></span>
          {angle.claim_text ? <> <PlainText text={angle.claim_text} /></> : null}
        </p>
      ) : null}
    </Aside>
  );
}
