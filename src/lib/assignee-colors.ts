// One color identity per user, everywhere: turf polygons, map label pills,
// and avatar circles in the Area Details sheet all derive from the assignee's
// uuid — never stored, never drifting.

/** Light cyan for unassigned turfs — must pop on the dark map (the old gray
 *  #8a8f99 was invisible). A shade lighter than the knock/go_back pin dot
 *  (#00e5ff) so the two still read apart. Remote-drop pins keep their gray. */
export const UNASSIGNED_COLOR = "#5ce1ff";

/** Stable neon-bright color for a user id (uuid hash → HSL hue). */
export function assigneeColor(userId: string | null | undefined): string {
  if (!userId) return UNASSIGNED_COLOR;
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 85% 55%)`;
}

/** "Jorge Najera" → "JN"; single names → first letter. */
export function initials(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
