/** Assertions for the Van Wars §4 confirmer-credit rule in
 *  supabase/functions/monday-live-dispatch/confirmer-credit.ts — run with
 *  `npm run verify:confirmer`.
 *
 *  Pins the Source-vs-Status rule the owner confirmed 2026-10-05: "Rehash" is a
 *  SOURCE value, "room lead" is a LEAD STATUS value (two different columns), and
 *  every other recycled card is ignored. The webhook does the confirmer-NAME
 *  match separately; this is only the column rule. */
import {
  isRehashOrRoomCard,
  normalizeLoose,
} from "../supabase/functions/monday-live-dispatch/confirmer-credit";

let failures = 0;
function ok(label: string, got: boolean, want: boolean) {
  if (got !== want) {
    failures++;
    console.error(`✗ ${label}: want ${want} got ${got}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

ok("Rehash source credits", isRehashOrRoomCard("Rehash", ""), true);
ok("rehash (lower/spaces) credits", isRehashOrRoomCard("  rehash  ", null), true);
ok("Rehash / Cynthia King credits", isRehashOrRoomCard("Rehash / Cynthia King", ""), true);
ok("room-lead status credits", isRehashOrRoomCard("", "Room Lead"), true);
ok("room lead (status only) credits", isRehashOrRoomCard(null, "room lead"), true);
ok("Self Gen source does NOT credit", isRehashOrRoomCard("Self Gen", ""), false);
ok("Unconfirmed status does NOT credit", isRehashOrRoomCard("", "Unconfirmed"), false);
ok("Future status does NOT credit", isRehashOrRoomCard("", "Future"), false);
ok("blank does NOT credit", isRehashOrRoomCard("", ""), false);
ok("normalizeLoose collapses whitespace", normalizeLoose("  A  B ") === "a b", true);

console.log(failures === 0 ? "\n✅ 0 failure(s)" : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
