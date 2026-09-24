// §19.3 Section F — exactly the four V1 leadership actions: add a private
// note (visible-to-rep is a deliberate opt-in), set a follow-up date, set a
// coaching status, and write the next coaching action (with the spec's seven
// templates). Follow-up/status/next-action save together through
// useUpdateLeadershipFields, which also stamps last_reviewed_at.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  useSaveLeadershipNote,
  useUpdateLeadershipFields,
  type LeadershipDetail,
} from "@/hooks/usePurposeLeadership";
import type { PurposeLeadershipNoteRow } from "@/hooks/usePurposeTable";
import type { LeadershipStatus } from "@/lib/purpose/types";
import { EMPTY_STATE_COPY } from "@/data/purpose-workshop-content";
import { PurposeButton, PurposeCard, PurposeChip, PurposeInput, PurposeLabel, PurposeTextarea } from "./kit";
import { fmtDate, LEADERSHIP_STATUS_LABELS } from "./PurposeLeadership";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type NoteType = PurposeLeadershipNoteRow["note_type"];

const NOTE_TYPES: { value: NoteType; label: string }[] = [
  { value: "observation", label: "Observation" },
  { value: "coaching_plan", label: "Coaching plan" },
  { value: "follow_up", label: "Follow-up" },
  { value: "milestone", label: "Milestone" },
  { value: "concern", label: "Concern" },
];

const NOTE_TYPE_LABELS = Object.fromEntries(NOTE_TYPES.map((t) => [t.value, t.label])) as Record<
  NoteType,
  string
>;

/** Spec §19.3-F — the optional next-coaching-action templates, verbatim. */
const COACHING_TEMPLATES = [
  "Discuss difference between stated goal and current belief ceiling.",
  "Clarify path and opportunity assumptions.",
  "Coach on stated sales-skill confidence gap.",
  "Ask what makes consistency break down.",
  "Review existing CRM data together.",
  "Follow up on stated support request.",
  "Recognize progress and reinforce next focus.",
] as const;

export function PurposeLeadershipActions({ detail }: { detail: LeadershipDetail }) {
  const { user } = useAuth();
  const profile = detail.profile;
  const saveNote = useSaveLeadershipNote();
  const updateFields = useUpdateLeadershipFields();

  const [noteText, setNoteText] = useState("");
  const [noteType, setNoteType] = useState<NoteType>("observation");
  const [visibleToRep, setVisibleToRep] = useState(false); // deliberately OFF by default

  const [followUp, setFollowUp] = useState(profile?.leadership_follow_up_date ?? "");
  const [status, setStatus] = useState<LeadershipStatus | "">(profile?.leadership_status ?? "");
  const [nextAction, setNextAction] = useState(profile?.leadership_next_action ?? "");

  const authorIds = [...new Set(detail.notes.map((n) => n.author_user_id))].sort();
  const authorsQuery = useQuery({
    queryKey: ["purpose_note_authors", authorIds.join(",")],
    enabled: authorIds.length > 0,
    staleTime: 300_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", authorIds);
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.id, p.display_name ?? "Unknown"]));
    },
  });
  const authors = authorsQuery.data;

  if (!profile) return null;

  return (
    <PurposeCard className="mt-4">
      <PurposeLabel>Section F</PurposeLabel>
      <h2 className="mt-1 text-lg">Leadership actions</h2>

      {/* 1 — Add private leadership note */}
      <div className="mt-4">
        <PurposeLabel>Add note</PurposeLabel>
        <PurposeTextarea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="What you observed, plan to coach, or want to remember…"
          className="mt-2 min-h-24"
        />
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Select value={noteType} onValueChange={(v) => setNoteType(v as NoteType)}>
            <SelectTrigger className="min-h-11 w-44 border-[var(--purpose-line)] bg-transparent text-sm text-[var(--purpose-ink)]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NOTE_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="inline-flex min-h-11 select-none items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={visibleToRep}
              onChange={(e) => setVisibleToRep(e.target.checked)}
              className="size-4 accent-[var(--purpose-tide)]"
            />
            Visible to rep
          </label>
          <PurposeButton
            tone="ghost"
            disabled={!noteText.trim() || saveNote.isPending}
            onClick={() =>
              saveNote.mutate(
                {
                  purpose_profile_id: profile.id,
                  author_user_id: user!.id,
                  note_text: noteText.trim(),
                  note_type: noteType,
                  visible_to_rep: visibleToRep,
                },
                {
                  onSuccess: () => {
                    setNoteText("");
                    setVisibleToRep(false);
                    toast.success("Note saved");
                  },
                  onError: (e: Error) => toast.error(e.message),
                },
              )
            }
          >
            Save note
          </PurposeButton>
        </div>
        <p className="mt-2 text-xs text-[var(--purpose-ink-dim)]">
          Notes are private to you and Tyler unless you deliberately share one.
        </p>

        {detail.notes.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--purpose-ink-dim)]">
            {EMPTY_STATE_COPY.no_leadership_notes}
          </p>
        ) : (
          <div className="mt-4 space-y-4 border-t border-[var(--purpose-line)] pt-4">
            {detail.notes.map((n) => (
              <div key={n.id}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--purpose-ink-dim)]">
                  <span>{NOTE_TYPE_LABELS[n.note_type] ?? n.note_type}</span>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">{fmtDate(n.created_at)}</span>
                  <span aria-hidden>·</span>
                  <span>{authors?.get(n.author_user_id) ?? "—"}</span>
                  {n.visible_to_rep && (
                    <span className="rounded-full border border-[var(--purpose-sand)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[var(--purpose-sand)]">
                      Visible to rep
                    </span>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-line text-sm leading-relaxed">{n.note_text}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2 + 3 — Follow-up date and status */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div>
          <PurposeLabel>Follow-up date</PurposeLabel>
          <PurposeInput
            type="date"
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            className="mt-2"
          />
        </div>
        <div>
          <PurposeLabel>Status</PurposeLabel>
          <Select
            value={status || undefined}
            onValueChange={(v) => setStatus(v as LeadershipStatus)}
          >
            <SelectTrigger className="mt-2 min-h-11 w-full border-[var(--purpose-line)] bg-transparent text-sm text-[var(--purpose-ink)]">
              <SelectValue placeholder="Set a status…" />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(LEADERSHIP_STATUS_LABELS) as LeadershipStatus[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {LEADERSHIP_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 4 — Next coaching action */}
      <div className="mt-5">
        <PurposeLabel>Next coaching action</PurposeLabel>
        <PurposeTextarea
          value={nextAction}
          onChange={(e) => setNextAction(e.target.value)}
          placeholder="One concrete next move for this rep…"
          className="mt-2 min-h-20"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {COACHING_TEMPLATES.map((t) => (
            <PurposeChip key={t} selected={nextAction === t} onClick={() => setNextAction(t)}>
              {t}
            </PurposeChip>
          ))}
        </div>
      </div>

      <div className="mt-5">
        <PurposeButton
          disabled={updateFields.isPending}
          onClick={() =>
            updateFields.mutate(
              {
                purpose_profile_id: profile.id,
                leadership_status: status || null,
                leadership_follow_up_date: followUp || null,
                leadership_next_action: nextAction.trim() || null,
              },
              {
                onSuccess: () => toast.success("Saved"),
                onError: (e: Error) => toast.error(e.message),
              },
            )
          }
        >
          Save follow-up, status, and next action
        </PurposeButton>
        <p className="mt-2 text-xs text-[var(--purpose-ink-dim)]">
          Saving also stamps this profile as reviewed.
        </p>
      </div>
    </PurposeCard>
  );
}
