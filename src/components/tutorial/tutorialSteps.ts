/**
 * Per-page discovery tours for canvassers. Each screen has its own short
 * tour that auto-pops the FIRST time the canvasser opens that screen
 * (owner decision 2026-09-08: contextual tips as pages are discovered, not
 * one long day-one walkthrough). The very first tour ever shown gets the
 * welcome/HUD/help bracket wrapped around it; the header "?" replays the
 * current screen's tips on demand.
 *
 * Reshaped for the Active Run merge (2026-09-08): the old field+territory
 * tours are one "field" tour now, and Learn — promoted to the bottom bar —
 * gets its own. Old `territory` seen-flags simply go unread: veterans who
 * finished the old field tour aren't re-popped (their `field` flag holds),
 * and "?" replays the merged tour on demand.
 *
 * Every step points the cursor at a [data-tour="…"] anchor; `target` may
 * list fallbacks (first visible wins — e.g. the Active Run map vs. the
 * Gratitude Gate that hides it before check-in). `optional` steps auto-skip
 * when their anchor isn't on screen (gated/empty states).
 */
export type TutorialStep = {
  id: string;
  /** Navigate before pointing — only used for same-page tab switches. */
  route?: string;
  search?: Record<string, string>;
  /** data-tour anchor(s); first visible wins. Omit = centered card. */
  target?: string | string[];
  /** Skip silently when no anchor is visible (gated/empty states). */
  optional?: boolean;
  title: string;
  body: string;
  /** Spotlight padding around the anchor, px (default 8). */
  padding?: number;
  /** Where the cursor points inside the anchor, as fractions of its size
   *  (default dead center). Lets the cursor tap a specific button inside a
   *  larger highlighted group. */
  cursorAt?: { x: number; y: number };
  showWordmark?: boolean;
};

export type TourPageId = "field" | "mission" | "leaders" | "wrap" | "learn" | "kombat";

/** Which tour a pathname belongs to (canvasser routes only — canvassers
 *  bounce off /my-territory to /field since the merge). */
export function pageIdForPathname(pathname: string): TourPageId | null {
  if (pathname === "/field") return "field";
  if (pathname === "/dashboard") return "mission";
  // Captain twins (audit 2026-09-12): their Mission lives on /mission and
  // their canvass map on /my-territory — same anchors, same tours.
  if (pathname === "/mission") return "mission";
  if (pathname === "/my-territory") return "field";
  if (pathname === "/learn") return "learn";
  if (pathname === "/leaderboard") return "leaders";
  if (pathname === "/daily-wrap") return "wrap";
  // The closer's one screen (rep audit R-7) — the densest board in the app
  // finally gets a guide.
  if (pathname === "/close-kombat") return "kombat";
  return null;
}

