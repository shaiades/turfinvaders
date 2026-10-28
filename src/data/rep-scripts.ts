// Sales story scripts for the Close Kombat Learn tab (owner request
// 2026-10-28). Copy is taken word for word from Tidal's printed upsell
// playbooks (Attic Insulation, Gutters, Patio Covers, Premium Shingle
// Upgrade, Advantage+), built with Shai Oct 21–22 2026. Treat these lines
// like door-script.ts: change wording only with Shai's sign-off.
//
// Every script follows the same story-script method (STORY_METHOD below):
// Complaint → Discovery → Simple language → Why it matters → Think of it
// like → If nothing changes → two-option close, with 2–3 ASK rows woven in.
// The Learn tab renders this file; components never hard-code script copy.

export type ScriptStage = "attention" | "emotion" | "imagery" | "action";

export const STAGE_LABEL: Record<ScriptStage, string> = {
  attention: "Attention",
  emotion: "Emotion",
  imagery: "Imagery",
  action: "Action",
};

export type StoryRow = {
  stage: ScriptStage;
  /** Story step name ("Complaint", "Discovery"…); "Ask" for ask rows. */
  step: string;
  /** Ask rows are the pattern interrupts: ask, pause, use their answer. */
  ask?: boolean;
  /** Spoken line. */
  say: string;
  /** Stage direction, shown muted after the line. */
  cue?: string;
};

export type ScriptOption = { tag?: string; title: string; body: string };
export type ScriptPoint = { title: string; body: string };

export type RepScript = {
  id: string;
  order: number;
  title: string;
  tagline: string;
  /** What to bring / which two ways in — shown under the title. */
  setup?: string;
  /** "Protect the sale" banner for upsells told after the yes. */
  protect?: string;
  rows: StoryRow[];
  /** The close, one spoken line per entry. */
  close: string[];
  /** The rule printed under the close. */
  closeRule: string;
  optionsTitle: string;
  options: ScriptOption[];
  /** A single rep note under the options (math, rain volume, etc.). */
  note?: string;
  pointsTitle?: string;
  points?: ScriptPoint[];
  /** Attic only: educate-before-you-price block. */
  educate?: {
    title: string;
    ask: string;
    points: ScriptPoint[];
    quote: string;
    redFlag: string;
  };
  pushback?: { q: string; a: string }[];
  walkaroundTitle: string;
  walkaround: string[];
  avoid: string[];
  /** What a passing teach-back sounds like, in the homeowner's words. */
  teachBack: string;
};

