// The Infinity Sale Playbook — adapted for the app's Learn tab (owner
// request 2026-09-17) from tidalremodeling.com/infinity-sale-playbook, the
// company's own material. Sections 00-09 ship this round; the source runs
// longer (video-engine deployment detail, more of the referral system) — a
// follow-up content pass can extend REP_PLAYBOOK without touching anything
// that reads it, since every consumer just sorts by `order`.
//
// The "mindset" category ships with only Section 00 for now. A second
// mindset entry (limiting beliefs, beginner's mind — inspired by Rick
// Rubin's The Creative Act) is still being discussed separately and is
// deliberately NOT included here yet.

export type PlaybookCategory =
  | "mindset"
  | "money-math"
  | "touchpoints"
  | "video-engine"
  | "neighbors"
  | "reload"
  | "final-walk"
  | "referrals";

export type PlaybookSection = {
  id: string;
  order: number;
  title: string;
  readMinutes: number;
  category: PlaybookCategory;
  body: string;
};

export const PLAYBOOK_CATEGORY_LABEL: Record<PlaybookCategory, string> = {
  mindset: "Mindset",
  "money-math": "The Money Math",
  touchpoints: "Touchpoints",
  "video-engine": "The Video Engine",
  neighbors: "The Neighbor System",
  reload: "Reloads",
  "final-walk": "The Final Walk",
  referrals: "Referrals",
};

