// FX rate storage + the delivery hook for multi-currency normalization. Rates are stored USD-based
// (units of a currency per 1 USD) in a daily FxRate snapshot, refreshed once/day by /cron/tick from a
// free endpoint. All best-effort: if rates are unavailable the hook is a no-op and amounts ship as-is.
import prisma from "../db.server";
import { normalizeParams } from "./currency";

const FX_BASE = "USD";
// Keyless, USD-based daily rates (~160 currencies, includes USD:1). Was api.exchangerate.host, which moved
// behind a required access_key and now returns {success:false, error:missing_access_key} with NO `rates`
// field — so the refresh failed every tick ("no rates in response"). open.er-api.com is the free, no-key
// replacement returning the same {rates:{...}} shape. Override with FX_RATES_URL if ever needed.
const FX_ENDPOINT = process.env.FX_RATES_URL || `https://open.er-api.com/v6/latest/${FX_BASE}`;
const today = () => new Date().toISOString().slice(0, 10);
// Don't normalize on a stale snapshot: if the daily refresh has been failing, an FX rate that's days old
// silently skews every reported conversion value. Past this many days we treat rates as unavailable and
// ship amounts un-normalized (a no-op) rather than converting on drifted numbers.
const MAX_FX_AGE_DAYS = 7;

/** Fetch today's USD-based rates into FxRate (once/day). Best-effort — returns a small summary. */
export async function refreshFxRates() {
  const date = today();
  const existing = await prisma.fxRate.findUnique({ where: { base_date: { base: FX_BASE, date } } }).catch(() => null);
  if (existing) return { refreshed: false, reason: "already have today" };
  try {
    const res = await fetch(FX_ENDPOINT);
    if (!res.ok) return { refreshed: false, reason: `http ${res.status}` };
    const json = await res.json().catch(() => ({}));
    const rates = json?.rates;
    // A valid map has a numeric rate for at least one real currency — guards against an error-shaped body
    // that happens to carry an empty/rate-less `rates` object.
    if (!rates || typeof rates !== "object" || !Number.isFinite(Number(rates.EUR ?? rates.GBP ?? rates.USD))) {
      return { refreshed: false, reason: "no rates in response" };
    }
    rates[FX_BASE] = 1;
    await prisma.fxRate.upsert({
      where: { base_date: { base: FX_BASE, date } },
      create: { base: FX_BASE, date, rates: JSON.stringify(rates) },
      update: { rates: JSON.stringify(rates), fetchedAt: new Date() },
    });
    return { refreshed: true, count: Object.keys(rates).length };
  } catch (e) {
    return { refreshed: false, reason: e?.message || "fetch failed" };
  }
}

// Most recent stored rates map (today's if present, else the newest snapshot within MAX_FX_AGE_DAYS),
// or null. A snapshot older than the cap is ignored so we never convert on a drifted rate.
async function currentRates() {
  const row =
    (await prisma.fxRate.findUnique({ where: { base_date: { base: FX_BASE, date: today() } } }).catch(() => null)) ||
    (await prisma.fxRate.findFirst({ where: { base: FX_BASE }, orderBy: { date: "desc" } }).catch(() => null));
  if (!row) return null;
  // Reject a stale fallback snapshot (row.date is YYYY-MM-DD UTC).
  const ageDays = (Date.now() - Date.parse(`${row.date}T00:00:00Z`)) / 86_400_000;
  if (!(ageDays <= MAX_FX_AGE_DAYS)) return null;
  try {
    return JSON.parse(row.rates);
  } catch {
    return null;
  }
}

/** buildJobs hook that normalizes each destination's amounts into the shop's reporting currency.
 *  Returns {} (no-op) unless multi-currency is on, a reporting currency is set, and rates are loaded. */
export async function fxHooks(settings) {
  if (settings?.fxMode !== "on" || !settings?.reportingCurrency) return {};
  const rates = await currentRates();
  if (!rates) return {};
  const to = settings.reportingCurrency;
  return { normalizeParams: (obj) => normalizeParams(obj, { rates, to }) };
}

/** Normalize a single already-built params object (for paths that don't go through buildJobs, e.g. the
 *  orders/paid subscription webhook). Best-effort; no-op when multi-currency is off or rates missing. */
export async function normalizeForShop(settings, params) {
  if (settings?.fxMode !== "on" || !settings?.reportingCurrency || !params) return params;
  const rates = await currentRates();
  if (!rates) return params;
  return normalizeParams(params, { rates, to: settings.reportingCurrency });
}
