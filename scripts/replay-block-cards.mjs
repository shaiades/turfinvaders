// Replay Block-board cards through the monday-live-dispatch edge function.
//
// Why: the week-of-8/3/26 rotation registered webhooks on an empty duplicate
// board (zero-padded name mismatch — see src/routes/api/internal/
// rotate-boards.ts), so every outcome the crews marked Mon 8/3 → Tue 8/4
// never reached the app. Posting a synthetic event per card makes the edge
// function re-fetch the card from Monday and run the NORMAL ingestion path —
// outcome counters, payroll daily_logs, sale→leads sync, new-lead credits,
// dedupe markers — all with production semantics. Idempotent: re-running is
// a stream of Same_Bucket_NoOp / Already-credited no-ops.
//
// Every outcome lands on TODAY's metric day (the edge fn stamps todayLA()).
// Cards the crews marked on a PRIOR day need the companion day-move script
// (supabase/corrections/20260804_week0803_daymove.sql) applied afterwards.
//
// Prereq: system_settings.active_monday_board_sd/oc must already point at the
// boards being replayed (else the office can't resolve and the block_cards
// snapshot is skipped). Either merge the rotate-boards fix and hit the
// rotation cron, or run the repoint corrections SQL first.
//
// Usage:
//   MONDAY_WEBHOOK_SECRET=<secret> node scripts/replay-block-cards.mjs
// The secret is required only if the edge function enforces it
// (MONDAY_WEBHOOK_ENFORCE_SECRET=true in the function's secrets).

const EDGE_URL =
  "https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/monday-live-dispatch" +
  "?apikey=sb_publishable_ivjX0mrVvSLM1DHfDTDVuw_qHUtGeS2";

// Week of 8/3/26 — every card on the crews' two Block boards as of Tue 8/4
// ~2pm PT. OC = 18424812732 ("OC Block 8/3/26 - 8/8/26"), SD = 18424812198
// ("SD Block 8/3/26-8/8/26"). Cards with no result yet replay as harmless
// no-ops and refresh their block_cards snapshot.
const CARDS = [
  // ── OC Monday ──
  { board: "18424812732", pulse: "12704553122" }, // Blowout
  { board: "18424812732", pulse: "12705591238" }, // Blowout
  { board: "18424812732", pulse: "12704602081" }, // Reset (Faye Dunn copy)
  { board: "18424812732", pulse: "12705750245" }, // Sit
  { board: "18424812732", pulse: "12708293342" }, // Blowout
  { board: "18424812732", pulse: "12704346347" }, // Blowout
  { board: "18424812732", pulse: "12708323022" }, // Sale $49,295 Stephen Tonkin
  { board: "18424812732", pulse: "12706709680" }, // Sit
  { board: "18424812732", pulse: "12706456910" }, // Blowout
  { board: "18424812732", pulse: "12707623616" }, // Blowout
  { board: "18424812732", pulse: "12707055533" }, // Blowout
  { board: "18424812732", pulse: "12707852044" }, // Blowout
  { board: "18424812732", pulse: "12705761325" }, // Reload $2,665 — Agent BLANK: will skip until the cell is filled
  // ── OC Tuesday ──
  { board: "18424812732", pulse: "12706113711" }, // CTC
  { board: "18424812732", pulse: "12718386381" }, // Blowout
  { board: "18424812732", pulse: "12718468145" }, // Blowout
  { board: "18424812732", pulse: "12717147545" }, // CTC
  { board: "18424812732", pulse: "12687812946" },
  { board: "18424812732", pulse: "12707576160" },
  { board: "18424812732", pulse: "12642636016" },
  { board: "18424812732", pulse: "12716580198" },
  { board: "18424812732", pulse: "12708610931" },
  // ── OC Wednesday (scheduled ahead) ──
  { board: "18424812732", pulse: "12644276506" },
  { board: "18424812732", pulse: "12717421250" },
  { board: "18424812732", pulse: "12644583472" },
  // ── SD Monday ──
  { board: "18424812198", pulse: "12708527960" }, // Sit
  { board: "18424812198", pulse: "12707478688" }, // Blowout
  { board: "18424812198", pulse: "12708329501" }, // Sit
  { board: "18424812198", pulse: "12704460640" }, // Reset
  { board: "18424812198", pulse: "12705509131" }, // Sale $25,000 Bobby Orellano
  { board: "18424812198", pulse: "12708389009" }, // Sit
  { board: "18424812198", pulse: "12708843130" }, // Sit
  { board: "18424812198", pulse: "12705104105" }, // Reset
  { board: "18424812198", pulse: "12708842936" }, // Blowout
  { board: "18424812198", pulse: "12705688896" }, // Sit
  { board: "18424812198", pulse: "12687562417" },
  { board: "18424812198", pulse: "12706395039" }, // Sale $23,191 Miguel Munoz
  { board: "18424812198", pulse: "12707820675" }, // Blowout
  { board: "18424812198", pulse: "12707809887" }, // Blowout
  // ── SD Tuesday ──
  { board: "18424812198", pulse: "12703696867" },
  { board: "18424812198", pulse: "12705216542" }, // CTC
  { board: "18424812198", pulse: "12717223745" }, // CTC
  { board: "18424812198", pulse: "12691912207" },
  { board: "18424812198", pulse: "12625029795" },
  { board: "18424812198", pulse: "12717570876" }, // CTC
  { board: "18424812198", pulse: "12706060426" },
  { board: "18424812198", pulse: "12544303475" },
  { board: "18424812198", pulse: "12706669735" },
  { board: "18424812198", pulse: "12707766667" },
  { board: "18424812198", pulse: "12707931312" },
  { board: "18424812198", pulse: "12716431401" },
  // ── SD Wednesday (scheduled ahead) ──
  { board: "18424812198", pulse: "12716645532" },
  { board: "18424812198", pulse: "12717451836" },
  { board: "18424812198", pulse: "12677911753" },
  { board: "18424812198", pulse: "12718363753" },
  { board: "18424812198", pulse: "12718298913" },
  { board: "18424812198", pulse: "12717360049" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function replayOne(card) {
  const secret = process.env.MONDAY_WEBHOOK_SECRET;
  const url = secret ? `${EDGE_URL}&secret=${encodeURIComponent(secret)}` : EDGE_URL;
  const body = JSON.stringify({ event: { pulseId: card.pulse, boardId: card.board } });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const text = (await resp.text()).slice(0, 120);
    if (resp.status !== 502 || attempt === 2) return { status: resp.status, text };
    await sleep(3000); // transient Monday API error — one retry
  }
}

let ok = 0;
let failed = 0;
for (const card of CARDS) {
  const { status, text } = await replayOne(card);
  const line = `${card.board} ${card.pulse} → ${status} ${text}`;
  if (status === 200) {
    ok++;
    console.log(line);
  } else {
    failed++;
    console.error("FAIL " + line);
  }
  await sleep(250); // stay well inside Monday API rate limits
}
console.log(`\n${ok} ok, ${failed} failed of ${CARDS.length}`);
if (failed > 0) {
  console.error(
    "Failures above did not write counters — safe to re-run this script; " +
      "already-processed cards no-op.",
  );
  process.exit(1);
}
