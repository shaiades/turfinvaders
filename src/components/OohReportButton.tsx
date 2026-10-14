import { ClipboardList, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildOohReportUrl } from "@/lib/ooh";
import { useOohConfig } from "@/hooks/useOohQueue";

/**
 * "Dispo this lead" (rule O) — shown per assigned lead. Opens the Out of House
 * form prefilled (rep, partner, customer, address, on-block=Yes, lead id) via
 * the form's URL-prefill lookups, so the rep types nothing and the write-back
 * matches the submission to THIS block item. Only rendered when the rep has a
 * current people6 assignment (inside a LeadCard). Falls back to the built-in
 * form URL if the owner hasn't set system_settings.ooh_form_url. ≥44px targets.
 */
export function OohReportButton({
  leadId,
  repName,
  partner,
  customer,
  address,
  apptDate,
  className,
  variant = "default",
}: {
  leadId: string;
  repName?: string | null;
  partner?: string | null;
  customer?: string | null;
  address?: string | null;
  apptDate?: string | null;
  className?: string;
  variant?: "default" | "outline" | "ghost";
}) {
  const cfg = useOohConfig();
  const url = buildOohReportUrl(cfg.data?.formUrl, {
    leadId,
    repName,
    partner,
    customer,
    address,
    onBlockLabel: "Yes",
    apptDate,
  });
  if (!url) return null;
  return (
    <Button asChild variant={variant} className={className}>
      <a href={url} target="_blank" rel="noopener noreferrer">
        <ClipboardList className="size-4" /> Dispo this lead
      </a>
    </Button>
  );
}

/**
 * "Log a reload" (rule O) — opens the Out of House form with NO issued lead
 * (just the rep prefilled), prefilling "Reload" on the on-block question, for a
 * rep visiting an old / past customer with no active block assignment: they stop
 * by and sell. The write-back creates a new block item (office queue, or
 * auto-create if enabled), same shape as a manually-added off-block reload. The
 * rep can still switch to Upsell / Self-gen on the form. ALWAYS available, even
 * on a day with no issued leads.
 */
export function OohSelfGenButton({
  repName,
  className,
  variant = "outline",
}: {
  repName?: string | null;
  className?: string;
  variant?: "default" | "outline" | "ghost";
}) {
  const cfg = useOohConfig();
  const url = buildOohReportUrl(cfg.data?.formUrl, { repName, onBlockLabel: "Reload" });
  if (!url) return null;
  return (
    <Button asChild variant={variant} className={className}>
      <a href={url} target="_blank" rel="noopener noreferrer">
        <Store className="size-4" /> Log a reload
      </a>
    </Button>
  );
}
