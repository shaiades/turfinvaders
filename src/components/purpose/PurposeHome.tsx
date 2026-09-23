// §18 — the rep's Purpose Home: the purpose card, the real-numbers
// scoreboard, the optional weekly reflection, and the contextual reminder
// line. No tracking, no streaks, no scores — a stable place to re-read what
// you're building and why.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import type { AnswerMap, Visibility } from "@/lib/purpose/types";
import {
  EMPTY_STATE_COPY,
  REVIEW_SECTIONS,
  SCOREBOARD_COPY,
  pickReminderLine,
} from "@/data/purpose-workshop-content";
import { usePurposeAnswers } from "@/hooks/usePurposeAnswers";
import { usePurposeReflections, useSaveReflection } from "@/hooks/usePurposeReflections";
import { usePurposeScoreboard } from "@/hooks/usePurposeScoreboard";
import { purposeTable, type PurposeLeadershipNoteRow, type PurposeProfileRow } from "@/hooks/usePurposeTable";
import { PurposeButton, PurposeCard, PurposeLabel, PurposeProgress, PurposeTextarea } from "./kit";
import { VisibilityToggle } from "./steps";
import { useRepGoal } from "@/hooks/useRepGoal";

const PURPOSE_CARD_LABELS = new Set([
  "MY ONE-YEAR TARGET",
  "MY CORE WHY",
  "WHAT I AM TRYING TO CREATE OR PROTECT",
  "MY 90-DAY MISSION",
  "THE STORY I AM QUESTIONING",
  "MY IF–THEN PLAN",
  "MY 90-DAY IDENTITY COMMITMENT",
]);

const fmtMoney = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const fmtPct = (p: number | null) => (p == null ? "—" : `${Math.round(p * 100)}%`);

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[var(--purpose-line)] p-3 text-center">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wider text-[var(--purpose-ink-dim)]">{label}</div>
    </div>
  );
}

