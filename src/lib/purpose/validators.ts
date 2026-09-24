// My Purpose — pure answer-quality detectors. Composed into StepDef.validate
// by the content file; no React, no supabase, no side effects, so the verify
// script can exercise every branch. Each detector runs on normalize()d input
// and matches whole words/phrases only — "I have not yet consistently
// followed up" must NOT trip the "not good enough" family, and a long answer
// that merely contains "be happy" is not vague.
//
// Empty/undefined-ish input is a MISSING answer, not a bad one: every
// detector returns false for it (required-ness gates blanks elsewhere).
// The one exception is detectIDontKnow, where an effectively-empty answer
// IS the "I don't know" signal.

// ---------------------------------------------------------------------------
// Normalization + regex plumbing
// ---------------------------------------------------------------------------

/** Lowercase, curly→straight apostrophes, collapse whitespace, trim, strip
 *  terminal punctuation. Every detector sees only this form, so phrase lists
 *  below are written lowercase with straight apostrophes and single spaces. */
export function normalize(text: string): string {
  if (typeof text !== "string") return "";
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:…]+$/, "")
    .trim();
}

/** One phrase → a regex fragment: escaped, apostrophe-optional (so "i can't"
 *  also matches "i cant"), words joined by single spaces (normalize collapsed
 *  runs already). */
function phraseSource(phrase: string): string {
  return phrase
    .split(" ")
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "'?"))
    .join(" ");
}

/** Word-boundary alternation over a phrase list, built once at module level. */
function phraseRegex(phrases: readonly string[], flags = ""): RegExp {
  return new RegExp(`\\b(?:${phrases.map(phraseSource).join("|")})\\b`, flags);
}

/** Whitespace-split tokens with edge punctuation shaved off (normalize only
 *  strips TERMINAL punctuation, so "rich, happy" still carries a comma). */
function tokenize(text: string): string[] {
  return text
    .split(" ")
    .map((t) => t.replace(/^[^a-z0-9$']+/, "").replace(/[^a-z0-9$']+$/, ""))
    .filter((t) => t.length > 0);
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

// Generic function-word list shared by detectRepeatsGoal (content-word sets)
// and detectNonObservable ("other content words" count). Deliberately broad
// but excludes time words (year/month/day) — a 90-day mission and a 1-year
// target legitimately differ on those.
const GENERIC_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "so", "if", "then", "than",
  "to", "of", "in", "on", "at", "by", "for", "with", "from", "as", "into",
  "about", "over", "under", "after", "before", "up", "out", "off",
  "is", "are", "was", "were", "be", "being", "been", "am",
  "do", "does", "did", "have", "has", "had", "having",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "i", "i'm", "im", "i'll", "me", "my", "mine", "myself",
  "we", "our", "us", "you", "your", "he", "she", "it", "its",
  "they", "them", "their", "this", "that", "these", "those",
  "not", "no", "yes", "just", "really", "very", "more", "most", "some", "any",
  "want", "wants", "wanted", "get", "got", "getting", "go", "going",
  "like", "also", "too", "there", "here", "what", "when", "how", "because",
]);

// ---------------------------------------------------------------------------
// Predictive identity (FACT-field rewrite gate)
// ---------------------------------------------------------------------------

const PREDICTIVE_IDENTITY_RE = phraseRegex([
  "i am not good enough",
  "i'm not good enough",
  "not good enough",
  "i can't",
  "i cant",
  "i can not",
  "i will never",
  "i'll never",
  "i'm not the type",
  "im not the type",
  "not the kind of person",
  "i could never",
  "people like me don't",
  "people like me dont",
  "people like me never",
]);

/** True when the text predicts the future from identity ("I'll never…")
 *  rather than stating something observable ("I made $90,000 last year"). */
export function detectPredictiveIdentity(text: string): boolean {
  const n = normalize(text);
  if (!n) return false;
  return PREDICTIVE_IDENTITY_RE.test(n);
}

// ---------------------------------------------------------------------------
// Vagueness ("be successful" tells us nothing to build a plan on)
// ---------------------------------------------------------------------------

// Filler tokens are only stripped for THIS detector — "be"/"more" are fillers
// here but content everywhere else.
const VAGUE_FILLERS = new Set([
  "i", "want", "to", "just", "be", "being", "a", "an", "the", "more",
  "really", "get", "my", "would", "like", "and",
]);

// Multi-word vague phrases must be removed from the STRING before token
// filtering: "do better" survives filler-stripping as ["do", "better"]
// otherwise, since "do" is not a filler. Longest first so "make more money"
// wins over "more money".
const VAGUE_PHRASES_RE = phraseRegex(
  ["make more money", "more money", "be happy", "do better", "be better"],
  "g",
);

