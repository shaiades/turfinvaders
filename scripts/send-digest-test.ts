// One-shot manual digest test (owner asked to see the push on his phone).
// Composes the REAL morning brief via the same engine the cron route uses,
// then inserts a God_Digest_Sent webhook_logs row with a TEST date marker —
// the delivery trigger (migration 20261001200000) pushes it to owner
// phones. The marker never collides with a real LA-date claim, so the
// next 6:45am cron still fires. Not an npm script on purpose.
import { composeMorningDigest } from "../src/lib/deviations.functions";
import { supabaseAdmin } from "../src/integrations/supabase/client.server";

const digest = await composeMorningDigest();
console.log("--- digest body ---");
console.log(digest.title);
console.log(digest.body);
console.log("--- inserting claim row (trigger delivers) ---");

const marker = `manual-test-${process.env.TEST_MARKER ?? "0"}`;
const { error } = await supabaseAdmin.from("webhook_logs").insert({
  step: "God_Digest_Sent",
  data: { date: marker, title: digest.title, body: digest.body } as never,
});
if (error) {
  console.error("insert failed:", error.message);
  process.exit(1);
}
console.log("claim row inserted with date marker:", marker);