export function PurposeHome({
  profile,
  displayName,
  isPreviewingOtherName,
}: {
  profile: PurposeProfileRow;
  displayName: string | null;
  isPreviewingOtherName?: boolean;
}) {
  const answersQuery = usePurposeAnswers(profile.id);
  const answers = (answersQuery.data ?? {}) as AnswerMap;
  const scoreboard = usePurposeScoreboard(displayName, true);
  const goal = useRepGoal(profile.user_id);
  const reflections = usePurposeReflections(profile.id);
  const saveReflection = useSaveReflection(profile);
  const [reflectionDraft, setReflectionDraft] = useState("");
  const [reflectionVisibility, setReflectionVisibility] = useState<Visibility>("private_to_rep");

  const notesQuery = useQuery({
    queryKey: ["purpose_notes_rep", profile.id],
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await purposeTable("purpose_leadership_notes")
        .select("*")
        .eq("purpose_profile_id", profile.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PurposeLeadershipNoteRow[];
    },
  });

  const cardRows = REVIEW_SECTIONS.map((s) => ({
    label: s.label,
    value: s.render(answers, { maskPrivate: false }),
  })).filter((r) => PURPOSE_CARD_LABELS.has(r.label) && r.value);

  const week = scoreboard.week;
  const volumeGoal = goal.data ?? null;
  const goalPct =
    volumeGoal && volumeGoal > 0 && week ? Math.min(100, (week.revenue / volumeGoal) * 100) : null;

  return (
    <div className="purpose-surface min-h-dvh">
      <div className="mx-auto w-full max-w-2xl px-4 pt-safe pb-16">
        {/* §18.4 contextual reminder — a quiet line, never a popup. */}
        <p className="pt-7 text-sm italic leading-relaxed text-[var(--purpose-sand)]">
          {pickReminderLine(answers)}
        </p>

        {/* Section 1 — Purpose card */}
        <PurposeCard className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Compass className="size-5 text-[var(--purpose-tide)]" aria-hidden />
              <h1 className="text-xl">My Purpose</h1>
            </div>
            <Link
              to="/my-purpose/workshop"
              search={{ review: true }}
              className="text-sm text-[var(--purpose-tide)] hover:underline"
            >
              Review and edit my Purpose
            </Link>
          </div>
          <div className="mt-5 space-y-4">
            {cardRows.map((r) => (
              <div key={r.label}>
                <PurposeLabel>{r.label}</PurposeLabel>
                <p className="mt-1 whitespace-pre-line text-base leading-relaxed">{r.value}</p>
              </div>
            ))}
          </div>
        </PurposeCard>

        {/* Coaching note — only when a leader deliberately shared one. */}
        {(notesQuery.data ?? []).length > 0 && (
          <PurposeCard className="mt-4">
            <PurposeLabel>Coaching Note</PurposeLabel>
            <div className="mt-2 space-y-3">
              {(notesQuery.data ?? []).map((n) => (
                <p key={n.id} className="text-base leading-relaxed">
                  {n.note_text}
                </p>
              ))}
            </div>
          </PurposeCard>
        )}

        {/* Section 2 — My Current Scoreboard (real numbers only) */}
        <PurposeCard className="mt-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg">My Current Scoreboard</h2>
            <Link
              to="/close-kombat"
              search={{ tab: "stats" }}
              className="text-sm text-[var(--purpose-tide)] hover:underline"
            >
              View My Performance
            </Link>
          </div>
          {isPreviewingOtherName && (
            <p className="mt-1 text-xs text-[var(--purpose-sand)]">Scoreboard preview: {displayName}</p>
          )}
          {scoreboard.loading ? (
            <p className="mt-3 text-sm text-[var(--purpose-ink-dim)]">Loading this week…</p>
          ) : !scoreboard.matched || !week ? (
            <p className="mt-3 text-sm leading-relaxed text-[var(--purpose-ink-dim)]">
              {EMPTY_STATE_COPY.no_crm}
            </p>
          ) : (
            <>
              <PurposeLabel className="mt-4">This week</PurposeLabel>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Sits" value={week.pm + week.sold} />
                <Stat label="Sales" value={week.sold} />
                <Stat label="Volume" value={fmtMoney(week.revenue)} />
                <Stat label="Close" value={fmtPct(week.closePct)} />
              </div>
              {scoreboard.trailing && (
                <p className="mt-3 text-xs leading-relaxed text-[var(--purpose-ink-dim)]">
                  Trailing 2 weeks: {scoreboard.trailing.sold} sales ·{" "}
                  {fmtMoney(scoreboard.trailing.revenue)} volume
                </p>
              )}
              {volumeGoal && volumeGoal > 0 ? (
                <div className="mt-4">
                  <div className="flex items-center justify-between text-xs text-[var(--purpose-ink-dim)]">
                    <span>Toward your weekly volume goal</span>
                    <span className="tabular-nums">
                      {fmtMoney(week.revenue)} / {fmtMoney(volumeGoal)}
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <PurposeProgress pct={goalPct ?? 0} />
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-xs text-[var(--purpose-ink-dim)]">
                  Set your weekly goal in{" "}
                  <Link to="/close-kombat" search={{ tab: "goals" }} className="text-[var(--purpose-tide)] hover:underline">
                    Close Kombat → Goals
                  </Link>
                  .
                </p>
              )}
            </>
          )}
          <p className="mt-4 text-sm italic text-[var(--purpose-ink-dim)]">{SCOREBOARD_COPY.feedbackLine}</p>
        </PurposeCard>

        {/* Section 3 — Weekly Reflection */}
        <PurposeCard className="mt-4">
          <h2 className="text-lg">Weekly Reflection</h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--purpose-ink-dim)]">
            What did you learn this week about the person you are becoming?
          </p>
          <PurposeTextarea
            value={reflectionDraft}
            onChange={(e) => setReflectionDraft(e.target.value)}
            className="mt-3 min-h-24"
            placeholder="Optional — a sentence is plenty."
          />
          <VisibilityToggle visibility={reflectionVisibility} onChange={setReflectionVisibility} />
          <div className="mt-4">
            <PurposeButton
              tone="ghost"
              disabled={!reflectionDraft.trim() || saveReflection.isPending}
              onClick={() => {
                saveReflection
                  .mutateAsync({ answer_text: reflectionDraft.trim(), visibility: reflectionVisibility })
                  .then(() => setReflectionDraft(""))
                  .catch(() => undefined);
              }}
            >
              Save Reflection
            </PurposeButton>
          </div>
          {(reflections.data ?? []).length > 0 && (
            <div className="mt-5 space-y-3 border-t border-[var(--purpose-line)] pt-4">
              {(reflections.data ?? []).slice(0, 5).map((r) => (
                <div key={r.id}>
                  <PurposeLabel>
                    {r.reflection_date}
                    {r.visibility === "private_to_rep" ? " · private" : " · shared"}
                  </PurposeLabel>
                  <p className="mt-1 text-sm leading-relaxed">{r.answer_text}</p>
                </div>
              ))}
            </div>
          )}
        </PurposeCard>
      </div>
    </div>
  );
}