export const REP_SCRIPTS: RepScript[] = [
  {
    id: "script-attic",
    order: 1,
    title: "Attic Insulation",
    tagline: "You're paying to heat and cool your attic.",
    setup: "Bring: tape measure · phone camera",
    rows: [
      {
        stage: "attention",
        step: "Ask",
        ask: true,
        say: "When's the last time you popped your head up into the attic?",
        cue: "Most say never.",
      },
      {
        stage: "attention",
        step: "Complaint",
        say: "Most people never do. I went up today and found why your AC barely shuts off.",
      },
      {
        stage: "attention",
        step: "Discovery",
        say: "Your attic should have about 13 inches of insulation. You've got 3 to 4.",
        cue: 'Pull the tape to 13", then show theirs.',
      },
      {
        stage: "emotion",
        step: "Simple language",
        say: "That's less than a third of what your home needs.",
      },
      {
        stage: "emotion",
        step: "Ask",
        ask: true,
        say: "Have you noticed your electric bill climbing, especially in the summer?",
      },
      {
        stage: "emotion",
        step: "Why it matters",
        say: "That's why. In summer, attic heat pours into the house and your AC fights it all day. In winter, the heat you pay for goes right out the ceiling.",
      },
      {
        stage: "imagery",
        step: "Think of it like",
        say: "A shoebox full of warm air with the lid off. Insulation is the lid.",
      },
      {
        stage: "emotion",
        step: "If nothing changes",
        say: "The bills keep climbing and your system keeps overworking until something breaks.",
      },
      {
        stage: "action",
        step: "Ask",
        ask: true,
        say: "If we could keep the house cooler and stop the AC from running nonstop, would that be worth fixing?",
        cue: "Get the yes.",
      },
    ],
    close: [
      "You've got two options. We can blow new R-38 right on top of what you have. Or, for the most efficient strategy, we clean out the old insulation and replace it with all-new R-38. Which option works best for you?",
    ],
    closeRule: "Then stop talking.",
    optionsTitle: "The two options",
    options: [
      {
        tag: "Option 1",
        title: "Top-off",
        body: "New blown-in R-38 on top of the existing insulation, up to the full 13 inches. Lead with it when the old insulation is clean, dry and pest-free.",
      },
      {
        tag: "Option 2 · Most efficient",
        title: "Clean-out + replace",
        body: "Remove all the old insulation, then blow in all-new R-38. About double the cost of a top-off. Lead with it when you find pests, moisture or damaged insulation.",
      },
    ],
    educate: {
      title: "Why clean out? Educate before you price.",
      ask: "Have you ever heard scratching in the ceiling, or had a problem with mice or rats?",
      points: [
        {
          title: "Rodents",
          body: "Droppings, nests, tunnels or a urine smell, right above the bedrooms.",
        },
        {
          title: "Moisture and mold",
          body: "Water stains or damp spots. Wet insulation stops working and can spread mold.",
        },
        {
          title: "Matted insulation",
          body: "Packed down, dirty or dark from dust. Compressed, it can't insulate.",
        },
      ],
      quote: "Putting new insulation over that is like putting clean sheets on a dirty mattress.",
      redFlag:
        "Pebble-like, gray-brown fill may be vermiculite, which can contain asbestos. Don't touch it. Photograph it and call your manager.",
    },
    walkaroundTitle: "On the walk-around",
    walkaround: [
      "Measure the depth with your tape",
      "Photograph the tape in the insulation",
      "Photograph droppings, stains, matted spots",
      "Show them the photos before options",
    ],
    avoid: [
      "Talking R-values before inches",
      "Telling only the winter story",
      "Pricing a clean-out with no photos",
      '"So what do you think?" Give two options.',
    ],
    teachBack:
      "I only have a third of the insulation I need, so my heat and AC are going out the attic, like a box with no lid.",
  },
  {
    id: "script-gutters",
    order: 2,
    title: "Gutters",
    tagline: "Gutters are the plumbing for the outside of the home.",
    setup: "Bring: phone camera · your photos",
    rows: [
      {
        stage: "attention",
        step: "Ask",
        ask: true,
        say: "When it rains, do you know where all the water off your roof goes?",
        cue: "Walk them to the wall.",
      },
      {
        stage: "attention",
        step: "Complaint",
        say: "It lands right here. See the water staining down the stucco and the puddles along the wall?",
      },
      {
        stage: "attention",
        step: "Discovery",
        say: "You don't have any gutters, so every drop that hits the roof falls right here.",
        cue: "Show your photos of stains, efflorescence and cracks.",
      },
      {
        stage: "emotion",
        step: "Simple language",
        say: "The water gutters would catch is soaking into your stucco. The wood behind it gets wet, swells and cracks the stucco.",
      },
      {
        stage: "emotion",
        step: "Ask",
        ask: true,
        say: "Have you ever had to patch or paint over cracks in the stucco?",
      },
      {
        stage: "emotion",
        step: "Why it matters",
        say: "That's usually why. Cracks let more water into the wall, where it's dark and damp, and that's how mold grows where you can't see it. The pooling water also soaks the ground under your concrete and foundation.",
      },
      {
        stage: "imagery",
        step: "Think of it like",
        say: "A sink with no drainpipe: the water just dumps on the floor. Right now your roof is dumping on your walls and foundation.",
      },
      {
        stage: "emotion",
        step: "If nothing changes",
        say: "More staining, more cracks, more water in the walls. Concrete can sink and the foundation can settle, and those repairs cost a lot more than gutters.",
      },
      {
        stage: "action",
        step: "Ask",
        ask: true,
        say: "Would you rather take care of it with gutters now, or deal with stucco and foundation repairs later?",
      },
    ],
    close: [
      "Let's give your house some plumbing. Which style do you like better, K-style or round?",
      "And for color, do you want them to match the trim or the roof?",
    ],
    closeRule: "Never ask whether they want gutters. Ask which ones. Then stop talking.",
    optionsTitle: "The two styles",
    options: [
      {
        title: "K-style",
        body: "Flat front that looks like crown molding. The most common style. Good fit: most homes.",
      },
      {
        title: "Round",
        body: "Curved, half-round profile with a classic look. Good fit: Spanish and older-style homes.",
      },
    ],
    note: "One inch of rain on a 2,000 sq ft roof is about 1,250 gallons. Without gutters, all of it lands next to the house.",
    pointsTitle: "Top reasons for gutters",
    points: [
      {
        title: "Roof edge protection",
        body: "Water is carried off the edge instead of pouring over it every rain.",
      },
      {
        title: "Fascia board protection",
        body: "Keeps runoff from soaking and rotting the fascia boards.",
      },
      {
        title: "Stucco protection",
        body: "No staining, efflorescence, cracks or moisture in the walls that can lead to toxic mold.",
      },
      {
        title: "Foundation and concrete",
        body: "Downspouts move water away instead of pooling, preventing costly foundation repairs.",
      },
    ],
    walkaroundTitle: "On the walk-around, photograph",
    walkaround: [
      "Water stains running down the stucco",
      "White, chalky efflorescence",
      "Cracks at the sill plate or along the studs",
      "A drip line or trench in the dirt",
      "Pooling, sunken or cracked concrete",
      "Stained or rotting fascia, mold on walls",
    ],
    avoid: [
      "Leading with mold. Lead with water and plumbing.",
      'Asking "Do you want gutters?" Ask which style.',
      "Pitching without photos of their own house.",
      "Diagnosing the foundation. Say it can settle.",
    ],
    teachBack:
      "I don't have gutters, so all my roof water is soaking into my walls and foundation. Gutters are the plumbing that carries it away.",
  },
  {
    id: "script-patio",
    order: 3,
    title: "Patio Covers",
    tagline: "We're not selling a structure. We're selling a new room for family time.",
    setup: "Two ways in: no cover · old wood cover",
    rows: [
      {
        stage: "attention",
        step: "Ask",
        ask: true,
        say: "Be honest, how often do you actually hang out back here?",
        cue: "Let them tell you why.",
      },
      {
        stage: "attention",
        step: "Complaint",
        say: "No cover: It's too hot and there's no shade, so nobody comes out here. Old cover: You've got rot and termites, and you're repainting it every couple of years.",
      },
      {
        stage: "attention",
        step: "Discovery",
        say: "You want to be out here. You just don't have a comfortable place to do it.",
        cue: "Point to the faded furniture, bare slab or rotted beams.",
      },
      {
        stage: "emotion",
        step: "Simple language",
        say: "You need a space where your family can actually be together outside.",
      },
      {
        stage: "emotion",
        step: "Ask",
        ask: true,
        say: "If it was shaded and comfortable back here, what would you use it for?",
        cue: "Let them paint the picture.",
      },
      {
        stage: "emotion",
        step: "Why it matters",
        say: "Homes are expensive, and you're paying for every square foot, the backyard included. Right now it's too hot to use, so you don't hang out here or have people over.",
      },
      {
        stage: "imagery",
        step: "Think of it like",
        say: "A restaurant table in direct sun. You ask for an umbrella or move to the shade. Right now your backyard is the table in the sun.",
      },
      {
        stage: "emotion",
        step: "If nothing changes",
        say: "It stays wasted space while the summers go by.",
        cue: "Old cover: The wood keeps rotting and the patch-and-paint cycle never ends.",
      },
      {
        stage: "action",
        step: "Ask",
        ask: true,
        say: "Would you rather keep paying for a backyard you don't use, or turn it into the best room in the house?",
      },
    ],
    close: [
      "Let's build it. Do you want lattice, so some sun comes through, or a solid cover for full shade?",
      "And do you want lights only, or lights and a ceiling fan for the hot days?",
    ],
    closeRule: "Never ask whether they want one. Ask how to build it. Then stop talking.",
    optionsTitle: "The options",
    options: [
      {
        tag: "Cover",
        title: "Lattice",
        body: "Open slats that filter the sun. For an open feel and some light.",
      },
      {
        tag: "Cover",
        title: "Solid",
        body: "Full shade. For hot south- or west-facing yards.",
      },
      {
        tag: "Add-on",
        title: "Lights",
        body: "Built-in lighting for using the space after dark.",
      },
      {
        tag: "Add-on",
        title: "Ceiling fan",
        body: "For hot afternoons, and it keeps the bugs off.",
      },
    ],
    pointsTitle: "Top reasons for a patio cover",
    points: [
      {
        title: "Usable living space",
        body: "Turns an unused yard into a room the family actually uses.",
      },
      { title: "Shade and comfort", body: "Makes the yard comfortable on hot afternoons." },
      { title: "Entertaining", body: "Finally a place to host family and friends." },
      { title: "Protects furniture", body: "No more sun-bleached, faded patio furniture." },
      {
        title: "Ends the repair cycle",
        body: "Old covers: replace the rot and termite damage instead of repainting every few years.",
      },
    ],
    walkaroundTitle: "On the walk-around, photograph",
    walkaround: [
      "A bare slab with no shade, facing south or west",
      "Sun-faded, covered or unused furniture",
      "A back slider opening into full sun",
      "Old covers: rot, termites, peeling paint, sagging beams",
    ],
    avoid: [
      "Selling the structure. Sell the family time.",
      "Answering their dream for them. Ask, and listen.",
      'Asking "Do you want a patio cover?"',
      "Quoting a repaint without showing the cycle.",
    ],
    teachBack:
      "We never use our backyard because it's too hot and there's nowhere to sit. A patio cover gives us shade and a place to be together.",
  },
  {
    id: "script-shingle",
    order: 4,
    title: "Premium Shingle Upgrade",
    tagline: "GAF Timberline HDZ to HDZ RS+. Same 50-year roof, a cooler house, a richer look.",
    protect:
      "Protect the sale. Tell it after the yes. The HDZ is already a 50-year roof. RS+ is an upgrade, not a fix.",
    rows: [
      {
        stage: "attention",
        step: "Ask",
        ask: true,
        say: "Which room in the house gets the hottest in the summer?",
        cue: "Most point upstairs.",
      },
      {
        stage: "attention",
        step: "Complaint",
        say: "So it's hot up there, and the AC is working overtime to keep up.",
      },
      {
        stage: "attention",
        step: "Discovery",
        say: "Your roof takes full sun most of the day, and the darker colors you like soak up the most heat.",
        cue: "Point to the sunny slope.",
      },
      {
        stage: "emotion",
        step: "Simple language",
        say: "A standard shingle soaks up the sun. The RS+ bounces it back, and it still comes in the dark, rich colors you like.",
      },
      {
        stage: "emotion",
        step: "Ask",
        ask: true,
        say: "How long are you planning to stay in this home?",
        cue: "Use their answer in the next line.",
      },
      {
        stage: "emotion",
        step: "Why it matters",
        say: "You just chose a roof built to last 50 years. That's 50 summers of heat soaking into the attic, or 50 summers of it bouncing off.",
      },
      {
        stage: "imagery",
        step: "Think of it like",
        say: "A black T-shirt in July versus a black performance shirt built to keep you cool. Same color, completely different feel.",
      },
      {
        stage: "emotion",
        step: "If nothing changes",
        say: "Once these shingles go on, they're on for the life of the roof. You can't upgrade later without tearing it off. Today is the only day you get to choose.",
      },
      {
        stage: "action",
        step: "Ask",
        ask: true,
        say: "If you could get the color you love and keep the house cooler for all 50 years, would that be worth a few dollars a month?",
      },
    ],
    close: [
      "Either way, you're getting the same 50-year Master Elite roof system. The only choice is the shingle on top. You can keep the HDZ, or for about [$__] a month, the RS+ keeps the house cooler and gives you that richer designer look. Which one works best for you?",
      "Are you leaning toward the Charcoal or the Stone Gray?",
    ],
    closeRule: "Monthly number first, total second. Then stop talking.",
    optionsTitle: "Same 50-year system, two shingles",
    options: [
      {
        tag: "Standard",
        title: "GAF Timberline HDZ",
        body: "Your 50-year Master Elite roof system with ridge vent. A great roof that soaks up the sun like most shingles.",
      },
      {
        tag: "Premium designer",
        title: "GAF Timberline HDZ RS+",
        body: "The same 50-year system, plus a shingle that reflects the sun, deep reflective colors and a wood-shake look.",
      },
    ],
    note: "Monthly math: divide the upgrade by 600 months (50 years). A $3,000 upgrade is $5 a month. Say the monthly number before the total.",
    pointsTitle: "What RS+ is, in plain words",
    points: [
      {
        title: "It reflects the sun",
        body: "RS means Reflector Series. It absorbs less heat than a standard shingle.",
      },
      {
        title: "It stays dark and rich",
        body: "EcoDark granules. GAF calls Charcoal the darkest highly reflective color in California.",
      },
      { title: "It looks designer", body: "A wood-shake look with an enhanced shadow effect." },
      { title: "It meets cool-roof code", body: "Title 24 compliant and CRRC rated." },
      {
        title: "Pair it with the attic story",
        body: "RS+ keeps heat off the roof, and R-38 keeps the rest out of the house. Never promise a temperature drop or dollar savings. GAF doesn't publish one.",
      },
    ],
    walkaroundTitle: "On the walk-around, look for",
    walkaround: [
      "South or west slopes in full afternoon sun",
      "Hot upstairs rooms under the sunny slope",
      "A homeowner leaning toward a dark color",
      "An older AC, or one that runs constantly",
    ],
    avoid: [
      "Knocking the HDZ. It's the same 50-year system.",
      "Leading with price. Hot room and 50 summers first.",
      'SRI numbers and granule tech. Say "bounces the sun back."',
      '"Do you want to upgrade?" Ask which one, then color.',
    ],
    teachBack:
      "The regular shingle soaks up the sun. The RS+ bounces it back but still looks dark, like a performance shirt. And today's my only chance to pick it.",
  },
  {
    id: "script-advantage",
    order: 5,
    title: "Advantage+",
    tagline: "You're not hiring a contractor. You're partnering with Tidal.",
    protect:
      "Protect the sale. Present it right after the project agreement is signed. It's a separate one-time $495 charge.",
    rows: [
      {
        stage: "attention",
        step: "Ask",
        ask: true,
        say: "Besides this project, what else is on your list for the house over the next few years?",
        cue: "Write down every project they name.",
      },
      {
        stage: "attention",
        step: "Complaint",
        say: "So there's more coming, and every one of those is another contractor to find, another full price, another wait.",
      },
      {
        stage: "attention",
        step: "Discovery",
        say: "You've already started improving your home with us. Advantage+ locks in the benefits for everything that comes next.",
        cue: "Point to the projects you wrote down.",
      },
      {
        stage: "emotion",
        step: "Simple language",
        say: "For a one-time $495, you get 25% off every future project, free check-ups, a direct line to us, and you go to the front of the line.",
      },
      {
        stage: "emotion",
        step: "Ask",
        ask: true,
        say: "Have you ever had a contractor disappear on you once the job was done?",
        cue: "Let them tell the story.",
      },
      {
        stage: "emotion",
        step: "Why it matters",
        say: "That's exactly why we built this. We stay with you after the job: check-ups, a real person to text, and partner pricing on everything next. One project around $2,000 or more pays for the whole program.",
      },
      {
        stage: "imagery",
        step: "Think of it like",
        say: "A family doctor for your home. Regular check-ups, a number you can actually reach, the first appointment, and family pricing.",
      },
      {
        stage: "emotion",
        step: "If nothing changes",
        say: "Every future project is full price, you wait in line like everyone else, and nobody checks on your home after we leave.",
      },
      {
        stage: "action",
        step: "Ask",
        ask: true,
        say: "If one of those projects on your list pays for the whole program, does it make sense to lock it in today?",
      },
    ],
    close: [
      "Most homeowners add it on because it just makes sense. I'll check the Yes box so we can activate everything. Should I put the $495 on the card on file, or would you like to use a different card?",
    ],
    closeRule: "Hand them the pen for initials. Then stop talking.",
    optionsTitle: "What they get for a one-time $495",
    options: [
      {
        title: "25% savings on future projects",
        body: "Roofing, paint, windows, gutters, insulation, patios.",
      },
      {
        title: "Free home check-ups",
        body: "Twice in year one, then every 2 years. A quick inspection and photo update.",
      },
      { title: "Concierge line", body: "A direct text line to real people, 8am to 10pm." },
      {
        title: "Priority scheduling",
        body: "This project and every one after goes to the top. First pick on start dates.",
      },
      {
        title: "Referral boost",
        body: "$750 per referral who hires us, instead of the regular $500.",
      },
    ],
    note: "The math: 25% off a project of about $2,000 is $495, so one project that size pays for the program. Example: on a $15,000 paint job, 25% is $3,750.",
    pointsTitle: "Know the fine print",
    points: [
      {
        title: "Charged once",
        body: "The next business day, separate from the contract.",
      },
      {
        title: "Tied to the address",
        body: "Transferable to a new owner. Check-ups are exterior. No cash value.",
      },
    ],
    pushback: [
      {
        q: "Is this a subscription?",
        a: "No. One time, $495, for the life of this address.",
      },
      {
        q: "We don't have other projects.",
        a: "Check-ups, the direct line and referral boost still pay.",
      },
      {
        q: "We're spending enough.",
        a: "That's why it's here: it lowers what you spend next.",
      },
    ],
    walkaroundTitle: "Before you present",
    walkaround: [
      "The project agreement is signed",
      "You've written down every future project they named",
    ],
    avoid: [
      "Pitching it before the agreement is signed.",
      "Calling it a membership, plan or warranty.",
      "Promising check-up dates. They follow our routes.",
      'Asking "Do you want it?" Ask which card.',
    ],
    teachBack:
      "For a one-time $495, we get 25% off everything we do next, free check-ups, a direct line, and first pick on dates. One more project pays for it.",
  },
];

