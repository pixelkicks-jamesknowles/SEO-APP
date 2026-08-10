// Cross-session / cross-device identity stitching, built on the durable first-party id (durable-id.server).
//
// Per-session tracking fragments a shopper into many "users": _ga churns under ITP, and a login on a
// second device is a fresh anonymous visitor. The durable id already stabilises a single device across
// sessions; this layer records the graph that links durableId ↔ GA4 clientId ↔ customer, so:
//   - a conversion inherits the visitor's ORIGINAL first-touch even after _ga was wiped (cross-session), and
//   - once a visitor identifies (checkout/login), their device's durableId is linked to the customer, so a
//     later session on ANOTHER device that identifies as the same customer can be tied back (cross-device).
//
// Everything is best-effort and PII-free (customerKey is the customer id or a HASHED email, per
// attribution.customerKey). Links only ever fill in (clientId/customerKey are never nulled back out).
import prisma from "../db.server";
import { sha256Hex } from "./server-side.server";

/** Stable per-visitor attribution key: the durable first-party id when present (survives _ga/ITP churn),
 *  else the GA4 client id. This is what first-touch (VisitorAttribution) is keyed on so a returning
 *  visitor's original source isn't lost when their _ga cookie is truncated. Pure. */
export function visitorKey(event) {
  return event?.durableId || event?.clientId || null;
}

/** Customer key for a normalized pixel event — the customer id, else a hashed email, else null. Matches
 *  attribution.customerKey (order shape) so the identity graph + subscription attribution agree. Pure. */
export function eventCustomerKey(event) {
  if (event?.externalId) return String(event.externalId);
  const email = event?.email || event?.data?.checkout?.email;
  return email ? `e:${sha256Hex(email)}` : null;
}

/** Record/refresh the identity links for an event: durableId ↔ latest clientId ↔ customerKey (the last set
 *  once the visitor identifies at checkout/login). Best-effort. Only sets fields (never nulls them).
 *
 *  Cross-CHANNEL stitch (this is what makes "Identified" climb off 0): the durable id (pxp_id) is minted by
 *  the theme embed on the main page, but the CUSTOMER identity (email) arrives on the Web Pixel at checkout,
 *  whose strict sandbox can't read the pxp_id cookie — so a checkout event has a customerKey + GA client id
 *  but NO durable id. The embed recorded that same client id against the durable id, so when we learn a
 *  customerKey and have a clientId we attach it to every still-anonymous durable identity sharing that
 *  client id. Without this the two channels never meet and every durable visitor stays unidentified. */
export async function linkIdentity(shopDomain, { durableId, clientId, customerKey } = {}) {
  if (durableId) {
    await prisma.visitorIdentity
      .upsert({
        where: { shopDomain_durableId: { shopDomain, durableId } },
        create: { shopDomain, durableId, clientId: clientId || null, customerKey: customerKey || null },
        update: { ...(clientId ? { clientId } : {}), ...(customerKey ? { customerKey } : {}) },
      })
      .catch(() => {});
  }
  // Stitch the customer onto durable identities that share this GA client id but haven't been identified yet
  // (covers the durable-id-less checkout event, and back-links earlier anonymous sessions on the same _ga).
  if (customerKey && clientId) {
    await prisma.visitorIdentity
      .updateMany({ where: { shopDomain, clientId, customerKey: null }, data: { customerKey } })
      .catch(() => {});
  }
}

/** The customerKey a durable id is linked to (cross-device: whichever session of this visitor identified),
 *  or null if still anonymous. Best-effort. */
export async function resolveCustomerKey(shopDomain, durableId) {
  if (!durableId) return null;
  const row = await prisma.visitorIdentity
    .findUnique({ where: { shopDomain_durableId: { shopDomain, durableId } } })
    .catch(() => null);
  return row?.customerKey || null;
}

/** Cross-device / cross-session first-touch: given the customer a conversion belongs to, find the
 *  EARLIEST first-touch recorded on ANY device or session linked to that customer via the identity graph.
 *  Lets a conversion inherit the visitor's original source even when they first browsed on a different
 *  device (or in a since-churned _ga session) — the same-device key alone would look direct.
 *  `firstTouchFor` is delivery.getFirstTouch, injected to avoid an import cycle. Best-effort → null. */
export async function resolveIdentityFirstTouch(shopDomain, customerKey, firstTouchFor) {
  if (!customerKey || typeof firstTouchFor !== "function") return null;
  const rows = await prisma.visitorIdentity
    .findMany({ where: { shopDomain, customerKey }, orderBy: { firstSeen: "asc" } })
    .catch(() => []);
  // Rows are earliest-linked first; first-touch is keyed on the visitor key (durable id, else client id),
  // exactly as recordVisit/getFirstTouch store it. Return the earliest device that has a recorded source.
  for (const row of rows) {
    const ft = (await firstTouchFor(shopDomain, row.durableId)) || (row.clientId ? await firstTouchFor(shopDomain, row.clientId) : null);
    if (ft) return ft;
  }
  return null;
}

/** Counts for the attribution dashboard: total durable visitors tracked and how many have been stitched
 *  to a customer (identified). Best-effort → zeros. */
export async function identityStats(shopDomain) {
  const [visitors, identified] = await Promise.all([
    prisma.visitorIdentity.count({ where: { shopDomain } }).catch(() => 0),
    prisma.visitorIdentity.count({ where: { shopDomain, customerKey: { not: null } } }).catch(() => 0),
  ]);
  return { visitors, identified };
}

/**
 * Capture-health snapshot for the observability tile: is the storefront actually sending visits, and are
 * durable ids minting + stitching to customers? Turns "is it capturing?" into numbers you can point at
 * (proves the deploy is live; spots a future regression). Every durable-id beacon upserts a VisitorIdentity,
 * so its lastSeen is the truest "last visit received" signal (VisitorAttribution only fills on UTM visits).
 */
export async function captureHealth(shopDomain) {
  const now = Date.now();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const [latest, visitors, identified, minted7d] = await Promise.all([
    prisma.visitorIdentity.findFirst({ where: { shopDomain }, orderBy: { lastSeen: "desc" }, select: { lastSeen: true } }).catch(() => null),
    prisma.visitorIdentity.count({ where: { shopDomain } }).catch(() => 0),
    prisma.visitorIdentity.count({ where: { shopDomain, customerKey: { not: null } } }).catch(() => 0),
    prisma.visitorIdentity.count({ where: { shopDomain, firstSeen: { gte: since7d } } }).catch(() => 0),
  ]);
  const lastVisitAt = latest?.lastSeen || null;
  const minutesSince = lastVisitAt ? Math.round((now - new Date(lastVisitAt).getTime()) / 60000) : null;
  return {
    lastVisitAt,
    minutesSinceLastVisit: minutesSince,
    // Live if we've seen a visit in the last 24h — the embed is deployed and beaconing.
    live: minutesSince != null && minutesSince <= 60 * 24,
    durableIds: visitors,
    identified,
    identifiedRate: visitors ? Math.round((identified / visitors) * 100) : 0,
    minted7d,
  };
}
