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
 *  once the visitor identifies at checkout/login). Best-effort. Only sets fields (never nulls them). */
export async function linkIdentity(shopDomain, { durableId, clientId, customerKey } = {}) {
  if (!durableId) return;
  await prisma.visitorIdentity
    .upsert({
      where: { shopDomain_durableId: { shopDomain, durableId } },
      create: { shopDomain, durableId, clientId: clientId || null, customerKey: customerKey || null },
      update: { ...(clientId ? { clientId } : {}), ...(customerKey ? { customerKey } : {}) },
    })
    .catch(() => {});
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

/** Counts for the attribution dashboard: total durable visitors tracked and how many have been stitched
 *  to a customer (identified). Best-effort → zeros. */
export async function identityStats(shopDomain) {
  const [visitors, identified] = await Promise.all([
    prisma.visitorIdentity.count({ where: { shopDomain } }).catch(() => 0),
    prisma.visitorIdentity.count({ where: { shopDomain, customerKey: { not: null } } }).catch(() => 0),
  ]);
  return { visitors, identified };
}
