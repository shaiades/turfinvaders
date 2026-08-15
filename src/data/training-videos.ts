/** The SCCE training library (owner-supplied videos, 2026-08-14).
 *
 *  Hosting: YouTube UNLISTED on the company channel — adaptive quality on
 *  LTE in the field, zero egress cost (owner decision 2026-08-14).
 *  `youtubeId: null` = the owner hasn't uploaded/pasted that link yet; the
 *  card renders as "upload pending" until the id lands here.
 *
 *  Search: each video has a transcript at /transcripts/<id>.json
 *  (mlx-whisper, generated locally) — `{ segments: [{ start, text }] }`.
 *  The Learn tab fetches them lazily and searches client-side.
 */

export type TrainingCategory = "script" | "keys" | "mindset" | "culture" | "quickstart";

export type TrainingVideo = {
  /** Slug — also the transcript filename under /transcripts/. */
  id: string;
  title: string;
  speaker?: string;
  youtubeId: string | null;
  category: TrainingCategory;
  /** Pinned to the top of the library (the script is the product). */
  featured?: boolean;
};

export const CATEGORY_LABEL: Record<TrainingCategory, string> = {
  script: "The Script",
  keys: "Keys to Success",
  mindset: "Mindset",
  culture: "Culture",
  quickstart: "Quickstart",
};

export const TRAINING_VIDEOS: TrainingVideo[] = [
  {
    id: "why-stick-to-the-script",
    title: "Why Stick to the Script",
    speaker: "Shai",
    youtubeId: null,
    category: "script",
    featured: true,
  },
  {
    id: "new-rep-quickstart",
    title: "New Rep Quickstart Program",
    youtubeId: null,
    category: "quickstart",
  },
  {
    id: "3-keys-to-success",
    title: "3 Keys to Success",
    speaker: "Shai",
    youtubeId: null,
    category: "keys",
  },
  {
    id: "who-is-scce",
    title: "Who is SCCE — Past · Present · Future",
    speaker: "Shai",
    youtubeId: null,
    category: "culture",
  },
  {
    id: "core-culture-values",
    title: "Core Culture Values",
    youtubeId: null,
    category: "culture",
  },
  {
    id: "mindset-buy-in",
    title: "Mindset · Buy-In",
    youtubeId: null,
    category: "mindset",
  },
  {
    id: "work-ethic",
    title: "Work Ethic",
    youtubeId: null,
    category: "mindset",
  },
  {
    id: "why-scce-alex",
    title: "Why SCCE, Keys to Success",
    speaker: "Alex",
    youtubeId: null,
    category: "keys",
  },
  {
    id: "why-scce-darian",
    title: "Why SCCE, Keys to Success",
    speaker: "Darian",
    youtubeId: null,
    category: "keys",
  },
  {
    id: "why-scce-donald",
    title: "Why SCCE, Keys to Success",
    speaker: "Donald",
    youtubeId: null,
    category: "keys",
  },
  {
    id: "why-scce-jorge",
    title: "Why SCCE, Keys to Success",
    speaker: "Jorge",
    youtubeId: null,
    category: "keys",
  },
];

export type TranscriptSegment = { start: number; text: string };
export type Transcript = { segments: TranscriptSegment[] };

export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** youtube-nocookie embed URL, optionally seeked. */
export function youtubeEmbedUrl(youtubeId: string, startSeconds = 0, autoplay = false): string {
  const params = new URLSearchParams({
    rel: "0",
    modestbranding: "1",
    ...(startSeconds > 0 ? { start: String(Math.floor(startSeconds)) } : {}),
    ...(autoplay ? { autoplay: "1" } : {}),
  });
  return `https://www.youtube-nocookie.com/embed/${youtubeId}?${params.toString()}`;
}
