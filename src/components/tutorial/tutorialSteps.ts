/**
 * Per-page discovery tours for canvassers. Each screen has its own short
 * tour that auto-pops the FIRST time the canvasser opens that screen
 * (owner decision 2026-09-08: contextual tips as pages are discovered, not
 * one long day-one walkthrough). The very first tour ever shown gets the
 * welcome/HUD/help bracket wrapped around it; the header "?" replays the
 * current screen's tips on demand.
 *
 * Every step points the cursor at a [data-tour="…"] anchor; `target` may
 * list fallbacks (first visible wins — e.g. the Territory map vs. the
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

export type TourPageId = "field" | "territory" | "mission" | "leaders" | "wrap";

/** Which tour a pathname belongs to (canvasser routes only). */
export function pageIdForPathname(pathname: string): TourPageId | null {
  if (pathname === "/field") return "field";
  if (pathname === "/my-territory") return "territory";
  if (pathname === "/dashboard") return "mission";
  if (pathname === "/leaderboard") return "leaders";
  if (pathname === "/daily-wrap") return "wrap";
  return null;
}

export const PAGE_TOURS: Record<TourPageId, TutorialStep[]> = {
  field: [
    {
      id: "field-tallies",
      target: "field-tallies",
      padding: 6,
      cursorAt: { x: 0.26, y: 0.28 }, // tap the Log Knock button, not the gap
      title: "Active Run",
      body: "Your shift lives here — one tap per door. 🚪 knocked, 🗣️ talked, 🛑 not interested. Every tap also drops a GPS pin on your map, so keep Location on.",
    },
    {
      id: "field-lead",
      target: "field-lead",
      cursorAt: { x: 0.5, y: 0.68 }, // tap under the label so it stays readable
      title: "Got a yes?",
      body: "Smash ⚡ Submit New Lead. It pins the house and opens the lead form — fill it out right on the doorstep while it's hot.",
    },
  ],
  territory: [
    {
      id: "territory",
      target: ["territory-map", "gratitude-gate"],
      cursorAt: { x: 0.5, y: 0.3 }, // gate: the question · map: where turf sits
      title: "My Territory",
      body: "The streets assigned to you, on a live map — your pins land here as you work. Each morning, a one-line gratitude check-in unlocks it.",
    },
    {
      id: "territory-pins",
      target: "territory-pins",
      optional: true,
      title: "Drop result pins",
      body: "Pick a result — Lead, Not Home, Go Back, Renter, NI, Appt — then tap that house on the map. Tonight's go-backs start here.",
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
      body: "Your weekly pay updates live as points land, with your hourly rate and this month's volume bonus right below it.",
    },
    {
      id: "tab-plan",
      route: "/dashboard",
      search: { tab: "plan" },
      target: "tab-plan",
      title: "Plan",
      body: "Set your income goal and Plan back-solves it — how many doors and leads today gets you there.",
    },
    {
      id: "tab-log",
      route: "/dashboard",
      search: { tab: "log" },
      target: "tab-log",
      title: "Log",
      body: "Your official numbers for the day. Active Run fills these in as you tap — review before you head in, and add anything you missed.",
    },
    {
      id: "tab-stats",
      route: "/dashboard",
      search: { tab: "stats" },
      target: "tab-stats",
      title: "Stats",
      body: "Today, this week, this month — your funnel, points, and money. Know your numbers, grow your numbers.",
    },
    {
      id: "tab-learn",
      route: "/dashboard",
      search: { tab: "learn" },
      target: "tab-learn",
      title: "Learn",
      body: "Training videos, scripts, and the Objection Dojo — drill your comebacks until no door can shake you.",
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
    title: "Your score strip",
    body: "Rank, leads called in, and points today — pinned to the top of every screen, so you always know where you stand.",
  },
];

export const HELP_STEP: TutorialStep = {
  id: "help",
  target: "help",
  title: "Need a refresher?",
  body: "Tap ? on any screen to replay its tips. Anything they don't answer, your captain's got you. Now go take some turf. 🚀",
};
