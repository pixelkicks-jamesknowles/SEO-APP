import { Suspense } from "react";
import { useLoaderData, useRevalidator, Await, useFetcher } from "@remix-run/react";
import { defer } from "@remix-run/node";
import { Page, Card, BlockStack, InlineStack, Text, Badge, Banner, ProgressBar, Divider, SkeletonBodyText, SkeletonDisplayText, Button } from "@shopify/polaris";
import { authenticate, unauthenticated } from "../shopify.server";
import { runConsentAudit } from "../lib/consent-audit.server";
import { diagnoseGa4Attribution } from "../lib/ga4-diagnose.server";
import prisma from "../db.server";
import { computeHealth } from "../lib/health.server";
import { getMatchQuality } from "../lib/delivery.server";
import { SectionHeading } from "../components/SectionHeading";
import { Stat } from "../components/Stat";

// Human labels for the Meta identifier columns, ordered by match-quality impact (email/phone move EMQ
// the most). Reconciliation-backfilled purchases carry no browser cookies, so fbp/fbc read lower — the
// copy explains that.
const ID_LABELS = [
  ["em", "Email"], ["ph", "Phone"], ["fn", "First name"], ["ln", "Last name"],
  ["ct", "City"], ["st", "State"], ["zp", "Zip"], ["country", "Country"],
  ["externalId", "Customer ID"], ["fbp", "Meta browser ID (fbp)"], ["fbc", "Meta click ID (fbc)"],
  ["clientIp", "IP address"], ["userAgent", "User agent"],
];

// On-demand historical consent audit. Inline rather than a queued job: it writes nothing, and the merchant
// asking is comparing a number against a GA4 report they have open right now.
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const what = form.get("_action");
  if (what !== "consent-audit" && what !== "ga4-diagnose") return { ok: true };
  const { admin } = await unauthenticated.admin(session.shop);
  if (what === "ga4-diagnose") {
    const settings = await prisma.trackingSettings.findUnique({ where: { shopDomain: session.shop } }).catch(() => null);
    return { diagnose: await diagnoseGa4Attribution(admin, settings, { days: 7 }) };
  }
  return await runConsentAudit(admin, { days: 28 });
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  // Defer the data so the page shell (title + skeleton) paints immediately and the metrics stream in —
  // keeps LCP off the several DB round-trips this report needs. authenticate must still be awaited (it
  // can redirect for auth); only the data build is deferred.
  return defer({ data: buildAccuracy(session.shop) });
};

// The report build (all independent reads in one round-trip group). Kept as a non-awaited promise by the
// loader so it streams after the shell.
async function buildAccuracy(shopDomain) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [health, rows, tracking, matchQuality, channelRows] = await Promise.all([
    computeHealth(shopDomain),
    prisma.trackingDaily.findMany({ where: { shopDomain, date: { gte: since } }, orderBy: { date: "desc" } }),
    prisma.trackingSettings.findUnique({ where: { shopDomain }, select: { reportingCurrency: true } }),
    getMatchQuality(shopDomain, 30),
    // Subscription revenue attributed to a channel — GA4 reports every renewal as Unassigned (no session),
    // so this is revenue visibility the app adds that GA4 structurally cannot. Feeds the GA4-gap card.
    prisma.channelRevenueDaily.findMany({ where: { shopDomain, date: { gte: since } }, select: { subscriptionRevenue: true } }).catch(() => []),
  ]);
  const sum = (k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
  const subscriptionAttributed = channelRows.reduce((t, r) => t + (r.subscriptionRevenue || 0), 0);
  return {
    quality: health.quality,
    subscriptionAttributed,
    days: rows.map((r) => ({
      date: r.date,
      ordersPaid: r.ordersPaid,
      purchasesDelivered: r.purchasesDelivered,
      eventsSent: r.eventsSent,
      eventsFailed: r.eventsFailed,
    })),
    totals: {
      ordersPaid: sum("ordersPaid"),
      purchasesDelivered: sum("purchasesDelivered"),
      eventsSent: sum("eventsSent"),
      eventsFailed: sum("eventsFailed"),
      purchasesRecovered: sum("purchasesRecovered"),
      revenueRecovered: rows.reduce((t, r) => t + (r.revenueRecovered || 0), 0),
      consentGranted: sum("consentGranted"),
      consentDenied: sum("consentDenied"),
      consentUnknown: sum("consentUnknown"),
      purchaseConsentGranted: sum("purchaseConsentGranted"),
      purchaseConsentDenied: sum("purchaseConsentDenied"),
    },
    recoveredCurrency: tracking?.reportingCurrency || null,
    alerts: health.alerts,
    outboxPending: health.outboxPending,
    outboxDead: health.outboxDead,
    matchQuality,
  };
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);


