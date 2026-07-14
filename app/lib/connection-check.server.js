// Scheduled connection verification. Silent tracking breakage (a rotated/wrong GA4 secret, a measurement
// id pointing at the wrong data stream) was the root of the original firefight and is invisible until
// someone notices conversions stopped. This runs a GA4 validation hit on a cadence so the app catches it
// itself. The result is stored per destination; computeHealth turns a failing row into a health alert, so
// it reaches the in-app banners AND the webhook via the existing alerting path — no separate notifier.
//
// GA4 only: its /debug/mp/collect endpoint VALIDATES without ingesting, so running it every few hours is
// harmless. Meta's validator injects a live PageView, so Meta stays on the on-demand test button.
import prisma from "../db.server";
import { validateGa4Event } from "./server-side.server";

// Re-verify a destination at most this often. The cron runs every ~5 min but each destination is only
// actually re-checked on this cadence, so we don't hammer GA4 (a handful of validation hits per day).
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const GA4 = "ga4";

/** Cron pass: verify the GA4 connection for shops whose last check is stale. Best-effort → summary. */
export async function runConnectionChecks({ now = Date.now(), limit = 200 } = {}) {
  const shops = await prisma.trackingSettings
    .findMany({ where: { serverSide: true, ga4Id: { not: null } }, take: limit })
    .catch(() => []);

  let checked = 0;
  let failing = 0;
  for (const settings of shops) {
    const existing = await prisma.connectionCheck
      .findUnique({ where: { shopDomain_destination: { shopDomain: settings.shopDomain, destination: GA4 } } })
      .catch(() => null);
    if (existing && now - new Date(existing.checkedAt).getTime() < CHECK_INTERVAL_MS) continue;

    const v = await validateGa4Event(settings, { name: "pxp_connection_test", params: { debug_mode: 1 }, clientId: "healthcheck.0" }).catch(() => ({
      ok: false,
      messages: ["connection check failed to run"],
    }));
    const ok = !!v.ok;
    const detail = ok ? null : (v.messages || []).join("; ").slice(0, 300);
    await prisma.connectionCheck
      .upsert({
        where: { shopDomain_destination: { shopDomain: settings.shopDomain, destination: GA4 } },
        create: { shopDomain: settings.shopDomain, destination: GA4, ok, detail },
        update: { ok, detail, checkedAt: new Date(now) },
      })
      .catch(() => {});
    checked += 1;
    if (!ok) failing += 1;
  }
  return { checked, failing };
}
