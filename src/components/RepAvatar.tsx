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
  fit,
  position,
  className,
  textClassName = "text-xs",
  rounded = "full",
  ring = false,
}: {
  name: string;
  cartoon?: RepCartoon;
  /** "full" uses the full-body art (falls back to the portrait, then initials). */
  variant?: "portrait" | "full";
  /**
   * How the art fills its box. "cover" (default) crops to fill; "contain"
   * shows the whole figure head-to-feet on the box's backdrop — use it for the
   * big character-select / champion frames where the full fighter should show.
   */
  fit?: "cover" | "contain";
  /**
   * CSS object-position. Defaults to "center top" for full-body art (so the
   * head is never the part that gets cropped) and "center" for portraits.
   */
  position?: string;
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
  const objectFit = fit ?? "cover";
  // Full-body art is framed head-to-feet, so a centered cover crop lands on the
  // hips and decapitates the fighter — anchor it to the top instead.
  const objectPosition = position ?? (variant === "full" ? "center top" : "center");

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
          className={cn(
            "h-full w-full",
            objectFit === "contain" ? "object-contain" : "object-cover",
          )}
          style={{ objectPosition }}
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