// Format a recovered-revenue amount. Uses the shop's reporting currency when set; otherwise shows a
// plain number (mixed-currency stores have no single symbol to show).
function formatMoney(amount, currency) {
  const n = Math.round(amount || 0);
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
    } catch {
      /* invalid currency code → fall through to a plain number */
    }
  }
  return n.toLocaleString();
}

// Placeholder shown while the metrics stream in — a large stat row + card so a sizeable element paints
// early (helps LCP) and the layout doesn't jump when the data arrives.
function AccuracySkeleton() {
  return (
    <BlockStack gap="400">
      <InlineStack gap="400" wrap>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={{ flex: "1 1 220px" }}>
            <Card>
              <BlockStack gap="200">
                <SkeletonBodyText lines={1} />
                <SkeletonDisplayText size="large" />
              </BlockStack>
            </Card>
          </div>
        ))}
      </InlineStack>
      <Card>
        <BlockStack gap="300">
          <SkeletonDisplayText size="small" />
          <Divider />
          <SkeletonBodyText lines={8} />
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

export default function Accuracy() {
  const { data } = useLoaderData();
  const revalidator = useRevalidator();
  return (
    <Page
      title="Accuracy"
      subtitle="How much of your sales and events are being tracked and sent — and the revenue this app recovers that you'd otherwise miss (last 30 days)."
      primaryAction={{ content: "Refresh", onAction: () => revalidator.revalidate() }}
    >
      <Suspense fallback={<AccuracySkeleton />}>
        <Await resolve={data} errorElement={<Banner tone="critical" title="Couldn't load accuracy data">Refresh to try again.</Banner>}>
          {(resolved) => <AccuracyBody {...resolved} />}
        </Await>
      </Suspense>
    </Page>
  );
}

