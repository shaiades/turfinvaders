import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildOohReportUrl } from "@/lib/ooh";
import { useOohConfig } from "@/hooks/useOohQueue";

/**
 * The rep's "Report" button for one of their leads — opens the Out of House
 * form prefilled (rep, partner, customer, address, on-block=Yes, lead id) so
 * the write-back can match the submission to this block item. Hides itself
 * until an owner sets the form URL (system_settings.ooh_form_url). Mobile-first
 * (≥44px via the Button primitive).
 */
export function OohReportButton({
  leadId,
  repName,
  partner,
  address,
  className,
  variant = "outline",
}: {
  leadId: string;
  repName?: string | null;
  partner?: string | null;
  address?: string | null;
  className?: string;
  variant?: "default" | "outline" | "ghost";
}) {
  const cfg = useOohConfig();
  const url = buildOohReportUrl(cfg.data?.formUrl, {
    leadId,
    repName,
    partner,
    address,
    onBlockLabel: "Yes",
  });
  if (!url) return null;
  return (
    <Button asChild variant={variant} className={className}>
      <a href={url} target="_blank" rel="noopener noreferrer">
        <ClipboardList className="size-4" /> Report
      </a>
    </Button>
  );
}
