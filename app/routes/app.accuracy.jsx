import { Suspense } from "react";
import { useLoaderData, useRevalidator, Await } from "@remix-run/react";
import { defer } from "@remix-run/node";
import { Page, Card, BlockStack, InlineStack, Text, Badge, Banner, ProgressBar, Divider, SkeletonBodyText, SkeletonDisplayText } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { computeHealth } from "../lib/health.server";
import { getMatchQuality } from "../lib/delivery.server";
import { SectionHeading } from "../components/SectionHeading";

// Human labels for the Meta identifier columns, ordered by match-quality impact (email/phone move EMQ
// the most). Reconciliation-backfilled purchases carry no browser cookies, so fbp/fbc read lower — the
// copy explains that.
const ID_LABELS = [
  ["em", "Email"], ["ph", "Phone"], ["fn", "First name"], ["ln", "Last name"],
  ["ct", "City"], ["st", "State"], ["zp", "Zip"], ["country", "Country"],
  ["externalId", "Customer ID"], ["fbp", "Meta browser ID (fbp)"], ["fbc", "Meta click ID (fbc)"],
  ["clientIp", "IP address"], ["userAgent", "User agent"],
];

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
    },
    recoveredCurrency: tracking?.reportingCurrency || null,
    alerts: health.alerts,
    outboxPending: health.outboxPending,
    outboxDead: health.outboxDead,
    matchQuality,
  };
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);

function Stat({ title, value, sub, progress, tone }) {
  return (
    <div style={{ flex: "1 1 220px" }}>
      <Card>
        <BlockStack gap="200">
          <Text as="span" variant="bodySm" tone="subdued">{title}</Text>
          <Text as="span" variant="heading2xl">{value}</Text>
          {progress != null && <ProgressBar progress={Math.min(100, progress)} tone={tone} size="small" />}
          {sub && <Text as="span" variant="bodySm" tone="subdued">{sub}</Text>}
        </BlockStack>
      </Card>
    </div>
  );
}

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
      subtitle="How completely your store's purchases and events are being captured and delivered (last 30 days)."
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
              <Stat
                title="Purchase capture (30d)"
                value={matchRate == null ? "-" : `${matchRate}%`}
                sub={`${totals.purchasesDelivered} purchase events / ${totals.ordersPaid} paid orders`}
                progress={matchRate ?? 0}
                tone={matchRate != null && matchRate < 90 ? "critical" : "success"}
              />
              <Stat
                title="Revenue recovered (30d)"
                value={recovered === 0 ? formatMoney(0, recoveredCurrency) : formatMoney(totals.revenueRecovered, recoveredCurrency)}
                sub={
                  recovered === 0
                    ? "Purchases the pixel missed are backfilled here"
                    : `across ${recovered} purchase${recovered === 1 ? "" : "s"} the storefront pixel missed`
                }
                tone="success"
              />
              <Stat
                title="Delivery success (30d)"
                value={deliveryRate == null ? "-" : `${deliveryRate}%`}
                sub={`${totals.eventsSent} delivered / ${totals.eventsFailed} failed`}
                progress={deliveryRate ?? 0}
                tone={deliveryRate != null && deliveryRate < 98 ? "critical" : "success"}
              />
              <Stat title="Events sent (30d)" value={totals.eventsSent.toLocaleString()} sub="Server-side deliveries" />
              <Stat
                title="Retry queue"
                value={(outboxPending || 0).toLocaleString()}
                sub={outboxDead > 0 ? `${outboxDead} gave up after retries` : "Failed sends awaiting retry"}
                tone={outboxDead > 0 ? "critical" : undefined}
              />
            </InlineStack>

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
          </>
        )}
      </BlockStack>
  );
}
