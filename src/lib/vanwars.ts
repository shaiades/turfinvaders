// Van Wars scoring — the pure shaping for the weekly street race (reworked in
// the 2026-10-15 conversion audit: the race now pays the behavior we want
// more of). A van's WAR SCORE is LEADS SET per ACTIVE KNOCKER — someone who
// logged doors that week — with total leads as the tiebreak, so a small crew
// that converts out-runs a big crew that coasts. The Confirmation/office crew
// and the no-van "Unassigned" bucket never race, and a crew needs
// MIN_CREW_TO_RANK active knockers to hold a rank (smaller crews still show,
// greyed, so nobody's work disappears). Pure + unit-tested
// (scripts/verify-vanwars.ts, `npm run verify:vanwars`).

import { sitRate, type SitRate } from "@/lib/canvasserPay";

/** Crews below this many active knockers show but can't rank or win. */
export const MIN_CREW_TO_RANK = 3;

/** A knocker is ACTIVE in the race when they logged door work in range. */
export const isActiveKnocker = (drs: number): boolean => drs > 0;

/** Crews that never race: the office/Confirmation desk. */
export const isDeskCrew = (teamName: string | null | undefined): boolean =>
  /confirm/i.test(teamName ?? "");

/** One knocker's contribution to their van's war score. */
export type VanWarRowInput = {
  /** Team identity — the grouping key. null = no van ("Unassigned"): excluded. */
  teamId: string | null;
  /** Crew display name: the captain's name, falling back to the team name. */
  label: string;
  /** The raw team name — the desk-crew (Confirmation) exclusion keys on it. */
  teamName: string | null;
  teamColor: string | null;
  /** Leads SET in range (generation-day axis) — the scoring metric. */
  ld: number;
  /** Doors knocked in range — the active-knocker gate. */
  drs: number;
  pts: number;
  vol: number;
  /** Funnel sits (closer-outcome) and the leads they were set over. */
  sitSits: number;
  sitLeads: number;
};

export type VanWarStanding = {
  /** The crew's team id — lets the captain card find its own crew. */
  teamId: string | null;
  name: string;
  color: string;
  /** The ranking score: leads set per active knocker. */
  war: number;
  /** Total leads set across the crew (the tiebreak + the display total). */
  lds: number;
  /** ACTIVE knockers (logged doors in range) — the per-head divisor. */
  knockers: number;
  /** False while the crew is under MIN_CREW_TO_RANK active knockers — shown
   *  but unranked, and never crowned. */
  ranked: boolean;
  /** Total weekly points (display only — the race scores leads). */
  pts: number;
  /** Credited sale volume, net of cancels. */
  vol: number;
  /** Crew funnel sit rate + grade (the health badge). */
  sit: SitRate;
};

/**
 * Roll knocker rows up into ranked crew standings for the week's race.
 * War = leads set ÷ active knockers; ties break on total leads, then funnel
 * sit rate, then points, then dollars. Unassigned (no team) and the
 * Confirmation desk are dropped before grouping; crews under MIN_CREW_TO_RANK
 * active knockers sort after every ranked crew. Leads from a crew's inactive
 * members (no doors logged) still count toward the crew total — only the
 * divisor is active-gated, so parking riders on the bench can't juice a
 * per-head score.
 */
export function buildVanWarStandings(rows: readonly VanWarRowInput[]): VanWarStanding[] {
  type Acc = {
    teamId: string | null;
    name: string;
    color: string;
    lds: number;
    knockers: number;
    pts: number;
    vol: number;
    sits: number;
    leads: number;
  };
  const map = new Map<string, Acc>();
  for (const r of rows) {
    if (r.teamId === null) continue; // no van — the Unassigned bucket never races
    if (isDeskCrew(r.teamName)) continue; // Confirmation/office desk never races
    const key = r.teamId;
    const v: Acc = map.get(key) ?? {
      teamId: r.teamId,
      name: r.label,
      color: r.teamColor ?? "#8a8f99",
      lds: 0,
      knockers: 0,
      pts: 0,
      vol: 0,
      sits: 0,
      leads: 0,
    };
    v.lds += r.ld;
    if (isActiveKnocker(r.drs)) v.knockers += 1;
    v.pts += r.pts;
    v.vol += r.vol;
    v.sits += r.sitSits;
    v.leads += r.sitLeads;
    map.set(key, v);
  }
  return [...map.values()]
    .map((v) => ({
      teamId: v.teamId,
      name: v.name,
      color: v.color,
      war: v.knockers > 0 ? v.lds / v.knockers : 0,
      lds: v.lds,
      knockers: v.knockers,
      ranked: v.knockers >= MIN_CREW_TO_RANK,
      pts: v.pts,
      vol: v.vol,
      sit: sitRate(v.sits, v.leads),
    }))
    .sort(
      (a, b) =>
        Number(b.ranked) - Number(a.ranked) ||
        b.war - a.war ||
        b.lds - a.lds ||
        (b.sit.rate ?? 0) - (a.sit.rate ?? 0) ||
        b.pts - a.pts ||
        b.vol - a.vol,
    );
}
