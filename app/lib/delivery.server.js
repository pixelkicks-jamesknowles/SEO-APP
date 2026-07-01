import prisma from "../db.server";

const today = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

// Increment per-day reconciliation counters for a shop (Accuracy dashboard). Best-effort.
export async function bumpDaily(shopDomain, fields) {
  const date = today();
  const update = {};
  for (const [k, v] of Object.entries(fields)) update[k] = { increment: v };
  await prisma.trackingDaily
    .upsert({ where: { shopDomain_date: { shopDomain, date } }, create: { shopDomain, date, ...fields }, update })
    .catch(() => {});
}

// Record per-destination delivery outcomes (capped 300/shop) + roll up daily counters.
export async function recordDeliveries(shopDomain, results) {
  if (!results?.length) return;
  await prisma.deliveryLog.createMany({
    data: results.map((r) => ({
      shopDomain,
      destination: r.destination,
      eventName: r.eventName,
      ok: !!r.ok,
      detail: (r.detail || "").slice(0, 200) || null,
    })),
  });
  const stale = await prisma.deliveryLog.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "desc" },
    skip: 300,
    select: { id: true },
  });
  if (stale.length) {
    await prisma.deliveryLog.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  // A paid order counts as "captured" when we delivered a purchase-type event: the pixel's
  // checkout_completed, or a server-side subscription purchase (flagged isPurchase). Recurring
  // subscription renewals never fire a storefront checkout, so the orders/paid webhook is the only
  // capture signal for them — without this they'd read as permanent misses in the match rate.
  const purchaseDelivered = results.some((r) => r.ok && (r.eventName === "checkout_completed" || r.isPurchase));
  await bumpDaily(shopDomain, {
    eventsSent: ok,
    eventsFailed: failed,
    ...(purchaseDelivered ? { purchasesDelivered: 1 } : {}),
  });
}

// First-touch attribution: record a visitor's source on a UTM-tagged visit (never overwrite the
// first source - later visits only bump the counter). Keyed on GA4 client_id. Low write volume
// (only fires when UTMs are present). Best-effort.
export async function recordVisit(shopDomain, clientId, utm) {
  if (!clientId || !utm) return;
  const source = utm.utm_source || null;
  const medium = utm.utm_medium || null;
  const campaign = utm.utm_campaign || null;
  if (!source && !medium && !campaign) return;
  await prisma.visitorAttribution
    .upsert({
      where: { shopDomain_clientId: { shopDomain, clientId } },
      create: { shopDomain, clientId, source, medium, campaign },
      update: { visits: { increment: 1 } },
    })
    .catch(() => {});
}

// Look up a visitor's first-touch source by client_id (for enriching a later conversion).
export async function getFirstTouch(shopDomain, clientId) {
  if (!clientId) return null;
  const row = await prisma.visitorAttribution
    .findUnique({ where: { shopDomain_clientId: { shopDomain, clientId } } })
    .catch(() => null);
  if (!row || (!row.source && !row.medium && !row.campaign)) return null;
  return { source: row.source, medium: row.medium, campaign: row.campaign };
}
