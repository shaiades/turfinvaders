import { useState } from "react";
import { Shield, Star, Sparkles, Crown, Trophy } from "lucide-react";

export const RANK_ORDER = [
  "Jr. Silver",
  "Sr. Silver",
  "Jr. Gold",
  "Sr. Gold",
  "Jr. Diamond",
  "Sr. Diamond",
  "Captain",
] as const;

export type Rank = (typeof RANK_ORDER)[number] | string;

export const RANK_PERKS: Record<string, string> = {
  "Jr. Silver": "Back of van, no music vote",
  "Sr. Silver": "Quickstart Hat, Back of van",
  "Jr. Gold": "G pin, Eligible for front, music vote",
  "Sr. Gold": "Premium polo, SG Pin",
  "Jr. Diamond": "Premium Diamonds hat, Jr Diamond Pin, Front seat, control music",
  "Sr. Diamond": "Premium Jacket, reserved front seat",
  Captain: "Top of ladder · Crew leadership",
};

function rankStyle(rank: string) {
  switch (rank) {
    case "Captain":
      return { color: "#ff66c4", glow: "#ff66c4", Icon: Crown };
    case "Sr. Diamond":
      return { color: "#22d3ee", glow: "#22d3ee", Icon: Sparkles };
    case "Jr. Diamond":
      return { color: "#67e8f9", glow: "#67e8f9", Icon: Sparkles };
    case "Sr. Gold":
      return { color: "#fbbf24", glow: "#fbbf24", Icon: Trophy };
    case "Jr. Gold":
      return { color: "#facc15", glow: "#facc15", Icon: Star };
    case "Sr. Silver":
      return { color: "#cbd5e1", glow: "#cbd5e1", Icon: Star };
    default:
      return { color: "#94a3b8", glow: "#94a3b8", Icon: Shield };
  }
}

export function RankPill({
  rank,
  size = "sm",
  tappable = false,
}: {
  rank: string;
  size?: "sm" | "md";
  /** Tap → perks popover (this rank's + the next rung's). The old title
   *  tooltip was hover-only — invisible to the phone audience the ladder
   *  exists to motivate. Leave false inside other interactive elements. */
  tappable?: boolean;
}) {
  const { color, glow, Icon } = rankStyle(rank);
  const [open, setOpen] = useState(false);
  const pad = size === "md" ? "px-2.5 py-1 text-[11px]" : "px-2 py-0.5 text-[10px]";
  const style = {
    color,
    borderColor: `color-mix(in oklab, ${color} 45%, transparent)`,
    background: `color-mix(in oklab, ${color} 10%, transparent)`,
    boxShadow: `0 0 12px color-mix(in oklab, ${glow} 30%, transparent)`,
  };
  const cls = `inline-flex items-center gap-1.5 rounded border font-display uppercase tracking-widest ${pad}`;

  if (!tappable) {
    return (
      <span className={cls} style={style} title={RANK_PERKS[rank] ?? ""}>
        <Icon className="w-3 h-3" />
        {rank}
      </span>
    );
  }

  const idx = (RANK_ORDER as readonly string[]).indexOf(rank);
  const next = idx >= 0 && idx < RANK_ORDER.length - 1 ? RANK_ORDER[idx + 1] : null;
  return (
    <span className="relative inline-flex">
      <button type="button" onClick={() => setOpen((o) => !o)} className={cls} style={style}>
        <Icon className="w-3 h-3" />
        {rank}
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-[10010] mt-1.5 w-60 rounded-lg border border-border bg-surface/95 p-3 text-left shadow-arcade backdrop-blur"
          onClick={() => setOpen(false)}
        >
          <div className="text-[9px] font-display uppercase tracking-widest" style={{ color }}>
            {rank} perks
          </div>
          <div className="mt-1 text-xs text-foreground/90">{RANK_PERKS[rank] ?? "—"}</div>
          {next && (
            <>
              <div className="mt-2.5 text-[9px] font-display uppercase tracking-widest text-muted-foreground">
                Next · {next}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{RANK_PERKS[next]}</div>
            </>
          )}
        </div>
      )}
    </span>
  );
}