const VAGUE_WORDS = new Set([
  "successful", "success", "succeed", "money", "rich", "wealthy",
  "happy", "happier", "better",
]);

/** True for answers too thin to work with: under 10 non-whitespace chars, or
 *  a short (<~40 char) answer that reduces entirely to vague-word mush once
 *  fillers are stripped. Length gate first — a long, specific answer that
 *  happens to contain "be happy" is fine. */
export function detectVague(text: string): boolean {
  const n = normalize(text);
  if (!n) return false;
  if (nonWhitespaceLength(n) < 10) return true;
  if (n.length >= 40) return false;
  const rest = n.replace(VAGUE_PHRASES_RE, " ");
  const remaining = tokenize(rest).filter((t) => !VAGUE_FILLERS.has(t) && !VAGUE_WORDS.has(t));
  return remaining.length === 0;
}

// ---------------------------------------------------------------------------
// External-only attribution ("they got lucky")
// ---------------------------------------------------------------------------

const EXTERNAL_STOPWORDS = new Set([
  "they", "them", "their", "got", "get", "was", "were", "just", "have", "had",
  "a", "an", "the", "more", "better", "of", "with", "than", "me", "i", "it",
  "and", "or", "some", "luckier",
]);

const EXTERNAL_FACTORS = new Set([
  "luck", "lucky", "luckier", "leads", "lead", "flow",
  "connections", "connected", "connection", "nothing", "timing",
  "territory", "territories", "market", "area", "areas",
]);

/** True when EVERY content word blames circumstances (luck, leads, territory…)
 *  with nothing the rep controls. One behavioral word ("…but they also
 *  followed up every day") clears it. Empty-after-stopwords clears it too —
 *  we can't call an answer external-only when there's no content to judge. */
export function detectExternalOnly(text: string): boolean {
  const n = normalize(text);
  if (!n) return false;
  const content = tokenize(n).filter((t) => !EXTERNAL_STOPWORDS.has(t));
  if (content.length === 0) return false;
  return content.every((t) => EXTERNAL_FACTORS.has(t));
}

// ---------------------------------------------------------------------------
// Non-observable effort platitudes ("try harder")
// ---------------------------------------------------------------------------

const PLATITUDE_PHRASES = [
  "try harder",
  "work harder",
  "work more",
  "be better",
  "do better",
  "stay motivated",
  "be motivated",
  "get motivated",
  "be more motivated",
  "do my best",
  "push myself",
] as const;

const PLATITUDES_RE = phraseRegex(PLATITUDE_PHRASES);
const PLATITUDES_STRIP_RE = phraseRegex(PLATITUDE_PHRASES, "g");

// Spelled-out quantity + time unit ("ten minutes"). Digit-led durations
// ("10 minutes") are already caught by the digit check.
const DURATION_RE = new RegExp(
  "\\b(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|sixty|half an?|an?|a few|couple of?)" +
    " (?:minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks|month|months)\\b",
);

/** True only for PURE platitudes — the reprompt exists to turn "try harder"
 *  into something a camera could verify. A platitude alongside anything
 *  concrete (a digit, a spelled-out duration, or six-plus other content
 *  words) passes: the rep already added the observable part. */
export function detectNonObservable(text: string): boolean {
  const n = normalize(text);
  if (!n) return false;
  if (!PLATITUDES_RE.test(n)) return false;
  if (/\d/.test(n)) return false;
  if (DURATION_RE.test(n)) return false;
  const rest = n.replace(PLATITUDES_STRIP_RE, " ");
  const otherContent = tokenize(rest).filter((t) => !GENERIC_STOPWORDS.has(t));
  return otherContent.length < 6;
}

// ---------------------------------------------------------------------------
// Evidence check (screen 4.2 — positive detector)
// ---------------------------------------------------------------------------

const MONTHS_RE = phraseRegex([
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
]);

const EVIDENCE_VERBS_RE = phraseRegex([
  "complete", "completed", "finish", "finished", "save", "saved", "pay",
  "paid", "reach", "reached", "close", "closed", "earn", "earned", "build",
  "built", "move", "moved", "train", "trained", "lead", "led", "hit",
  "improve", "improved", "buy", "bought", "run", "launch", "achieve",
]);

/** Positive check: does the answer contain something we could point at —
 *  a number, a dollar sign, a month, or a completion verb? */
