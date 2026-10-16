// Coaching flag + note log (Phase 2 §4): the chip names the move
// ("Knocks plenty, converts low → ride-along"), the panel shows the
// last-14-day rates against the team, suggests a ride-along partner from the
// window's top converters, and carries the coaching-note log (captain +
// office write, the canvasser reads their own — RLS in 20261028130000).

import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useCoaching, useCoachingNotes, useAddCoachingNote } from "@/hooks/useCoaching";
import type { CoachingFlagKey } from "@/lib/coaching";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { NotebookPen, Users } from "lucide-react";

const FLAG_STYLE: Record<CoachingFlagKey, string> = {
  not_logging: "border-destructive/60 text-destructive bg-destructive/10",
  ride_along:
    "border-[var(--warning)]/60 text-[var(--warning)] bg-[color-mix(in_oklab,var(--warning)_12%,transparent)]",
  knock_more: "border-neon/60 text-neon bg-neon/10",
  on_track: "border-victory/60 text-victory bg-victory/10",
};

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** The one-line flag pill — header chip on the canvasser detail page. */
export function CoachingFlagChip({ canvasserId }: { canvasserId: string | undefined }) {
  const { flag, loading } = useCoaching(canvasserId);
  if (loading || !flag) return null;
  return (
    <span
      title={flag.hint}
      className={`inline-flex items-center rounded-full border px-2.5 py-1 font-display text-[9px] uppercase tracking-widest ${FLAG_STYLE[flag.key]}`}
    >
      {flag.label}
      {flag.key === "ride_along" ? " → ride-along" : ""}
    </span>
  );
}

/** The full coaching panel: flag, 14-day rates vs team, ride-along partner,
 *  note log. `canWrite` gates only the composer — RLS re-checks server-side. */
export function CoachingPanel({
  canvasserId,
  canWrite,
  onSendMessage,
}: {
  canvasserId: string | undefined;
  canWrite: boolean;
  /** Phase 5: opens the coach-message composer from the flag (ride-along). */
  onSendMessage?: () => void;
}) {
  const { user } = useAuth();
  const { flag, stats, team, partners, loading } = useCoaching(canvasserId);
  const notes = useCoachingNotes(canvasserId);
  const addNote = useAddCoachingNote(canvasserId);
  const [draft, setDraft] = useState("");

  if (loading || !flag || !stats || !team) return null;

  const partner = partners[0] ?? null;

  return (
    <ArcadePanel
      title="Coaching · Last 14 Days"
      action={<CoachingFlagChip canvasserId={canvasserId} />}
    >
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">{flag.hint}</p>

        {/* Rates vs team — the three numbers the flag is made of */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(
            [
              ["Doors / day", stats.doorsPerDay.toFixed(0), team.doorsPerDay.toFixed(0)],
              ["Talk rate", stats.drs > 0 ? pct(stats.tlk / stats.drs) : "—", pct(team.talkRate)],
              ["Talk → lead", pct(stats.talkLead), pct(team.talkLead)],
            ] as const
          ).map(([label, me, teamVal]) => (
            <div key={label} className="rounded-lg border border-border/60 px-3 py-2">
              <div className="font-display text-[9px] uppercase tracking-widest text-muted-foreground">
                {label}
              </div>
              <div className="mt-0.5 font-display text-sm tabular-nums text-foreground">
                {me}
                {teamVal ? (
                  <span className="ml-1.5 text-[10px] text-muted-foreground">team {teamVal}</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        {/* Ride-along pairing — only when the flag calls for one */}
        {flag.key === "ride_along" && partner && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--warning)]/40 bg-[color-mix(in_oklab,var(--warning)_8%,transparent)] px-3 py-2">
            <Users className="h-4 w-4 shrink-0 text-[var(--warning)]" />
            <p className="min-w-0 flex-1 text-xs">
              Ride-along with <span className="font-medium">{partner.name}</span> — converting{" "}
              {pct(partner.tlk > 0 ? partner.ld / partner.tlk : 0)} this window
              {partners[1] ? ` (or ${partners[1].name})` : ""}.
            </p>
            {onSendMessage && (
              <Button size="sm" variant="outline" onClick={onSendMessage}>
                🎥 Send a nudge
              </Button>
            )}
          </div>
        )}

        {/* Note log */}
        <div className="space-y-2">
          <div className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
            <NotebookPen className="mr-1 inline h-3 w-3 -mt-0.5" />
            Coaching notes
          </div>
          {canWrite && (
            <div className="flex items-end gap-2">
              <Textarea
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="What you worked on, what to watch next…"
                maxLength={1000}
              />
              <Button
                size="sm"
                disabled={draft.trim().length < 2 || addNote.isPending || !user?.id}
                onClick={() =>
                  addNote.mutate(
                    { authorId: user!.id, text: draft },
                    {
                      onSuccess: () => setDraft(""),
                      onError: (e: Error) => toast.error(e.message),
                    },
                  )
                }
              >
                {addNote.isPending ? "Saving…" : "Log it"}
              </Button>
            </div>
          )}
          {(notes.data ?? []).length === 0 ? (
            <p className="text-xs italic text-muted-foreground">
              {canWrite ? "No notes yet — log the first ride-along." : "No coach notes yet."}
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {notes.data!.map((n) => (
                <li key={n.id} className="py-2">
                  <p className="text-sm leading-snug">{n.note_text}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {new Date(n.created_at).toLocaleDateString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </ArcadePanel>
  );
}