/** The method lesson shown above the scripts — the same body format as
 *  rep-playbook.ts (blank line = paragraph, "- " lines = bullets). */
export const STORY_METHOD = {
  id: "script-method",
  title: "How Every Story Works",
  readMinutes: 2,
  body: `Every product story follows the same seven steps. Learn the shape once and you can tell any story.

- Customer complaint: what's bugging them?
- What did we discover?
- What does that mean in simple language?
- Why does it matter?
- Think of it like… (one comparison they can picture)
- What happens if nothing changes?
- What are the next-step options?

Script-writing framework: Attention (a question about their own home), Emotion (why should they care?), Imagery (one comparison they can picture), Action (two options, then stop talking).

Ask rows are your pattern interrupts. Every story has 2–3 questions woven in. Ask, pause, and use their answer in your next line.

Close on two options. Never "Does that work?" or "Do you want it?" Ask which one. Then stop talking.

- 90-second test: say it out loud, with a timer, in 90 seconds or less.
- Teach-back test: the homeowner can say it back in their own words. Can't? Simplify. Don't add facts.`,
};

/** Role-play drill printed on the Tidal Role Play Scorecard. */
export const ROLE_PLAY = {
  id: "script-roleplay",
  title: "Role Play",
  readMinutes: 1,
  body: `If they can't teach it back, they didn't buy it.

- Pair up: one technician, one homeowner.
- Run the story: props in hand, timer running.
- Teach it back: the homeowner explains it in their own words.
- Score and swap: score the round, then switch seats.

Score every round:

- Asked all 3 questions
- Used the visual
- Analogy landed
- Ended on two options
- Under 90 seconds
- Taught it back

Then ask: what needs to be clearer?`,
};