export function hasRecognizableEvidence(text: string): boolean {
  const n = normalize(text);
  if (!n) return false;
  if (/\d/.test(n)) return true;
  if (n.includes("$")) return true;
  if (MONTHS_RE.test(n)) return true;
  return EVIDENCE_VERBS_RE.test(n);
}

// ---------------------------------------------------------------------------
// Mission repeats the 1-year goal (Jaccard over content-word sets)
// ---------------------------------------------------------------------------

function contentWordSet(normalized: string): Set<string> {
  return new Set(tokenize(normalized).filter((t) => !GENERIC_STOPWORDS.has(t)));
}

/** True when the 90-day mission is just the 1-year goal restated: identical
 *  after normalize, or content-word Jaccard ≥ 0.6. Either side empty → false
 *  (nothing to compare — missing answers are handled elsewhere). */
export function detectRepeatsGoal(mission: string, oneYear: string): boolean {
  const a = normalize(mission);
  const b = normalize(oneYear);
  if (!a || !b) return false;
  if (a === b) return true;
  const setA = contentWordSet(a);
  const setB = contentWordSet(b);
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return false;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / union.size >= 0.6;
}

// ---------------------------------------------------------------------------
// "I don't know" (the one detector where empty text counts as a hit)
// ---------------------------------------------------------------------------

const IDK_RE = phraseRegex([
  "i don't know",
  "i dont know",
  "idk",
  "not sure", // also covers "i'm not sure"
  "unsure",
  "no idea",
  "dunno",
]);

/** True for shrug answers, INCLUDING effectively-empty text — a blank here
 *  means the same thing as "idk", so the step can route to its stuck path. */
export function detectIDontKnow(text: string): boolean {
  const n = normalize(text);
  if (nonWhitespaceLength(n) < 10) return true;
  return IDK_RE.test(n);
}

// ---------------------------------------------------------------------------
// Crisis language — conservative-but-broad on purpose. This NEVER blocks
// saving; callers show CRISIS_RESOURCES_COPY alongside and keep the answer.
// ---------------------------------------------------------------------------

const CRISIS_RE = phraseRegex([
  "kill myself",
  "killing myself",
  "suicide",
  "suicidal",
  "end my life",
  "ending my life",
  "want to die",
  "wanna die",
  "don't want to be alive",
  "dont want to be alive",
  "don't want to live",
  "hurt myself",
  "hurting myself",
  "harm myself",
  "self harm",
  "self-harm",
  "no reason to live",
  "better off dead",
  "end it all",
  "take my own life",
  // harm to others
  "hurt someone",
  "hurting someone",
  "kill someone",
]);

export function detectCrisis(text: string): boolean {
  const n = normalize(text);
  if (!n) return false;
  return CRISIS_RE.test(n);
}

/** Why Level 3's "material outcome only" check (spec §16: e.g. "I can buy a
 *  car" earns the deeper what-would-that-make-you-feel reprompt). Fires on a
 *  SHORT answer built around an acquisition verb with no value/feeling
 *  language; longer answers or anything already naming a value pass. */
const MATERIAL_VERB_RE = /\b(buy|bought|get|got|own|have|drive|afford|purchase|upgrade)\b/;
const VALUE_WORD_RE =
  /\b(feel|feels|feeling|protect|prove|allow|respect|freedom|free|security|secure|safe|peace|family|kids?|children|proud|pride|growth|grow|courage|discipline|reliable|reliability|leader|leadership|contribute|contribution|belong|mastery|responsib\w*|independen\w*|health|legacy|stress|confiden\w*|trust|present|stability|stable)\b/;

export function detectMaterialOnly(text: string): boolean {
  const n = normalize(text);
  if (!n) return false;
  if (n.length > 80) return false;
  return MATERIAL_VERB_RE.test(n) && !VALUE_WORD_RE.test(n);
}

/** Shown when detectCrisis fires. Compassionate and plain — not counseling,
 *  no shame, and it must be clear their answer was not blocked or exposed. */
export const CRISIS_RESOURCES_COPY: {
  headline: string;
  body: string;
  resources: string[];
} = {
  headline: "Before anything else — you matter.",
  body:
    "Something you wrote sounds heavy, and we want to make sure you know " +
    "help is out there. This app isn't a counselor and won't try to be one, " +
    "but real people are ready to listen right now. Your answer is saved and " +
    "stays private per your settings — nothing here is blocked or shared " +
    "because of this note.",
  resources: [
    "988 Suicide & Crisis Lifeline — call or text 988 (US), any time",
    "Call 911 if you or someone else is in immediate danger",
    "Reach out to someone you trust — a friend, family member, or teammate",
    "A licensed therapist or doctor can help you find footing",
  ],
};
