/** Muted chip for people no longer on the active roster (archived or
 *  removed from a van). Their history stays visible wherever they produced;
 *  this badge is what separates those rows from the live roster. */
export function FormerBadge({ className = "" }: { className?: string }) {
  return (
    <span
      title="No longer on the active roster — stats shown for the dates they worked."
      className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-display uppercase tracking-widest border border-border text-muted-foreground bg-muted/20 ${className}`}
    >
      Former
    </span>
  );
}
