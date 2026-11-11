// SPEC §7 "Page frame", SampleBanner: the siblings' banner (role="note", --sample-bg/--sample-fg), reading
// "Preview data, not the published brief · <dir in mono>". The layout shows it, with robots noindex, only in
// sample mode (isSampleData(), §6). Owner: pages lane.

export interface SampleBannerProps {
  /** contentDir(), as given. */
  dir: string;
}

export function SampleBanner({ dir }: SampleBannerProps) {
  return (
    <div
      role="note"
      className="px-4 py-2 text-center font-sans text-[11px] font-semibold uppercase tracking-[0.14em] [overflow-wrap:anywhere]"
      style={{ background: "var(--sample-bg)", color: "var(--sample-fg)" }}
    >
      Preview data, not the published brief · <span className="font-mono font-normal normal-case tracking-normal">{dir}</span>
    </div>
  );
}
