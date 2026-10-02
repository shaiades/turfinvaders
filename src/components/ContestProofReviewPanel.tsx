// Kombat Month proof review queue (owner directive 2026-10-02) — lives on
// the Confirmation Desk beside the Dojo queue, same approve/deny rhythm.
// Review goes through the reviewContestProof server fn (never a direct
// table write): it computes the capped points and writes the proof row +
// its locked ledger row together. Denials REQUIRE a reason (ReasonDialog) —
// the rep reads it. Renders nothing until the contest migration lands.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Check, Eye, X } from "lucide-react";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { ReasonDialog } from "@/components/ReasonDialog";
import { PROOF_LABELS, fmtPts, type ProofCategory } from "@/lib/kombat-month";
import { reviewContestProof } from "@/lib/kombat-month.functions";

type ProofRow = {
  id: string;
  rep_id: string;
  category: string;
  storage_path: string | null;
  note: string;
  link_url: string | null;
  customer_name: string | null;
  sat_on: string | null;
  created_at: string;
};

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

export function ContestProofReviewPanel() {
  const qc = useQueryClient();

  const pending = useQuery({
    queryKey: ["contest_proofs", "pending"],
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contest_proofs")
        .select(
          "id, rep_id, category, storage_path, note, link_url, customer_name, sat_on, created_at",
        )
        .eq("status", "pending")
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as ProofRow[];
    },
  });

  const names = useQuery({
    enabled: (pending.data ?? []).length > 0,
    queryKey: [
      "contest_proof_names",
      (pending.data ?? [])
        .map((p) => p.rep_id)
        .sort()
        .join(","),
    ],
    queryFn: async () => {
      const ids = [...new Set((pending.data ?? []).map((p) => p.rep_id))];
      const { data, error } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", ids);
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.id, p.display_name ?? "?"]));
    },
  });

  const [preview, setPreview] = useState<{ id: string; url: string; video: boolean } | null>(null);
  const [denyFor, setDenyFor] = useState<ProofRow | null>(null);

  const review = useMutation({
    mutationFn: (vars: { id: string; approve: boolean; deny_reason?: string }) =>
      reviewContestProof({ data: vars }),
    onSuccess: (res) => {
      if (res.status === "approved") {
        toast.success(
          res.points_awarded && res.points_awarded > 0
            ? `Approved — +${fmtPts(res.points_awarded)} pts on the ledger.`
            : `Approved at 0 pts${res.cap_note ? ` (${res.cap_note})` : ""}.`,
        );
      } else {
        toast.success("Denied — the rep sees your reason.");
      }
      setDenyFor(null);
      void qc.invalidateQueries({ queryKey: ["contest_proofs"] });
      void qc.invalidateQueries({ queryKey: ["kombat_pending_proofs"] });
      void qc.invalidateQueries({ queryKey: ["contest_ledger"] });
      void qc.invalidateQueries({ queryKey: ["kombat_admin_board"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Quietly absent until the migration lands — the desk shouldn't error.
  if (pending.isError) return null;

  return (
    <>
      <ArcadePanel
        title="Kombat Month · Proofs"
        faction="kombat"
        action={
          <span className="text-[10px] font-display uppercase tracking-widest text-warning">
            {pending.data?.length ?? 0} waiting
          </span>
        }
      >
        {pending.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (pending.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No proofs waiting. Approvals mint locked contest points on the spot.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {pending.data!.map((p) => (
              <li key={p.id} className="py-3 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {names.data?.get(p.rep_id) ?? "…"}
                      <span className="ml-2 text-xs text-kombat-gold font-display uppercase tracking-widest">
                        {PROOF_LABELS[p.category as ProofCategory] ?? p.category}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {p.note} · {new Date(p.created_at).toLocaleString()}
                      {p.customer_name && <> · {p.customer_name}</>}
                      {p.sat_on && <> · sat {p.sat_on}</>}
                    </div>
                    {p.link_url && (
                      <a
                        href={p.link_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-neon underline underline-offset-2 truncate block max-w-xs"
                      >
                        {p.link_url}
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {p.storage_path && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-11 md:min-h-9"
                        onClick={async () => {
                          try {
                            const { data, error } = await supabase.storage
                              .from("contest-proofs")
                              .createSignedUrl(p.storage_path!, 3600);
                            if (error || !data) throw error ?? new Error("No URL");
                            setPreview({
                              id: p.id,
                              url: data.signedUrl,
                              video: VIDEO_EXT.test(p.storage_path!),
                            });
                          } catch (e) {
                            toast.error((e as Error).message);
                          }
                        }}
                      >
                        <Eye className="w-3.5 h-3.5 mr-1.5" /> View
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={review.isPending}
                      onClick={() => review.mutate({ id: p.id, approve: true })}
                      className="min-h-11 md:min-h-9 bg-victory text-background hover:bg-victory/90"
                    >
                      <Check className="w-3.5 h-3.5 mr-1.5" /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="min-h-11 md:min-h-9"
                      disabled={review.isPending}
                      onClick={() => setDenyFor(p)}
                    >
                      <X className="w-3.5 h-3.5 mr-1.5" /> Deny
                    </Button>
                  </div>
                </div>
                {preview?.id === p.id &&
                  (preview.video ? (
                    <video
                      src={preview.url}
                      controls
                      autoPlay
                      playsInline
                      className="w-full max-w-md rounded-lg border border-border bg-black aspect-video object-contain"
                    />
                  ) : (
                    <img
                      src={preview.url}
                      alt="Proof"
                      className="w-full max-w-md rounded-lg border border-border object-contain"
                    />
                  ))}
              </li>
            ))}
          </ul>
        )}
      </ArcadePanel>

      <ReasonDialog
        open={denyFor !== null}
        onOpenChange={(o) => !o && setDenyFor(null)}
        title="Deny proof"
        prompt={
          denyFor
            ? `Deny ${names.data?.get(denyFor.rep_id) ?? "this rep"}'s ${
                PROOF_LABELS[denyFor.category as ProofCategory] ?? denyFor.category
              } submission`
            : ""
        }
        confirmLabel="Send denial"
        destructive
        pending={review.isPending}
        placeholder='e.g. "screenshot doesn’t show your name — re-upload with the review visible"'
        footer="The rep sees this on their submission."
        onSubmit={(reason) =>
          denyFor && review.mutate({ id: denyFor.id, approve: false, deny_reason: reason })
        }
      />
    </>
  );
}
