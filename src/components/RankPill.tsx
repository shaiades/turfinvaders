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

export function RankPill({ rank, size = "sm" }: { rank: string; size?: "sm" | "md" }) {
  const { color, glow, Icon } = rankStyle(rank);
  const pad = size === "md" ? "px-2.5 py-1 text-[11px]" : "px-2 py-0.5 text-[10px]";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border font-display uppercase tracking-widest ${pad}`}
      style={{
        color,
        borderColor: `color-mix(in oklab, ${color} 45%, transparent)`,
        background: `color-mix(in oklab, ${color} 10%, transparent)`,
        boxShadow: `0 0 12px color-mix(in oklab, ${glow} 30%, transparent)`,
      }}
      title={RANK_PERKS[rank] ?? ""}
    >
      <Icon className="w-3 h-3" />
      {rank}
    </span>
  );
}
