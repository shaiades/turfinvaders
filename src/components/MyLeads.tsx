import { useMemo } from "react";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { OohReportButton, OohSelfGenButton } from "@/components/OohReportButton";
import { MapPin, Users, Loader2, CheckCircle2 } from "lucide-react";
import { laTodayISO } from "@/lib/dates";
import { buildRepMatcher } from "@/lib/rep-identity";
import { isMyLeadVisible } from "@/lib/ooh";
import { useMyLeads, type MyLeadCard } from "@/hooks/useMyLeads";

/**
 * "My Leads" — the rep's daily driver. Today's block appointments assigned to
 * the logged-in rep, each with what they need to run it (customer, address →
 * tap to map, partner) and ONE "Report result" button that opens the Out of
 * House form fully pre-filled. "Not home?" is the same button → "At the door",
 * which texts the customer and has the OFFICE call — reps never call homeowners.
 * No phone number is shown, by design. Rep-only; mobile-first (≥44px targets).
 */

function mapsHref(address: string): string {
  return `https://maps.google.com/?q=${encodeURIComponent(address)}`;
}

/** The reported outcome on a card, if any (the block's own result labels). */
function outcomeOf(c: MyLeadCard): string | null {
  return c.sale || c.pm || c.rs || c.ol || c.bo || null;
}
function statusPill(c: MyLeadCard): { text: string; cls: string; done: boolean } {
  const done = outcomeOf(c);
  if (done)
    return { text: `Reported · ${done}`, cls: "border-victory/50 text-victory", done: true };
  const iss = (c.iss ?? "").trim();
  if (/office/i.test(iss))
    return { text: "Office appt", cls: "border-border text-muted-foreground", done: false };
  if (iss === "CTC")
    return { text: "CTC", cls: "border-border text-muted-foreground", done: false };
  if (iss === "Iss")
    return { text: "To run", cls: "border-kombat-gold/50 text-kombat-gold", done: false };
  return { text: iss || "Upcoming", cls: "border-neon/50 text-neon", done: false };
}

function LeadCard({
  card,
  repName,
  partner,
}: {
  card: MyLeadCard;
  repName: string;
  partner: string | null;
}) {
  const pill = statusPill(card);
  return (
    <div className="rounded-lg border border-border/50 bg-surface/60 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-base font-medium text-foreground">
            {card.lead_name || "Lead"}
          </p>
          {card.products && (
            <p className="truncate text-xs text-muted-foreground">{card.products}</p>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-display uppercase tracking-widest ${pill.cls}`}
        >
          {pill.text}
        </span>
      </div>

      <div className="grid gap-2">
        {card.address && (
          <a
            href={mapsHref(card.address)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-11 items-center gap-2 rounded-md border border-border/40 bg-background/40 px-3 text-sm text-foreground active:bg-background/70"
          >
            <MapPin className="size-4 shrink-0 text-neon" />
            <span className="truncate">{card.address}</span>
          </a>
        )}
        {partner && (
          <div className="flex min-h-11 items-center gap-2 rounded-md border border-border/40 bg-background/40 px-3 text-sm text-muted-foreground">
            <Users className="size-4 shrink-0" />
            <span className="truncate">With {partner}</span>
          </div>
        )}
      </div>

      <OohReportButton
        leadId={card.monday_item_id}
        repName={repName}
        partner={partner}
        customer={card.lead_name}
        address={card.address}
        apptDate={card.card_date}
        className="w-full"
        variant={pill.done ? "outline" : "default"}
      />
      {!pill.done && (
        <p className="text-center text-[11px] text-muted-foreground">
          No answer at the door? Tap Report → “At the door” — the office calls them, you don’t.
        </p>
      )}
    </div>
  );
}

export function MyLeads({ displayName }: { displayName: string | null }) {
  const today = laTodayISO();
  const q = useMyLeads(today);
  const cards = useMemo(() => q.data ?? [], [q.data]);

  const matcher = useMemo(() => {
    const allReps = Array.from(new Set(cards.flatMap((c) => c.reps ?? [])));
    return buildRepMatcher(displayName, allReps);
  }, [cards, displayName]);

  const mine = useMemo(() => {
    // Only leads actually issued to the rep (Iss / Office Appt) or already
    // reported today — never a Not-Issued lead (one-lead-at-a-time; and a
    // Not-Issued lead's address must not leak). See isMyLeadVisible.
    const rows = cards
      .filter((c) => (c.reps ?? []).some((r) => matcher.isMe(r)))
      .filter((c) => isMyLeadVisible(c));
    // Unreported first, then by name.
    return rows.sort((a, b) => {
      const ad = outcomeOf(a) ? 1 : 0;
      const bd = outcomeOf(b) ? 1 : 0;
      if (ad !== bd) return ad - bd;
      return (a.lead_name ?? "").localeCompare(b.lead_name ?? "");
    });
  }, [cards, matcher]);

  const openCount = mine.filter((c) => !outcomeOf(c)).length;

  return (
    <ArcadePanel
      title="My leads — today"
      faction="kombat"
      headline={
        <span className="font-display text-xs text-muted-foreground">
          {openCount} to run · {mine.length} total
        </span>
      }
    >
      <div className="space-y-3">
        {/* Always available — report a sale you made on your own (self-gen /
            off-block), even on a day with no issued leads. */}
        <OohSelfGenButton repName={matcher.matched ?? displayName} className="w-full" />

        {q.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading your leads…
          </p>
        ) : mine.length === 0 ? (
          <div className="space-y-1 py-4 text-center">
            <CheckCircle2 className="mx-auto size-6 text-victory" />
            <p className="text-sm text-foreground">No leads assigned to you today.</p>
            <p className="text-xs text-muted-foreground">
              Your next lead is released the night before — you’ll get a text when it’s yours. Sold
              one on your own? Use the button above.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {mine.map((c) => (
              <LeadCard
                key={c.monday_item_id}
                card={c}
                repName={matcher.matched ?? displayName ?? ""}
                partner={(c.reps ?? []).filter((r) => !matcher.isMe(r)).join(", ") || null}
              />
            ))}
          </div>
        )}
      </div>
    </ArcadePanel>
  );
}
