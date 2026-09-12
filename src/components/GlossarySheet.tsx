import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * The shorthand decoder (go-live audit 2026-09-09): every abbreviation a
 * canvasser meets on the Leaderboard and Daily Wrap, defined in one
 * phone-usable bottom sheet — the column tooltips are hover-only and dead on
 * the phones this audience actually uses. Definitions are copied from the
 * FleetDispatch column tooltips and pay.ts, never invented; if a term's
 * meaning changes there, change it here.
 */

const SECTIONS: Array<{ heading: string; terms: Array<[string, string]> }> = [
  {
    heading: "Door work",
    terms: [
      ["Drs", "Doors Knocked — knock and not-home pins on the map, plus Mission Log entries"],
      ["Tlk", "Talked To — talked-to, renter, and go-back pins, plus Mission Log entries"],
      ["NI", "Not Interested — NI pins from the field map (no Mission Log field)"],
      [
        "Rnt",
        "Renters — Renter pins (tally key or map) plus Mission Log; each also counts under Tlk",
      ],
    ],
  },
  {
    heading: "Leads (funnel half)",
    terms: [
      ["Sub", "Submitted — actioned leads, credited to the day they were submitted"],
      ["Con", "Confirmed — submitted leads that got confirmed (the pipeline)"],
      ["Fut", "Future — leads set for a future date (incl. reconfirms)"],
      ["BO", "Blowout at confirmation — the lead died before running (incl. N/As)"],
    ],
  },
  {
    heading: "At the table (blocks half)",
    terms: [
      ["Lds", "Total leads run on blocks, credited to the day the card ran"],
      ["Sit", "A sit — the demo happened at the table (sales split out below)"],
      ["RS", "Reset — rescheduled to run again"],
      ["BO", "Blowout at the door — no demo happened (different from the funnel BO)"],
      ["CTC", "Couldn't contact"],
      ["NC", "Non-Core product"],
      ["OL", "One Leg (one decision-maker home) / Outside Lead"],
      ["Sal", "Sale"],
    ],
  },
  {
    heading: "Scoring",
    terms: [
      ["Points", "PM = 1 pt · Sale = 2 pts. Points drive your hourly tier and the leaderboard."],
      ["PM", "Pitch-miss sit — you sat the demo, no sale (worth 1 point)"],
      ["Volume", "Confirmed sale dollars in the selected range"],
    ],
  },
  {
    heading: "Culture",
    terms: [
      ["Doughnut 🍩", "A zero-lead day you were clocked in for — days off never count"],
      ["Freezer 🚨", "Two clocked-in zero days in a row — the suspension watch list"],
      ["Remote Drop", "A pin dropped ~20+ yards from where you stand — flagged, never counts"],
      ["SCCE", "The company — your rank ladder. Watch “Who is SCCE” in Learn."],
    ],
  },
];

export type GlossarySections = Array<{ heading: string; terms: Array<[string, string]> }>;

export function GlossarySheet({
  open,
  onOpenChange,
  sections = SECTIONS,
  title = "What the shorthand means",
  accentClass = "text-neon",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Override for non-canvasser vocabularies (Close Kombat passes the
   *  Monday column language); default = the canvasser terms above. */
  sections?: GlossarySections;
  title?: string;
  accentClass?: string;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle className={`font-display text-sm uppercase tracking-widest ${accentClass}`}>
            {title}
          </SheetTitle>
        </SheetHeader>
        <div className="pt-2 pb-4 space-y-5">
          {sections.map((s) => (
            <div key={s.heading}>
              <div className="font-display text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
                {s.heading}
              </div>
              <dl className="space-y-1.5">
                {s.terms.map(([term, def]) => (
                  <div key={`${s.heading}-${term}`} className="flex gap-3 text-sm">
                    <dt className={`font-display text-[11px] ${accentClass} shrink-0 w-16 pt-0.5`}>
                      {term}
                    </dt>
                    <dd className="text-foreground/85 leading-snug">{def}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