export const PAGE_TOURS: Record<TourPageId, TutorialStep[]> = {
  field: [
    {
      id: "field-map",
      // gratitude-gate fallback only matters on a "?" replay while gated —
      // the auto-pop deliberately waits until the gate is passed.
      target: ["field-map", "gratitude-gate"],
      cursorAt: { x: 0.5, y: 0.3 },
      title: "Your turf, live",
      body: "Your turf shows as a named boundary, with a bubble over every house and ZIP borders for context. Zoom to the street and tap a house bubble to log that door — one tap on the result is the whole knock.",
    },
    {
      id: "field-bank",
      target: "field-bank",
      optional: true, // hides behind the gate / before the map is ready
      padding: 6,
      title: "Watch it stack",
      body: "Every door you knock drops money in the bank — even a Not Home has a dollar value. Projected from your real conversion rates, and the pig refills every $100.",
    },
    {
      id: "field-chips",
      target: "field-chips",
      optional: true, // hides behind the gate / before turf is assigned
      padding: 6,
      title: "Pin any house",
      body: "No bubble on a house? Pick a result — Not Home, Go Back, Renter, Not Interested — then tap that spot on the map. Leads go through ⚡ Submit New Lead. Tonight's go-backs start here.",
    },
    {
      id: "field-lead",
      target: "field-lead",
      optional: true, // hidden behind the gate on a pre-check-in "?" replay
      cursorAt: { x: 0.5, y: 0.68 }, // tap under the label so it stays readable
      title: "Got a yes?",
      body: "Smash ⚡ Submit New Lead. It pins the house and opens the lead form — fill it out right on the doorstep while it's hot.",
    },
  ],
  mission: [
    {
      id: "mission-clock",
      route: "/dashboard",
      search: { tab: "plan" },
      target: "mission-clock",
      cursorAt: { x: 0.5, y: 0.72 }, // the punch button sits under the timer
      title: "Clock in here",
      body: "Mission is your HQ. Start every shift by clocking in and end it by clocking out — this is what runs your paycheck.",
    },
    {
      id: "mission-pay",
      target: "mission-pay",
      title: "Watch your pay",
      body: "Your weekly pay updates live as points land, with your hourly rate right below it. Sits and sales push both up.",
    },
    {
      id: "tab-plan",
      route: "/dashboard",
      search: { tab: "plan" },
      target: "tab-plan",
      title: "Plan",
      body: "Set your income goal and the Playbook turns it into today's door math. It gets sharper as your own numbers land.",
    },
    {
      id: "tab-log",
      route: "/dashboard",
      search: { tab: "log" },
      target: "tab-log",
      title: "Today",
      body: "Your live day in one place: the bank filling, counters ticking as you tap, and the desk numbers — sits and sales — you type in yourself. That's where your points come from.",
    },
    {
      id: "tab-stats",
      route: "/dashboard",
      search: { tab: "stats" },
      target: "tab-stats",
      title: "Stats",
      body: "The scoreboard — this week and this month: your funnel, points, and money. Know your numbers, grow your numbers.",
    },
  ],
  learn: [
    {
      id: "learn-search",
      target: "learn-search",
      title: "Search the training",
      body: 'Every word of every training video, searchable — try "urgency" and jump straight to the moment it\'s said.',
    },
    {
      id: "learn-dojo",
      target: "learn-dojo",
      cursorAt: { x: 0.5, y: 0.15 }, // the dojo runs long — point at its header
      title: "Objection Dojo",
      body: "Record your comeback to a real objection and send it in — drill until no door can shake you.",
    },
  ],
  leaders: [
    {
      id: "leaders",
      target: "leaders-board",
      padding: 4,
      title: "Leaderboard",
      body: "The whole fleet, live — every van, every score, who's on top right now. Your name belongs up here.",
    },
  ],
  wrap: [
    {
      id: "wrap",
      target: "wrap-header",
      title: "Daily Wrap-Up",
      body: "The end-of-day report: today's winners, who took a doughnut (a zero), and the week's point bosses. It locks at 7 PM.",
    },
  ],
  // The closer's board (rep audit R-7) — MK-money dialect, never canvasser
  // vocabulary. Hero is optional: it only renders once a board row matches.
  kombat: [
    {
      id: "kombat-hero",
      target: "kombat-hero",
      optional: true,
      title: "Your corner of the ring",
      body: "Your money first: volume for the range on screen, your rank, and exactly how far the rep above you is. KA-CHING fires here the moment a sale of yours lands on the board.",
    },
    {
      id: "kombat-range",
      target: "kombat-range",
      padding: 6,
      title: "Pick the fight",
      body: "Day, Week, Month, Year — the money is always the range on screen. Today shows today's dollars only; page back for last month's war.",
    },
    {
      id: "kombat-standings",
      target: "kombat-standings",
      cursorAt: { x: 0.5, y: 0.25 },
      title: "The bracket",
      body: "Ranked by sale volume, every range. Gold row is you, the Crown is the champion, Flawless Victory means a 100% close rate. Results land live — cancels move when the office syncs.",
    },
    {
      id: "kombat-legend",
      target: "kombat-legend",
      optional: true,
      title: "Decode the columns",
      body: "Every column, every rate, and every pay rule — the 50/25/25 save split, why a cancel still counts your sit — one tap away, whenever you need it.",
    },
  ],
};

/** Wrapped around the very first tour a canvasser ever sees. */
export const WELCOME_STEPS: TutorialStep[] = [
  {
    id: "welcome",
    title: "Welcome to the fleet",
    body: "This is Turf Invaders — your command center. Quick tips pop up the first time you open each screen; this one takes about 30 seconds.",
    showWordmark: true,
  },
  {
    id: "hud",
    target: "hud",
    // optional: sales reps have no HUD strip (rep audit R-7) — a
    // non-optional anchor that never exists froze their first tour for the
    // 4s target-hunt, then showed canvasser copy. Canvassers/captains
    // always render the anchor, so nothing changes for them.
    optional: true,
    title: "Your score strip",
    body: "Your rank, today's leads, and your week points with the distance to the next pay tier — pinned to the top of every screen. If you knock while off the clock, it turns into an alarm.",
  },
];

export const HELP_STEP: TutorialStep = {
  id: "help",
  target: "help",
  title: "Need a refresher?",
  body: "Tap ? on any screen to replay its tips. Anything they don't answer, your captain's got you. Now go take some turf. 🚀",
};