export const REP_PLAYBOOK: PlaybookSection[] = [
  {
    id: "00-mindset",
    order: 0,
    title: "The Infinity Sale Mindset",
    readMinutes: 2,
    category: "mindset",
    body: `Read this section first. Every other section builds on it.

A bad sales rep sells a $20,000 roof, collects a $1,600 commission, and says "great, next lead please."

A great sales rep sells the same $20,000 roof and says "great, I just opened a new franchise. What's the max commission I can pull out of this one property in the next 30 days?"

Answer: $9,680. Same sale. Same 30 days. 6 times the paycheck.

That's the difference. And it's the entire difference between doing this job for a paycheck and doing it for a career.

Every canvass sale is a franchise you own. From that one homeowner, in the next 30 days, you have the right to:

- A Google review with your name in it
- Before/during/after photos of the transformation
- A video testimonial from the homeowner
- Three signed referrals at $500 each ($750 if Advantage+)
- Neighbor introductions to the 5 closest houses on their street
- Reload sales stacked into the same project window — insulation, gutters, trim paint, front windows, patio cover
- Referral sales that close before their crew even arrives

The math is exponential, not additive. One franchise closes reloads AND spawns referral sales AND spawns neighbor sales in the same 30-day window. Two good franchises on the same street trigger the crowd effect (see the Neighbor System section for the research). Three warm homes in a neighborhood means the next 5 homes are almost free.

Cold canvass leads are hard. They no-show. They cancel at the door. They're skeptical. They compare you to three other contractors.

Warm leads from a franchise are easy. They've seen your work. They already trust you. Their neighbor just told them Tidal did great work. The close rate is 3 to 4 times higher and the cycle time is half.

How the money actually works: commission is paid on PROFIT, not on the sale price. Canvass leads and reloads on any franchise pay 20% of profit. Self-gen — neighbor sales and referral sales only — pays 35% of profit. That's where the franchise math compounds fastest.

Compare that to running 40 hours of cold canvass leads a week. Same 40 hours worked correctly on 1 warm home can be 3 to 7x the pay in the same month.`,
  },
  {
    id: "01-money-math",
    order: 1,
    title: "The Math That Makes You Rich",
    readMinutes: 1,
    category: "money-math",
    body: `Do this calculation once. Look at it every time you don't feel like doing the work.

The setup: 1 canvass roof sale at $20,000. 40% profit margin. Canvass commission is 20% of profit. Self-gen is 35% of profit.

Just take the sale and move on: $1,600 in 30-day commission.
Work the franchise properly: $9,680 in 30-day commission.

Same sale. Same 30 days. 6 times the paycheck. Here's how that stacks up chronologically for one $20,000 canvass roof sale:

- Day 0 — the canvass roof sale itself: $1,600 (20% of $8,000 profit). Running total $1,600.
- Day 5 — a small insulation reload pre-start, $4,000 sale: $320 (20% of $1,600 profit). Running total $1,920.
- Day 15 — a trim paint reload mid-project, $12,000 sale: $960 (20% of $4,800 profit). Running total $2,880.
- Day 20 — a neighbor sale, $20,000 (crew's been on site 2 weeks): $2,800 (35% of $8,000 profit, self-gen rate). Running total $5,680.
- Day 30 — a referral sale, $20,000 (the marketing home refers someone): $2,800 (35%, self-gen rate). Running total $8,480.
- Day 30 — a patio cover reload seeded at the final walk, $15,000: $1,200 (20% of $6,000 profit). Running total $9,680.

30-day total: $91,000 in revenue for the company. $9,680 in your pocket. From ONE canvass lead. And it doesn't stop at day 30 — a second referral, the neighbor's own reload, the first referral's own reload, and that referral's own neighbor sale can all land in the next 30 days too, roughly doubling the 60-day total again.

If you close 3 canvass leads a month and just take the sales: about $4,800 a month, $58K a year. Run the full system on those same 3 leads: roughly $29,000 a month, $348K a year. Same 3 leads.`,
  },
  {
    id: "02-marketing-home",
    order: 2,
    title: "The Marketing Home Setup",
    readMinutes: 3,
    category: "touchpoints",
    body: `Every canvass sale becomes a Marketing Home. Non-negotiable. This is how the franchise is born.

The homeowner signs the Marketing Home form the day of sale, right after the contract, before you leave. Position it as part of the process, not an extra form.

Say it in your own words, out loud, until it's natural — never read it off your phone at the sale:

"One more thing before I head out. We do something called the Marketing Home program. Your project's going to look incredible when it's done, and we're going to use it to help other homeowners in this neighborhood who are trying to figure out if they should do the same thing. We'll take before-and-after photos — you get a copy too. We'll put a yard sign up during the project, and if you're comfortable, leave it up two weeks after. We'd love a written testimonial or a social post, totally optional. And three referrals: if you know three people thinking about work on their home and any of them hire us, you get $500 each ($750 if you're Advantage+), plus $50 the day of their consultation whether or not they move forward. And your price stays between us — what we spent on your job is nobody's business but ours. Sign here and I'll make sure the team knows this is a Marketing Home."

Why every piece matters:

- Before/after photos: your best salespeople — real houses in real neighborhoods.
- Yard sign: the FIRST warming move for the neighbor knocks — neighbors will ask.
- 3 referrals at $500+ each: the homeowner is a lead source now. They already agreed — you're collecting, not asking.
- Testimonial/social post: turns their trust into your marketing.
- Price confidentiality: protects your pricing power on the street and protects the homeowner from awkward "what did you pay" conversations.

If they push back on the yard sign, offer before/after photos only. If they say they don't know 3 people, ask them to think about their street first, and their family — anyone with a house older than 10 years is a candidate, no pressure, it's just who to send the $500 to. If they ask whether price confidentiality means overcharging neighbors, explain every home is priced by size, condition, and material — their neighbor gets their own quote.`,
  },
  {
    id: "03-touchpoint-cadence",
    order: 3,
    title: "The Touchpoint Cadence",
    readMinutes: 6,
    category: "touchpoints",
    body: `The cadence: Sale → Start → Middle → End (final walk) → +7 day check-in.

Every rep hits Sale and End. The great reps hit Start and Middle too. Two touches out of five leaves most of the franchise value on the table.

Touch 1 — The Sale (Day 0): contract and Marketing Home signed, and plant the reload seed for later — "Most homeowners don't realize we can bundle insulation with a roof for a fraction of what it costs standalone. Not now — I'll bring it up 5 days before your crew arrives, just want you thinking about it." Then book Touch 2: "The crew arrives on [date], I'll swing by that morning to make sure everything's set — 8 or 10 work better?"

Touch 2 — Start of job (5 days after sale for a roof, 7-10 for paint): bring coffee, take before-photos (wide shot of the house, close-ups of the damage, one unique detail shot), and pitch the small reload — "You know how I mentioned insulation? Right now, while the roof's torn off, the attic's exposed — that's the ONE window to add insulation at half of what it'd cost standalone, and it drops your electric bill 15-20% in summer. Want me to add it?" Book Touch 3.

Touch 3 — Middle of job (day 3-4 of a roof, day 5-7 of paint): the BIG reload seed. On a roof: "We're pulling off the fascia and eaves, so the rest of your paint is now 5-8 years older by comparison — I can price a full-house refresh at 30% off since we're already here." On paint: "The trim's about to look amazing next to 20-year-old windows — want me to price a few for the front now?" Also start soft neighbor conversations here (just gathering intel — "Do you know your neighbors well? Do they own or rent?" — not asking permission yet). Book Touch 4.

Touch 4 — The Final Walk: the biggest touch, 60-90 minutes minimum. Its own full section below.

Touch 5 — The +7 Day Check-In: collect on the referral seed, callback the "small favor" you asked for at the final walk ("Let me guess, you never got around to that small favor?"), get the video testimonial if you missed it, and book the reload for real if the homeowner is warm.

If you haven't seen the homeowner since the sale, own it at the final walk: "I should've been more present during the project, that's on me — let's do this walk right, and I'll make it up to you." Then run the standard final walk — don't skip the referral or neighbor ask, they just need a little more warmth up front.`,
  },
  {
    id: "04-video-engine",
    order: 4,
    title: "The Video Engine",
    readMinutes: 11,
    category: "video-engine",
    body: `This is the section reps skip — and it's the difference between staying stuck at your current number and multiplying it. Video content is the single highest-leverage asset you build during a franchise, and it's yours to keep for every future sale.

What a library of video testimonials does on your next appointment: kills price objections before they're raised, kills quality doubts ("how do I know you'll do a good job"), kills timeline worries, kills "let me think about it," and beats a competitor pitch every time. A rep with 10 video testimonials on their phone closes at roughly double the rate of a rep with none — same rep, different arsenal.

The Capture Rule: capture something at EVERY touchpoint, starting at the sale, not the final walk. By the final walk it's too late for a "before."

- Touch 1 (sale): a slow wide shot of the house from the street, close-ups of the damage you already photographed, and a 15-second selfie clip introducing the homeowner and city.
- Touch 2 (start): the crew arriving, a last clean "before" wide shot, a short clip of a foreman explaining the work, and B-roll of the neighborhood (mailboxes, the yard sign going up).
- Touch 3 (middle): the crew actively working, a 20-second narrated update ("day 3, on schedule, no surprises"), and — if the homeowner's around — even 5 seconds of them smiling at their new house.
- Touch 4 (final walk): the finished house from the same angle as your Touch 1 wide shot (your before/after money shot), detail shots, the homeowner's first-look reaction, a photo of you both together, and the video testimonial itself.
- Touch 5 (+7 days): one more wide shot from the same angle, and any reaction they haven't given you yet — sometimes the best testimonials land once the shine has settled and they still love it.

The testimonial itself: never ask "how was it," that gets you nothing usable. Ask these six questions, in order, in one continuous take:

1. "Before you met me, what problems were you running into with other contractors, or just finding one?"
2. "What made you decide to work with us specifically?"
3. "Was there a moment during the project where you felt like you'd picked the right team?"
4. "Did anything unexpected come up, and how did we handle it?"
5. "Now that it's done, what are you most excited about, and would you work with us again?"
6. "What would you say to someone who's on the fence about working with us?"

Film outdoors in front of the finished work, late-afternoon light behind the camera, phone in landscape at chest height, and ask the homeowner to state their first name, city, and project before question one.

Editing: pay for your own editor (it's your personal brand — the videos stay yours if you ever leave). Budget $20-40 per finished 60-90 second video. Fiverr is the easiest place to start; OnlineJobs.ph is cheaper for ongoing volume once you know your format. Before committing to one editor, send a test job with your raw footage, your logo, 2-3 inspiration videos in the style you want, and clear written instructions — a 3-day turnaround test tells you fast whether they're a keeper.

Field deployment is the whole point of doing this. Carry your top 5-10 testimonials, organized by project type, ready to play offline. While you're up on a roof doing an inspection: "While I'm up here, take a look at this — a homeowner in [nearby city], same kind of project. I'll be down in 15 minutes." While you work up numbers: "Give me a few minutes for your exact price — here's another homeowner, similar project, just watch this." By the time you come back with a number, they're comparing you to a successful project they just watched, not to Craigslist contractors. Match the video to whatever objection you're sensing — price, timeline, quality, "let me talk to my spouse," warranty — and know which one kills which objection before you hand over the phone.`,
  },
  {
    id: "05-neighbor-system",
    order: 5,
    title: "The Neighbor System",
    readMinutes: 6,
    category: "neighbors",
    body: `This is where roughly 40% of a franchise's value lives, and it's the easiest, warmest lead in home services — reps skip it because it feels like extra work.

The research: one installed job on a street raises the odds a neighbor buys similar work within a year by about 1.6x. Two installed jobs on a street is the tipping point — the "crowd effect" where a neighborhood shifts from "maybe someday" to "everyone's doing it, when's ours." Three jobs and you own the block. Your job: get to two.

The target is the 5 closest houses — across-left, across-center, across-right, and the two direct neighbors. For unusual layouts, target whichever 5 houses see the most of your job site: the yard sign, the crews, the compressor.

Best timing: days 2-4 of the project, while your crew is visibly on site — neighbors have already noticed, and you're the guy running the visible project across the street, not a cold canvasser. Second-best: the day of the final walk, with the homeowner introducing you.

The knock script (roofing example): "Hey, I'm [name] with Tidal, we're doing [homeowner]'s roof across the street. Quick thing — when I was up there I noticed some of the same wear patterns on yours. Not saying anything's wrong, but the roofs on this block are all about the same age, so I want to check yours too. Zero cost, zero pressure, 15 minutes — morning or afternoon tomorrow?" Adapt the same shape for paint or windows. Always book same-day or next-day — appointments booked more than 48 hours out have a much higher no-show rate than same/next-day ones.

If only one spouse is home, book anyway but get ahead of the "boring my spouse" objection: "I'm sure you make the calls, no worries — this is just an inspection, no decisions needed. But if we find something and you want an exact written price, I'll need both your opinions on styles. So let's make sure you're both around — 2 tomorrow or Saturday at 10?"

If nobody's home, leave a door hanger with a short handwritten note and your cell, and come back in 2-3 days — don't skip it. Track every one of the 5 target houses: names if you learn them, cars in the driveway, home condition, date and result of each knock, and the outcome. Even after a "no," check back every few days during the project — "did anything from our project land in your yard, any debris to clean up?" That keeps you top-of-mind as a caretaker, not a salesman, so when they're ready you're the only contractor they know by name.`,
  },
  {
    id: "06-neighbor-appointment",
    order: 6,
    title: "The Neighbor Appointment Script",
    readMinutes: 4,
    category: "neighbors",
    body: `You booked the appointment — now you have to sit it. Show up like a doctor, not a solicitor: "I'm [name] with Tidal. I've been on your neighbor's roof for three days and spotted the same wear from the ground. Fifteen minutes to tell you if it's real or not" — certain and calm, never apologetic or hopeful.

Point at real damage and name it plainly. On a roof: shiny/exposed shingles ("that's exposed fiberglass — 12-24 months before leaks start"), missing shingles ("water's already getting through the underlayment"), blown ridge caps ("that's where most water intrusion happens"). On stucco: stud or sill cracks, "stucco cancer" bubbling, dark mold spotting. The line to use every time: "If you can see it from the street, the damage is 10x worse underneath" — it reframes visible wear as the tip of the iceberg and justifies the full look.

After pointing out damage, ask in order: any leaks or ceiling stains? When did you last check the attic — daylight, smell? Anyone with worse respiratory issues lately? When was this last done? Each answer ties the damage to their actual life, not an abstraction.

If only one spouse showed up, don't give a written price today: "I'll do the full inspection now, but if we find something, I want both of you to see the options together — that's not a sales tactic, it just means we don't have this conversation twice. What works tomorrow, 4:30 or 6:30?" That protects the appointment and books the real sit.

Before showing any price, set the stage: "Here's how this goes — I inspect, tell you exactly what I see, show you our license and insurance, then if you want to move forward we go through styles and land on one exact written price today, not an emailed ballpark. Sound fair?" Then close with two words once you've walked the whole thing: "The price is [X]. Fair enough?" And if you booked a follow-up: "Our office will call in the next 5-10 minutes to confirm — if you don't answer we assume something changed and won't hold the slot. Fair?" — that forces the phone pickup and cements the appointment.`,
  },
  {
    id: "07-reload-playbook",
    order: 7,
    title: "The Reload Playbook",
    readMinutes: 2,
    category: "reload",
    body: `The rhythm: BIG sale, then a small reload, then a BIG reload. Your original canvass sale is big. The first reload is small and easy — planted at the sale, closed about 5 days pre-start. The second reload, mid-project, is the big one. Job end is too late for most reloads — the homeowner's in "glad that's over" mode by then, so get the seeds in early.

By original sale, the natural reload menu:

- Roof sale → insulation (5 days pre-start, small ticket) → full-house paint (mid-project, using the fascia/eaves compromise as the reason) → patio cover (final walk).
- Paint sale → gutters (pre-start) → full-house windows (mid-project, using the paint-prep synergy) → patio cover or landscape/turf (final walk).
- Window sale → front door (same day) → full-home paint or stucco repair (mid-project) → backyard project (final walk).
- Turf/pavers/patio → landscape lighting (same day) → full-home paint (mid-project, "you'll want it to match") → roof or windows (final walk).

An advanced move: bake 1-3 new front-facing windows into the original roof or paint quote at cost, without calling them out as "extra." Six months later, when you swing by to check in, the homeowner sees new windows up front and old ones everywhere else — and asks YOU about doing the rest. Zero pitching, and the reload closes far faster than a cold pitch would.

The patio cover reload works best sitting on the actual patio at the final walk: "Mind if we sit outside a minute?" Let them see their own worn patio through your eyes before you say anything. Then: "You'll paint this every 2-3 years, replace the wood in five. There's a never-paint-again option I don't push on everyone, but when we run our big sale event a couple times a year, want me to keep you on the shortlist?" — now they're waiting on your call instead of the other way around.

One rule that matters more than any script: never pitch a reload if the homeowner is unhappy with anything in the current project. Fix the complaint first. A reload pitched on top of a complaint kills trust for the whole franchise.`,
  },
  {
    id: "08-final-walk",
    order: 8,
    title: "The Final Walk Playbook",
    readMinutes: 6,
    category: "final-walk",
    body: `This is the 60-90 minute meeting most reps rush in 20. Don't. Everything the franchise is worth lives in this hour. The day before: confirm both spouses will be there, charge your phone, bring your Marketing Home referral form, and bring a small closing gift under $30.

1. Walk the work (15-20 min) — every inch, asking "does this meet your expectations" at each zone, and fix or schedule any punch-list item before you leave.

2. Photos and video (10-15 min) — your before/after grid, detail shots of finished work, a photo with the homeowner, and the 60-90 second video testimonial (see the Video Engine section for the exact six questions).

3. The Google review, done IN PERSON (5 min) — never "I'll send the link later." Hand them a QR card on the spot: "Would you leave us a review? Sixty seconds — and please put my first name in it, that's how the company tracks who worked with you, and it helps my future customers know they'll get me." Stand there while they do it, read it, thank them.

4. Collect the Marketing Home referrals (10 min) — they agreed to this at the sale, so this is collecting, not asking: "Who do you know that might be thinking about work in the next 12 months? Anyone with a house older than 10 years, kids graduating, anyone who's mentioned refinancing." Get names AND phone numbers, then ask for a warm text-thread intro right there: "Can you put me in a thread with them and just say 'this is [name] with Tidal, they just finished my roof'?" Follow up within the hour, and if there's no response in 2-3 days, call — voice beats text for response rate.

5. The neighbor introduction (10 min) — while you're still there, walking the property: "Who's that? Are they nice? Any idea what their house might need?" for each of the 5 target houses, then ask for a live intro to anyone who happens to be outside.

6. The marketing deliverables handoff (5 min) — tell them their edited video, before/after photos, and a copy-paste social post are coming by text today, and remind them the easiest way to earn the referral checks is posting the before/after themselves.

7. The "small favor" seed (2 min) — "Can I ask a small favor? Sometime in the next week, post about your project in your Nextdoor or Facebook group — no rush." This is what you come back to at the +7 day check-in.

8. Book the +7 day touch before you leave.`,
  },
  {
    id: "09-referral-extraction",
    order: 9,
    title: "The Referral Extraction System",
    readMinutes: 3,
    category: "referrals",
    body: `Never ask "do you know anyone" — it's a dead question, and every homeowner says "not really, let me think about it" and never does. Ask by category instead; categories jog memory:

- Who at your workplace has mentioned wanting to fix up their home?
- Anyone in your family who bought a house recently?
- Neighbors on other streets who've mentioned a project?
- Anyone at your gym, church, or your kids' school?
- Who's the last friend who complained to you about their contractor?

People buy home improvement when their life changes — ask specifically about trigger events: refinancing or a cash-out, kids graduating (the empty-nest "let's finally fix up the house" moment), retirement, listing or buying a home, or a new baby or adult child moving back in and needing the space redone. "Do you know anyone going through any of these right now?" surfaces names a generic question never will.

Work the ask in two passes, not one. The first ask happens at the final walk, framed as a small favor ("Can I ask you a small favor? Whenever you get a chance, think of 2-3 people to introduce me to"). The second ask happens at the +7 day check-in, as a callback to that favor — most homeowners haven't gotten to it yet, and the reminder alone, framed with a little friendly guilt, is usually what finally produces the names. If they did follow through, that's even better — thank them and ask who else comes to mind now that the project's behind them and they're looking at it with fresh eyes.

This section of the source playbook runs longer than what's captured here — a follow-up content pass can extend it without touching anything else in the Learn tab.`,
  },
];
