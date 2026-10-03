// One fighter face, everywhere in Close Kombat. Shows a rep's APPROVED Street
// Fighter cartoon (portrait or full-body); falls back to the initials-in-a-color
// circle (assignee-colors doctrine) when there's no approved art or the image
// fails to load. The real Monday photo is NEVER a team-facing fallback.

import { useState } from "react";
import { cn } from "@/lib/utils";
import { assigneeColor, initials } from "@/lib/assignee-colors";
import type { RepCartoon } from "@/hooks/useRepCartoons";

export function RepAvatar({
  name,
  cartoon,
  variant = "portrait",
  className,
  textClassName = "text-xs",
  rounded = "full",
  ring = false,
}: {
  name: string;
  cartoon?: RepCartoon;
  /** "full" uses the full-body art (falls back to the portrait, then initials). */
  variant?: "portrait" | "full";
  /** Sizing from the caller, e.g. "h-9 w-9" or "h-full w-full". */
  className?: string;
  textClassName?: string;
  rounded?: "full" | "lg" | "none";
  ring?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const url =
    variant === "full" ? (cartoon?.full ?? cartoon?.portrait ?? null) : (cartoon?.portrait ?? null);
  const showImg = !!url && !broken;
  const radius = rounded === "full" ? "rounded-full" : rounded === "lg" ? "rounded-lg" : "";

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden",
        radius,
        ring && "ring-2 ring-kombat-gold/60",
        className,
      )}
      style={!showImg ? { background: assigneeColor(name) } : undefined}
      aria-label={name}
    >
      {showImg ? (
        <img
          src={url!}
          alt={name}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className={cn("font-display font-bold leading-none text-black", textClassName)}>
          {initials(name)}
        </span>
      )}
    </span>
  );
}
