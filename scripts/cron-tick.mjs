// One-shot caller for the /cron/tick worker endpoint, meant to be run by a Railway cron service on a
// schedule (*/5 * * * *). It makes a single authenticated request, logs the JSON summary, and exits 0 on
// success / non-zero on failure so a failed run shows red in Railway.
//
// Why a script and not a raw curl in the start command: the app image (node:22-slim) has no curl, this is
// version-controlled and reviewable, and it gives us a real timeout + a clean exit code. It reuses the same
// image the web service builds — Railway just runs it with this as the start command instead of the server.
//
// Env:
//   CRON_SECRET  (required)  must match the app service's CRON_SECRET.
//   TICK_URL     (optional)  defaults to the production endpoint.

const TICK_URL = process.env.TICK_URL || "https://tracking.pixelkicks.co.uk/cron/tick";
const SECRET = process.env.CRON_SECRET;

if (!SECRET) {
  console.error("cron-tick: CRON_SECRET is not set");
  process.exit(1);
}

// The tick shares Cloudflare's ~100s request ceiling; abort a hair under it so we fail cleanly rather than
// hang. The next scheduled run resumes any leased work (backfill etc.) from where this one stopped.
const TIMEOUT_MS = 95_000;

try {
  const res = await fetch(TICK_URL, {
    method: "GET",
    headers: { "x-cron-secret": SECRET },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`cron-tick: HTTP ${res.status} ${body.slice(0, 500)}`);
    process.exit(1);
  }
  // Log the summary so Railway's run logs show what each tick did (recovered conversions, backfill progress).
  console.log(`cron-tick: ${res.status} ${body}`);
  process.exit(0);
} catch (err) {
  console.error(`cron-tick: ${err?.name === "TimeoutError" ? "timed out" : "failed"} — ${err?.message || err}`);
  process.exit(1);
}
