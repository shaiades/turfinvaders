import { ClipboardList, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildOohReportUrl } from "@/lib/ooh";
import { useOohConfig } from "@/hooks/useOohQueue";

/**
 * The rep's "Report" button for one of their leads — opens the Out of House
 * form prefilled (rep, partner, customer, address, on-block=Yes, lead id) via
 * the form's URL-prefill lookups, so the rep types nothing and the write-back
 * matches the submission to this block item. Falls back to the built-in form URL
 * if the owner hasn't set system_settings.ooh_form_url. Mobile-first (≥44px).
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
        <ClipboardList className="size-4" /> Open Dispo
      </a>
    </Button>
  );
}

/**
 * "Report a sale I made on my own" — opens the Out of House form with NO issued
 * lead (just the rep prefilled), for a self-gen / off-block appointment: a rep
 * stops by an old customer and sells. The rep picks Self-gen / Upsell / Reload
 * on the form; the write-back routes it (office queue, or auto-create if ever
 * enabled). Always available, even on a day with no issued leads.
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
  const url = buildOohReportUrl(cfg.data?.formUrl, { repName });
  if (!url) return null;
  return (
    <Button asChild variant={variant} className={className}>
      <a href={url} target="_blank" rel="noopener noreferrer">
        <Store className="size-4" /> Dispo — off-block / self-gen sale
      </a>
    </Button>
  );
}
