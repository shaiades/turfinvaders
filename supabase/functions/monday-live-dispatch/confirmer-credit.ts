// Van Wars §4 — the pure rule for crediting a confirmer on a recycled card.
// A confirmer earns the lead when the card is their channel: "Rehash" is a
// value in the Monday SOURCE column, while "room lead" is a value in the LEAD
// STATUS column (two different columns — confirmed with the owner 2026-10-05).
// All OTHER recycled cards (Futures / Never Confirmed / Reschedules / QR /
// Internet) stay ignored. No imports: this file is shared by the deno edge
// function and the node verify script (`npm run verify:confirmer`).

/** Lower-case, collapse internal whitespace — matches the webhook's own
 *  source-text normalization so the rule and the credit path agree. */
export function normalizeLoose(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * True when a card's Source/Status marks it a confirmer channel card (Rehash
 * or Room). The NAME match (is the Agent actually a confirmer?) is a separate
 * DB step in the webhook — this is only the column rule.
 */
export function isRehashOrRoomCard(
  sourceText: string | null | undefined,
  leadStatusText: string | null | undefined,
): boolean {
  const src = normalizeLoose(sourceText);
  const status = normalizeLoose(leadStatusText);
  const isRehash = src === "rehash" || src === "rehash / cynthia king";
  const isRoom = status === "room lead";
  return isRehash || isRoom;
}
