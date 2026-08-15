import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArcadePanel } from "@/components/arcade";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ObjectionDojo } from "@/components/ObjectionDojo";
import {
  CATEGORY_LABEL,
  TRAINING_VIDEOS,
  formatTimestamp,
  youtubeEmbedUrl,
  type Transcript,
  type TrainingVideo,
} from "@/data/training-videos";
import { Clapperboard, PlayCircle, ScrollText, Search, X } from "lucide-react";

/**
 * The Mission page's Learn tab: the SCCE training library (YouTube-unlisted
 * embeds + local mlx-whisper transcripts searched client-side, jump straight
 * to the moment a phrase is said) and the Objection Dojo below it.
 */

type SearchHit = {
  video: TrainingVideo;
  start: number;
  text: string;
};

const MIN_QUERY = 3;
const MAX_HITS = 24;

const EMPTY_TRANSCRIPT: Transcript = { segments: [] };

function useTranscripts() {
  // ~50KB total across 11 files — fetch once, cache for the session.
  return useQuery({
    queryKey: ["training_transcripts"],
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async () => {
      const entries = await Promise.all(
        TRAINING_VIDEOS.map(async (v): Promise<[string, Transcript]> => {
          try {
            const res = await fetch(`/transcripts/${v.id}.json`);
            if (!res.ok) return [v.id, EMPTY_TRANSCRIPT];
            return [v.id, (await res.json()) as Transcript];
          } catch {
            return [v.id, EMPTY_TRANSCRIPT];
          }
        }),
      );
      return new Map(entries);
    },
  });
}

export function LearnPanel() {
  const transcripts = useTranscripts();
  const [query, setQuery] = useState("");
  const [player, setPlayer] = useState<{ video: TrainingVideo; start: number } | null>(null);

  const hits = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < MIN_QUERY || !transcripts.data) return [];
    const out: SearchHit[] = [];
    for (const video of TRAINING_VIDEOS) {
      const t = transcripts.data.get(video.id);
      if (!t) continue;
      let perVideo = 0;
      for (const seg of t.segments) {
        if (perVideo >= 4 || out.length >= MAX_HITS) break;
        if (seg.text.toLowerCase().includes(q)) {
          out.push({ video, start: seg.start, text: seg.text });
          perVideo++;
        }
      }
      if (out.length >= MAX_HITS) break;
    }
    return out;
  }, [query, transcripts.data]);

  const open = (video: TrainingVideo, start = 0) => {
    setPlayer({ video, start });
    // The player panel sits directly under the search box — bring it into view.
    requestAnimationFrame(() =>
      document
        .getElementById("learn-player")
        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  };

  const featured = TRAINING_VIDEOS.find((v) => v.featured);
  const rest = TRAINING_VIDEOS.filter((v) => !v.featured);

  return (
    <div className="space-y-8">
      <ArcadePanel
        title="Training Search"
        action={
          <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            {TRAINING_VIDEOS.length} videos · word-for-word
          </span>
        }
      >
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Search everything said in training — try "urgency"'
            className="pl-9"
          />
        </div>
        {query.trim().length >= MIN_QUERY && (
          <ul className="mt-4 divide-y divide-border">
            {hits.length === 0 ? (
              <li className="py-3 text-sm text-muted-foreground">
                No mention of that yet — try a shorter phrase.
              </li>
            ) : (
              hits.map((h, i) => (
                <li key={`${h.video.id}-${h.start}-${i}`}>
                  <button
                    type="button"
                    onClick={() => open(h.video, h.start)}
                    className="w-full text-left py-2.5 px-2 rounded hover:bg-surface"
                  >
                    <span className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-neon">
                      <PlayCircle className="w-3.5 h-3.5" />
                      {h.video.title}
                      {h.video.speaker ? ` · ${h.video.speaker}` : ""} · {formatTimestamp(h.start)}
                    </span>
                    <span className="mt-1 block text-sm text-muted-foreground">“{h.text}”</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </ArcadePanel>

      {player && (
        <div id="learn-player">
          <ArcadePanel
            title={
              player.video.speaker
                ? `${player.video.title} · ${player.video.speaker}`
                : player.video.title
            }
            action={
              <Button variant="ghost" onClick={() => setPlayer(null)}>
                <X className="w-3.5 h-3.5 mr-1.5" /> Close
              </Button>
            }
          >
            {player.video.youtubeId ? (
              <div className="relative w-full overflow-hidden rounded-lg border border-border bg-black aspect-video">
                <iframe
                  key={`${player.video.id}-${player.start}`}
                  src={youtubeEmbedUrl(player.video.youtubeId, player.start, true)}
                  title={player.video.title}
                  className="absolute inset-0 w-full h-full border-0"
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                This video hasn't been uploaded to the company YouTube channel yet — the transcript
                is already searchable, and the play button lights up the moment the link is added.
              </p>
            )}
          </ArcadePanel>
        </div>
      )}

      <div className="space-y-4">
        <div>
          <h2 className="font-display text-sm uppercase tracking-[0.25em] text-neon">
            Training Library
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            The script and the playbook behind it — straight from the people who run it.
          </p>
        </div>

        {featured && (
          <button
            type="button"
            onClick={() => open(featured)}
            className="w-full text-left relative overflow-hidden rounded-xl border-2 border-[color-mix(in_oklab,var(--neon)_55%,transparent)] bg-[linear-gradient(140deg,color-mix(in_oklab,var(--neon)_10%,var(--surface)),color-mix(in_oklab,var(--victory)_6%,var(--surface)))] p-6 hover:opacity-95 transition"
          >
            <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-neon">
              <ScrollText className="w-3.5 h-3.5" /> {CATEGORY_LABEL[featured.category]}
            </div>
            <div className="mt-2 font-display text-xl text-foreground">
              {featured.title}
              {featured.speaker ? ` · ${featured.speaker}` : ""}
            </div>
            <div className="mt-2 text-xs text-muted-foreground">
              The script works — watch why copying success beats improvising.
            </div>
          </button>
        )}

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {rest.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => open(v)}
              className="text-left relative overflow-hidden rounded-lg border border-border bg-surface p-4 hover:border-[color-mix(in_oklab,var(--neon)_45%,var(--border))] transition"
            >
              <div className="flex items-center gap-1.5 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                <Clapperboard className="w-3 h-3" /> {CATEGORY_LABEL[v.category]}
              </div>
              <div className="mt-2 font-display text-sm text-foreground leading-snug">
                {v.title}
                {v.speaker ? ` · ${v.speaker}` : ""}
              </div>
              <div className="mt-2 text-[10px] font-display uppercase tracking-widest">
                {v.youtubeId ? (
                  <span className="text-victory">▶ Watch</span>
                ) : (
                  <span className="text-warning">Upload pending</span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      <ObjectionDojo />
    </div>
  );
}