function AccuracyBody({ days, totals, recoveredCurrency, alerts, outboxPending, outboxDead, matchQuality, quality, subscriptionAttributed }) {
  const matchRate = pct(totals.purchasesDelivered, totals.ordersPaid);
  const sends = totals.eventsSent + totals.eventsFailed;
  const deliveryRate = pct(totals.eventsSent, sends);
  // Rate over events that carried a REAL consent signal. Events with no signal (Consent mode off, or no
  // CMP on the storefront) are reported separately instead of counting as acceptance — otherwise a store
  // that never sends consent state reads a meaningless 100%.
  const consentSeen = (totals.consentGranted || 0) + (totals.consentDenied || 0);
  const consentRate = pct(totals.consentGranted || 0, consentSeen);
  const consentUnknown = totals.consentUnknown || 0;
  const optedOutOrders = totals.purchaseConsentDenied || 0;
  const purchaseConsentSeen = (totals.purchaseConsentGranted || 0) + optedOutOrders;
  // Every paid order is the honest denominator. Only purchases the storefront pixel actually saw carry a
  // consent signal, so the rest are orders we simply have no answer for — shown as such rather than
  // leaving the tile stuck on "no data" when the pixel misses checkout (which is the normal case).
  const ordersNoConsentSignal = Math.max(0, (totals.ordersPaid || 0) - purchaseConsentSeen);
  const hasData = totals.ordersPaid > 0 || sends > 0;
  const recovered = totals.purchasesRecovered || 0;
  // GA4 gap: revenue this app makes visible that GA4 alone would miss — pixel-missed purchases we
  // backfilled server-side (ad-blockers / ITP / the checkout sandbox) PLUS subscription renewals GA4
  // reports as Unassigned (no browser session to attribute).
  const ga4Gap = (totals.revenueRecovered || 0) + (subscriptionAttributed || 0);
  const qualityTone = quality?.score == null ? undefined : quality.score >= 85 ? "success" : quality.score >= 70 ? undefined : "critical";

  return (
    <BlockStack gap="400">
        {!hasData ? (
          <Banner tone="info">
            No data yet. These figures populate as paid orders and storefront events start flowing.
            Browse and place a test order on your storefront to see them appear.
          </Banner>
        ) : (
          <>
            {alerts.map((a) => (
              <Banner key={a.kind} tone={a.severity === "critical" ? "critical" : "warning"} title={a.title}>
                {a.body}
              </Banner>
            ))}

            {quality?.score != null && (
              <Card>
                <InlineStack gap="400" blockAlign="center" align="space-between" wrap>
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">Tracking data quality (30d)</Text>
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" variant="heading2xl">{quality.score}%</Text>
                      <Badge tone={qualityTone === "success" ? "success" : qualityTone === "critical" ? "critical" : "attention"}>{`${quality.grade} — ${quality.label}`}</Badge>
                    </InlineStack>
                    <Text as="span" variant="bodySm" tone="subdued">Blends purchase capture and delivery success, less any dead-lettered sends or a stalled worker.</Text>
                  </BlockStack>
                  <div style={{ minWidth: 220, flex: "1 1 220px" }}>
                    <ProgressBar progress={quality.score} tone={qualityTone} size="small" />
                  </div>
                </InlineStack>
              </Card>
            )}

            {ga4Gap > 0 && (
              <Banner tone="success" title={`${formatMoney(ga4Gap, recoveredCurrency)} of revenue is visible here that GA4 alone would miss (30d)`}>
                <BlockStack gap="100">
                  <Text as="p">
                    {formatMoney(totals.revenueRecovered, recoveredCurrency)} from purchases the storefront pixel missed
                    (ad-blockers, Safari ITP, the checkout sandbox) and backfilled server-side, plus{" "}
                    {formatMoney(subscriptionAttributed, recoveredCurrency)} of subscription renewals attributed to a
                    channel — which GA4 reports as Unassigned because a renewal has no browser session.
                  </Text>
                </BlockStack>
              </Banner>
            )}

            <InlineStack gap="400" wrap>
              <Stat basis="220px"
                title="Purchase capture (30d)"
                value={matchRate == null ? "-" : `${matchRate}%`}
                sub={`${totals.purchasesDelivered} purchase events / ${totals.ordersPaid} paid orders`}
                progress={matchRate ?? 0}
                tone={matchRate != null && matchRate < 90 ? "critical" : "success"}
              />
              <Stat basis="220px"
                title="Revenue recovered (30d)"
                value={recovered === 0 ? formatMoney(0, recoveredCurrency) : formatMoney(totals.revenueRecovered, recoveredCurrency)}
                sub={
                  recovered === 0
                    ? "Purchases the pixel missed are backfilled here"
                    : `across ${recovered} purchase${recovered === 1 ? "" : "s"} the storefront pixel missed`
                }
                tone="success"
              />
              <Stat basis="220px"
                title="Delivery success (30d)"
                value={deliveryRate == null ? "-" : `${deliveryRate}%`}
                sub={`${totals.eventsSent} delivered / ${totals.eventsFailed} failed`}
                progress={deliveryRate ?? 0}
                tone={deliveryRate != null && deliveryRate < 98 ? "critical" : "success"}
              />
              <Stat basis="220px" title="Events sent (30d)" value={totals.eventsSent.toLocaleString()} sub="Server-side deliveries" />
              <Stat basis="220px"
                title="Consent rate (30d)"
                value={consentRate == null ? "-" : `${consentRate}%`}
                sub={
                  consentRate == null
                    ? consentUnknown > 0
                      ? `No consent signal on ${consentUnknown.toLocaleString()} events — turn on Consent mode, or check your cookie banner is wired to Shopify's Customer Privacy API`
                      : "Share of shoppers who accept analytics"
                    : `${(totals.consentGranted || 0).toLocaleString()} of ${consentSeen.toLocaleString()} events had analytics consent` +
                      (consentUnknown > 0 ? ` · ${consentUnknown.toLocaleString()} sent no signal` : "")
                }
                progress={consentRate ?? 0}
                tone={consentRate == null ? (consentUnknown > 0 ? "warning" : undefined) : consentRate < 50 ? "critical" : undefined}
              />
              <Stat basis="220px"
                title="Orders opted out of tracking (30d)"
                value={optedOutOrders.toLocaleString()}
                sub={
                  purchaseConsentSeen === 0
                    ? ordersNoConsentSignal > 0
                      // NOT "enable the app embed" — that advice was wrong and cost real time. The embed
                      // was enabled all along; the attribute it should have written was dead code (a
                      // duplicate syncCartIds shadowed it) until the 2026-09-16 release, so no order before
                      // then can ever carry one. Nothing to fix and nothing to backfill: consent DENIED is
                      // unknowable in hindsight (unlike granted, which the historical audit below infers
                      // from ga_client_id), so filling only the granted side would turn this into a
                      // confident 0% opt-out rather than an honest blank.
                      ? `Not recorded on any of ${ordersNoConsentSignal.toLocaleString()} paid orders. Consent has only been captured since the latest theme-extension release, and it cannot be recovered for earlier orders — see the historical estimate below.`
                      : "No checkout consent data yet"
                    : `of ${purchaseConsentSeen.toLocaleString()} orders with a consent signal` +
                      (ordersNoConsentSignal > 0 ? ` · ${ordersNoConsentSignal.toLocaleString()} more had none captured` : "")
                }
                tone={optedOutOrders > 0 ? "warning" : undefined}
              />
              <Stat basis="220px"
                title="Retry queue"
                value={(outboxPending || 0).toLocaleString()}
                sub={outboxDead > 0 ? `${outboxDead} gave up after retries` : "Failed sends awaiting retry"}
                tone={outboxDead > 0 ? "critical" : undefined}
              />
            </InlineStack>

            <ConsentAudit />
            <Ga4Diagnose />

            <Card>
              <BlockStack gap="300">
                <SectionHeading
                  title="By day"
                  description="Paid orders vs purchase events delivered, and server-side send volume."
                />
                <Divider />
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <caption style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
                    Daily paid orders, purchase events delivered, match rate and server-side send volume (last 30 days)
                  </caption>
                  <thead>
                    <tr>
                      {["Date", "Orders", "Purchases", "Match", "Sent", "Failed"].map((h) => (
                        <th key={h} scope="col" style={{ textAlign: h === "Date" ? "left" : "right", padding: "var(--p-space-150) var(--p-space-300)" }}>
                          <Text as="span" variant="bodySm" tone="subdued">{h}</Text>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((d) => {
                      const m = pct(d.purchasesDelivered, d.ordersPaid);
                      return (
                        <tr key={d.date} style={{ borderTop: "1px solid var(--p-color-border-subdued)" }}>
                          <th scope="row" style={{ textAlign: "left", fontWeight: "normal", padding: "var(--p-space-150) var(--p-space-300)" }}>
                            <Text as="span" variant="bodyMd">{d.date}</Text>
                          </th>
                          <td style={{ textAlign: "right", padding: "var(--p-space-150) var(--p-space-300)" }}>{d.ordersPaid}</td>
                          <td style={{ textAlign: "right", padding: "var(--p-space-150) var(--p-space-300)" }}>{d.purchasesDelivered}</td>
                          <td style={{ textAlign: "right", padding: "var(--p-space-150) var(--p-space-300)" }}>
                            {m == null ? "-" : <Badge tone={m < 90 ? "warning" : "success"}>{`${m}%`}</Badge>}
                          </td>
                          <td style={{ textAlign: "right", padding: "var(--p-space-150) var(--p-space-300)" }}>{d.eventsSent}</td>
                          <td style={{ textAlign: "right", padding: "var(--p-space-150) var(--p-space-300)" }}>
                            {d.eventsFailed > 0 ? <Text as="span" tone="critical">{d.eventsFailed}</Text> : 0}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <SectionHeading
                  title="Meta match quality (30d)"
                  description="Meta's Event Match Quality is driven by how many identifiers each purchase carries. Higher coverage = more conversions attributed. Email and phone move it the most; capture them at checkout to lift the low ones."
                />
                <Divider />
                {matchQuality.purchases === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">No purchases recorded yet in the last 30 days.</Text>
                ) : (
                  <BlockStack gap="200">
                    <Text as="span" variant="bodySm" tone="subdued">Across {matchQuality.purchases.toLocaleString()} purchase{matchQuality.purchases === 1 ? "" : "s"}:</Text>
                    {ID_LABELS.map(([col, label]) => {
                      const cov = matchQuality.coverage[col] ?? 0;
                      return (
                        <InlineStack key={col} gap="300" blockAlign="center" wrap={false}>
                          <div style={{ width: 160 }}><Text as="span" variant="bodySm">{label}</Text></div>
                          <div style={{ flex: 1 }}><ProgressBar progress={cov} tone={cov >= 70 ? "success" : cov >= 30 ? "highlight" : "critical"} size="small" /></div>
                          <div style={{ width: 44, textAlign: "right" }}><Text as="span" variant="bodySm" tone="subdued">{cov}%</Text></div>
                        </InlineStack>
                      );
                    })}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Text as="p" tone="subdued" variant="bodySm">
              Match rate compares purchase events we delivered against paid orders Shopify reported.
              Below 100% is normal (consent, bots, sessions that didn&apos;t reach checkout tracking);
              a sudden drop is the signal to investigate. Missed purchases are automatically backfilled
              server-side within about 20 minutes (reconciliation), so this should trend toward 100%.
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              <b>About consent:</b> if a shopper declines analytics on your cookie banner, their sale is still
              counted here (it&apos;s a real paid order and we still record it), but with Consent Mode on we
              only send Google a privacy-safe, modelled signal for it and send nothing to marketing
              destinations. So a healthy match rate here doesn&apos;t mean every sale was fully tracked in your
              ad platforms — consented traffic is what those receive in full.
            </Text>
          </>
        )}
      </BlockStack>
  );
}


/**
 * Historical consent evidence, on demand.
 *
 * The consent tiles above only cover orders placed since the embed started recording consent (2026-09-16).
 * For everything before that the signal was never written, so the question "did shoppers actually consent?"
 * can only be answered by inference — see lib/consent-audit.js for why ga_client_id is the evidence and why
 * it can only ever produce a FLOOR, never a denied count.
 *
 * Exists to settle one specific argument: whether consent explains a high "Unassigned" share in GA4. If the
 * floor is far above the share GA4 gave a real channel to, consent is not the cause.
 */
function ConsentAudit() {
  const fetcher = useFetcher();
  const r = fetcher.data;
  const running = fetcher.state !== "idle";
  const pct = (n) => `${n.toFixed(1)}%`;
  return (
    <Card>
      <BlockStack gap="300">
        <SectionHeading
          title="Check historical consent"
          description="Orders placed before consent recording started carry no consent signal, but one can be inferred: the embed only ever wrote a GA client id once analytics consent was granted. This counts how many of your recent orders carry one. It reads your orders and changes nothing."
        />
        <Divider />
        {r?.error && <Banner tone="critical" title="Couldn't finish the audit">{r.error}</Banner>}
        {r && !r.error && (
          <BlockStack gap="200">
            <Text as="p" variant="headingLg">
              At least {pct(r.excludingRenewals.floorPct)} granted
            </Text>
            <Text as="p" tone="subdued">
              {r.excludingRenewals.withId.toLocaleString()} of {r.excludingRenewals.total.toLocaleString()} orders
              since {r.since} carried a GA client id, so analytics consent was granted for at least that many.
              Renewals are excluded: they have no browser session, so they can never carry one and their
              absence says nothing about consent.
            </Text>
            <Text as="p" tone="subdued">
              This is a floor, never a ceiling. A missing id can mean consent was declined, but equally that
              the embed had not run, an ad blocker intervened, or Google Analytics had not yet set its cookie
              — so the real figure is higher than this, never lower.
            </Text>

            {/* The actual diagnostic. A client id proves consent; it does NOT get the sale attributed. GA4
                needs client_id AND session_id to join the purchase to a session that has a traffic source.
                The embed writes the session id only when it can read a `_ga_<CONTAINER>` cookie, and that
                suffix comes from the Measurement ID on the Tracking page — so a different on-page property
                means client id lands, session id never does, and every sale reports as Unassigned. A big
                gap between these two numbers IS that fault. */}
            <Banner
              tone={
                r.excludingRenewals.withId > 0 && r.excludingRenewals.sessionPct < r.excludingRenewals.floorPct / 2
                  ? "warning"
                  : "info"
              }
              title={`${r.excludingRenewals.sessionPct.toFixed(1)}% also carried a GA session id`}
            >
              <p>
                {r.excludingRenewals.withSession.toLocaleString()} of{" "}
                {r.excludingRenewals.total.toLocaleString()} orders. GA4 needs the session id as well as the
                client id to give a sale a channel, so this is the number that decides whether purchases land
                in Unassigned.
              </p>
              {r.excludingRenewals.withId > 0 && r.excludingRenewals.sessionPct < r.excludingRenewals.floorPct / 2 && (
                <p>
                  Far below the client-id rate, which points at the GA4 Measurement ID on the Tracking page
                  not matching the property actually firing on your storefront. When they differ the embed
                  cannot find the session cookie, so the session id is never captured.
                </p>
              )}
            </Banner>

            {/* Is the CURRENT embed live? This attribute has only been written since 2026-09-16, so zero of
                them on recent orders means the extension deploy never reached storefronts. */}
            <Banner tone={r.consentSignal.total > 0 ? "success" : "warning"} title={r.consentSignal.total > 0 ? "Consent recording is live" : "Consent recording is not reaching orders"}>
              <p>
                {r.consentSignal.total > 0
                  ? `${r.consentSignal.total.toLocaleString()} of the orders scanned carry an explicit consent attribute (${r.consentSignal.granted.toLocaleString()} granted, ${r.consentSignal.denied.toLocaleString()} declined). That figure will grow to cover every order from here on.`
                  : "None of the orders scanned carry the explicit consent attribute."}
              </p>
              {/* The build marker separates the two reasons the attribute can be missing. Without it, a
                  release that was created but never made live looks identical to one that shipped fine but
                  has had no orders yet — which is exactly the ambiguity that left this unresolved. */}
              {r.consentSignal.total === 0 && (
                <p>
                  {r.newEmbedOrders > 0
                    ? `${r.newEmbedOrders.toLocaleString()} orders WERE written by the current embed, so the release is live and the consent attribute is failing for another reason — worth reporting.`
                    : "No order scanned was written by the current embed either, so the release has not reached your storefront. Check the app version list in the Partner Dashboard: a version that was created but never made live behaves exactly like this."}
                </p>
              )}
            </Banner>
            {!r.complete && (
              <Banner tone="info">
                Stopped early to keep the page responsive, so this covers the {r.scanned.toLocaleString()} most
                recent orders rather than the full {r.days} days. It is a recent sample, not a total.
              </Banner>
            )}
            <BlockStack gap="100">
              {r.rows.map((row) => (
                <Text as="p" variant="bodySm" tone="subdued" key={row.type}>
                  {row.type}: client id {row.withId.toLocaleString()}/{row.total.toLocaleString()} ({pct(row.pct)})
                  {" · "}session id {row.withSession.toLocaleString()}/{row.total.toLocaleString()} ({pct(row.sessionPct)})
                  {row.type === "renewal" ? " — excluded from the figures above" : ""}
                </Text>
              ))}
            </BlockStack>
          </BlockStack>
        )}
        <InlineStack>
          <fetcher.Form method="post">
            <input type="hidden" name="_action" value="consent-audit" />
            <Button submit loading={running} disabled={running}>
              {r ? "Check again" : "Check last 28 days"}
            </Button>
          </fetcher.Form>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

/**
 * Ask GA4 what it makes of a real purchase payload.
 *
 * The consent audit ruled out the two obvious explanations for Unassigned: consent was granted (61% of
 * subscription checkouts carry a client id) and the session id lands at exactly the same rate, so the
 * measurement ID matches too. Reading the send path confirms both ids and the real timestamp are sent.
 * Beyond that only GA4 can say why it will not honour the session join — so this posts the exact payload to
 * its debug endpoint and prints the reply verbatim rather than paraphrasing it.
 */
function Ga4Diagnose() {
  const fetcher = useFetcher();
  const d = fetcher.data?.diagnose;
  const running = fetcher.state !== "idle";
  return (
    <Card>
      <BlockStack gap="300">
        <SectionHeading
          title="Ask GA4 why a purchase isn't attributed"
          description="Takes your most recent order that carries both a GA client id and session id, rebuilds the exact payload we send for it, and asks Google to validate it. Uses GA4's debug endpoint, which checks the payload without recording anything, so it cannot create a conversion."
        />
        <Divider />
        {d?.error && <Banner tone="critical" title="Couldn't run the check">{d.error}</Banner>}
        {d && !d.error && (
          <BlockStack gap="200">
            <Banner tone={d.ok ? "success" : "critical"} title={d.ok ? "Google accepts the payload" : "Google rejected the payload"}>
              {d.ok ? (
                <p>
                  GA4 reports no problems with what we send for order {d.order?.name}, including the session
                  id. If those sales still show as Unassigned, the payload is not the cause and the next place
                  to look is the GA4 property itself — check this order in DebugView.
                </p>
              ) : (
                <BlockStack gap="100">
                  {d.messages.map((m, i) => (
                    <Text as="p" key={i}>{m}</Text>
                  ))}
                </BlockStack>
              )}
            </Banner>
            <Text as="p" variant="bodySm" tone="subdued">
              Order {d.order?.name} · client id {d.clientId} · session id {d.sessionId}
              {d.minutesAfterSessionStart != null ? ` · placed ${d.minutesAfterSessionStart} min after that session began` : ""}
            </Text>
            {d.minutesAfterSessionStart != null && d.minutesAfterSessionStart > 30 && (
              <Banner tone="warning" title="The session had probably already ended">
                <p>
                  GA4 closes a session after 30 minutes of inactivity and will not join an event to one that
                  has ended — it starts a fresh, source-less session instead, which reports as Unassigned.
                  This order was placed {d.minutesAfterSessionStart} minutes after its session began, so the
                  id we send may point at a session GA4 has already closed.
                </p>
              </Banner>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              Payload sent: <code>{JSON.stringify(d.body)}</code>
            </Text>
          </BlockStack>
        )}
        <InlineStack>
          <fetcher.Form method="post">
            <input type="hidden" name="_action" value="ga4-diagnose" />
            <Button submit loading={running} disabled={running}>
              {d ? "Check again" : "Validate a real purchase"}
            </Button>
          </fetcher.Form>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
