// STUB (SPEC §7 "Page frame", SampleBanner). Owner: pages lane. The siblings' banner (role="note",
// --sample-bg/--sample-fg): "Preview data, not the published brief · <dir in mono>". The layout shows it,
// with robots noindex, only in sample mode (isSampleData()).

export interface SampleBannerProps {
  /** contentDir(), as given. */
  dir: string;
}

export function SampleBanner({ dir }: SampleBannerProps) {
  return (
    <div role="note" className="px-4 py-2 text-center font-mono text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ background: "var(--sample-bg)", color: "var(--sample-fg)" }}>
      Preview data, not the published brief · <span className="font-mono normal-case">{dir}</span>
    </div>
  );
}
