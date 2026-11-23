/** Assertions for the no-show escalation rules in
 *  supabase/functions/monday-live-dispatch/no-show-escalation.ts — run with
 *  `npm run verify:noshow`.
 *
 *  Pins the owner's 2026-11-23 ask: ONLY a BO flip to exactly "No Show"
 *  escalates — "No show text" (the at-the-door hold that already texts the
 *  CUSTOMER) and "No Demo" never do, and a redelivery whose previous value
 *  was already "No Show" never re-texts the confirmers. */
import {
  buildEscalationDetails,
  callbackUrl,
  colTextByTitle,
  findColIdByTitle,
  isNoShowFlip,
  normalizePhoneE164,
  type EscalationCol,
} from "../supabase/functions/monday-live-dispatch/no-show-escalation";

let failures = 0;
function ok(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failures++;
    console.error(`✗ ${label}: want ${w} got ${g}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// ── Detection ───────────────────────────────────────────────────────────────
ok("BO → No Show escalates", isNoShowFlip("status4", "BO", "No Show", null), true);
ok("BO by title (renamed id) escalates", isNoShowFlip("status_zz", "BO", "No Show", "None"), true);
ok("case/space tolerant", isNoShowFlip("status4", "bo", "  no  show ", ""), true);
ok(
  "No show text does NOT escalate (customer text, lead still open)",
  isNoShowFlip("status4", "BO", "No show text", null),
  false,
);
ok("No Demo does NOT escalate", isNoShowFlip("status4", "BO", "No Demo", null), false);
ok("other column does NOT escalate", isNoShowFlip("status9", "Sale", "No Show", null), false);
ok(
  "already-No-Show previous value does NOT re-fire",
  isNoShowFlip("status4", "BO", "No Show", "No Show"),
  false,
);
ok(
  "clearing back to None does NOT escalate",
  isNoShowFlip("status4", "BO", "None", "No Show"),
  false,
);

// ── Column resolution + customer snapshot ───────────────────────────────────
const cols: EscalationCol[] = [
  { id: "status4", text: "No Show", column: { title: "BO", id: "status4" } },
  { id: "phone_1", text: "(619) 555-0133", column: { title: "Phone", id: "phone_1" } },
  {
    id: "location",
    text: "123 Main St, San Diego, CA",
    column: { title: "Location", id: "location" },
  },
  { id: "date9", text: "2026-11-24 14:00", column: { title: "Date/Time", id: "date9" } },
  { id: "text_cl", text: null, column: { title: "Cynthia Link", id: "text_cl" } },
  { id: "phone_cp", text: null, column: { title: "Cynthia Phone", id: "phone_cp" } },
  { id: "color_ca", text: null, column: { title: "Confirmer Alert", id: "color_ca" } },
];
ok("link column by title", findColIdByTitle(cols, "cynthia link"), "text_cl");
ok("alert column by title", findColIdByTitle(cols, "Confirmer Alert"), "color_ca");
ok("missing column → null (log, never guess)", findColIdByTitle(cols, "jeni link"), null);
ok("colText trims empty to null", colTextByTitle(cols, "cynthia link"), null);
ok("details snapshot", buildEscalationDetails(cols, "Jane Doe "), {
  lead_name: "Jane Doe",
  customer_phone: "(619) 555-0133",
  address: "123 Main St, San Diego, CA",
  appt_time: "2026-11-24 14:00",
});

// ── Link + phone shapes ─────────────────────────────────────────────────────
ok(
  "callback URL",
  callbackUrl("abc123def456abc123def456abc123de"),
  "https://turfinvaders.com/called/abc123def456abc123def456abc123de",
);
ok("10-digit gets +1", normalizePhoneE164("619-719-0335"), "+16197190335");
ok("formatted 11-digit", normalizePhoneE164("1 (760) 803-1174"), "+17608031174");
ok("already E.164 passes through", normalizePhoneE164("+16197190335"), "+16197190335");
ok("garbage → null (never text a half-parsed number)", normalizePhoneE164("ext 442"), null);

console.log(failures === 0 ? "\n✅ 0 failure(s)" : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
