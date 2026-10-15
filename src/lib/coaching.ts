// Coaching flag — the pure math (conversion audit 2026-10-15, Phase 2 §4).
// Compares a canvasser's last-14-day rates to the team and names ONE of four
// states, so a captain knows the move without reading a spreadsheet:
//
//   not_logging   setting leads but barely logging doors — fix the logging
//                 first, every other rate is fiction until then.
//   ride_along    grinding doors (300+/14d) but talk→lead under 4% — the
//                 audit's conversion gap; pair them with a top converter.
//   knock_more    converts at/above team rate but knocks well under team
//                 volume — more doors is pure upside.
//   on_track      everything else (including too-new-to-judge).
//
// Checked in that order — not_logging outranks everything (bad data first),
// ride_along outranks knock_more (fix conversion before volume).
// Thresholds are owner-set (audit brief); verify:coaching pins them.
// Doors are only trustworthy from DOORS_TRACKED_SINCE (src/lib/funnel.ts) —
// callers must not feed windows that start before it.

export type CoachingStats = {
  /** Doors knocked in the window. */
  drs: number;
  /** Conversations (people_talked_to). */
  tlk: number;
  /** Leads set (leads_called_in — the Monday-card credit). */
  ld: number;
  /** Days with door work in the window (doors/day denominator). */
  activeDays: number;
};

export type TeamBaseline = {
  /** Team talk→lead rate: Σld / Σtlk over active knockers. */
  talkLead: number;
  /** Team talk rate: Σtlk / Σdrs. */
  talkRate: number;
  /** Team doors per active day: Σdrs / Σdays. */
  doorsPerDay: number;
};

export type CoachingFlagKey = "not_logging" | "ride_along" | "knock_more" | "on_track";

export type CoachingFlag = {
  key: CoachingFlagKey;
  label: string;
  /** The move, in one line. */
  hint: string;
};

// §4 thresholds (owner brief, 2026-10-15).
export const RIDE_ALONG_MIN_DOORS = 300; // 14-day doors that count as "knocks plenty"
export const RIDE_ALONG_MAX_TALK_LEAD = 0.04; // under 4% talk→lead = converts low
export const NOT_LOGGING_MIN_LEADS = 3; // leads set while…
export const NOT_LOGGING_MAX_DOORS = 100; // …doors stay implausibly low for 14 days
export const KNOCK_MORE_DOOR_RATIO = 0.75; // doors/day under 75% of team
export const MIN_DOORS_TO_JUDGE = 50; // below this, rates are noise → on_track

export const FLAG_COPY: Record<CoachingFlagKey, Omit<CoachingFlag, "key">> = {
  not_logging: {
    label: "Not logging doors",
    hint: "Leads are landing but the doors aren't — get the map habit down first.",
  },
  ride_along: {
    label: "Knocks plenty, converts low",
    hint: "Volume is there, the door isn't closing — book a ride-along.",
  },
  knock_more: {
    label: "Converts well, knock more",
    hint: "The pitch works — more doors is pure money.",
  },
  on_track: {
    label: "On track",
    hint: "Rates hold up against the team — keep rolling.",
  },
};

export const talkLeadRate = (s: Pick<CoachingStats, "tlk" | "ld">): number =>
  s.tlk > 0 ? s.ld / s.tlk : 0;

export const doorsPerDay = (s: Pick<CoachingStats, "drs" | "activeDays">): number =>
  s.activeDays > 0 ? s.drs / s.activeDays : 0;

/** Team baseline over everyone with door work in the window. */
export function computeTeamBaseline(rows: readonly CoachingStats[]): TeamBaseline {
  let drs = 0,
    tlk = 0,
    ld = 0,
    days = 0;
  for (const r of rows) {
    if (r.drs <= 0) continue;
    drs += r.drs;
    tlk += r.tlk;
    ld += r.ld;
    days += r.activeDays;
  }
  return {
    talkLead: tlk > 0 ? ld / tlk : 0,
    talkRate: drs > 0 ? tlk / drs : 0,
    doorsPerDay: days > 0 ? drs / days : 0,
  };
}

export function computeCoachingFlag(s: CoachingStats, team: TeamBaseline): CoachingFlag {
  let key: CoachingFlagKey = "on_track";
  if (s.ld >= NOT_LOGGING_MIN_LEADS && s.drs < NOT_LOGGING_MAX_DOORS) {
    key = "not_logging";
  } else if (s.drs >= RIDE_ALONG_MIN_DOORS && talkLeadRate(s) < RIDE_ALONG_MAX_TALK_LEAD) {
    key = "ride_along";
  } else if (
    s.drs >= MIN_DOORS_TO_JUDGE &&
    talkLeadRate(s) >= Math.max(RIDE_ALONG_MAX_TALK_LEAD, team.talkLead) &&
    (team.doorsPerDay <= 0 || doorsPerDay(s) < KNOCK_MORE_DOOR_RATIO * team.doorsPerDay)
  ) {
    key = "knock_more";
  }
  return { key, ...FLAG_COPY[key] };
}

export type ConverterRow = CoachingStats & { id: string; name: string };

// A converter only counts for ride-along pairing with a real sample.
export const PARTNER_MIN_TALKS = 30;
export const PARTNER_MIN_LEADS = 3;

/** The window's top 3 converters by talk→lead (sample-gated) — ride-along
 *  partner candidates. `excludeId` drops the flagged canvasser themself. */
export function topConverters(rows: readonly ConverterRow[], excludeId?: string): ConverterRow[] {
  return rows
    .filter((r) => r.id !== excludeId && r.tlk >= PARTNER_MIN_TALKS && r.ld >= PARTNER_MIN_LEADS)
    .sort((a, b) => talkLeadRate(b) - talkLeadRate(a) || b.ld - a.ld)
    .slice(0, 3);
}
