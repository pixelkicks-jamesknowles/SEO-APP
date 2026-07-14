import { Suspense, useState } from "react";
import { useLoaderData, useRevalidator, useFetcher, Await } from "@remix-run/react";
import { defer } from "@remix-run/node";
import { Page, Card, BlockStack, InlineStack, Text, Banner, Divider, Badge, Button, List, Select, SkeletonBodyText, SkeletonDisplayText } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { SectionHeading } from "../components/SectionHeading";
import { byFirstTouch, touchDistribution, multiTouchShare, firstVsLastShift, bySubscriptionSource, byChannelRevenue, byChannelGroup, ltvByChannel } from "../lib/attribution-report";
import { creditByModel, MODELS, MODEL_LABELS } from "../lib/multi-touch";
import { identityStats } from "../lib/identity.server";
import { requestBackfill, backfillStatus } from "../lib/backfill.server";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("_action") === "backfill") {
    // Queued, not run inline: paging a store's order history takes minutes, so /cron/tick advances it a
    // few pages at a time (leased + resumable).
    return await requestBackfill(session.shop, { days: 90 });
  }
  return { ok: true };
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  // Defer the report so the page shell paints immediately and the tables stream in — this report scans up
  // to two 5,000-row tables + aggregates, so keeping it off the initial paint is the main LCP lever here.
  // The backfill status is cheap (one row) and drives the card, so it's awaited.
  const backfill = await backfillStatus(session.shop);
  return defer({ backfill, report: buildReport(session.shop) });
};

// Build the attribution report (all reads in one round-trip group). Kept as a non-awaited promise by the
// loader so it streams after the shell.
async function buildReport(shopDomain) {
  // Cap the scan so a very busy shop's report stays fast; newest visitors first. When a cap is hit the
  // report reflects only the most recent SCAN_CAP rows, so we flag it rather than presenting a partial
  // aggregate as if it were the whole history.
  const SCAN_CAP = 5000;
  const since90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [visitors, customers, channelRows, identity, lifetimes] = await Promise.all([
    prisma.visitorAttribution.findMany({ where: { shopDomain }, orderBy: { lastSeen: "desc" }, take: SCAN_CAP }),
    prisma.customerAttribution.findMany({ where: { shopDomain }, orderBy: { updatedAt: "desc" }, take: SCAN_CAP }),
    prisma.channelRevenueDaily.findMany({ where: { shopDomain, date: { gte: since90 } } }).catch(() => []),
    identityStats(shopDomain),
    // Per-customer lifetime (backfill-populated) → LTV / retention by acquiring channel.
    prisma.customerLifetime.findMany({ where: { shopDomain }, take: SCAN_CAP }).catch(() => []),
  ]);
  const revenue = byChannelRevenue(channelRows);
  const channelGroups = byChannelGroup(channelRows);
  const ltv = ltvByChannel(customers, lifetimes).slice(0, 15);

  // Multi-touch: read converting visitors' touch paths (last 90d) and pre-compute every model server-side,
  // so the UI can switch models instantly. Results are small (per-channel), so sending all of them is cheap.
  const since90date = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const convPaths = await prisma.conversionPath.findMany({ where: { shopDomain, conversionAt: { gte: since90date } }, take: SCAN_CAP }).catch(() => []);
  const paths = convPaths.map((p) => {
    let touches = [];
    try {
      touches = JSON.parse(p.touches || "[]");
    } catch {
      touches = [];
    }
    return { value: p.value, conversionTs: p.conversionAt, touches };
  });
  // Only paths with a recorded journey are meaningful for model comparison.
  const withPath = paths.filter((p) => p.touches.length > 0);
  const multiTouch = withPath.length ? Object.fromEntries(MODELS.map((m) => [m, creditByModel(withPath, m)])) : null;
  return {
    totalVisitors: visitors.length,
    capped: visitors.length >= SCAN_CAP || customers.length >= SCAN_CAP,
    scanCap: SCAN_CAP,
    topSources: byFirstTouch(visitors).slice(0, 15),
    touches: touchDistribution(visitors),
    multiTouch: multiTouchShare(visitors),
    shifted: firstVsLastShift(visitors),
    subSources: bySubscriptionSource(customers).slice(0, 15),
    channels: revenue.channels.slice(0, 15),
    channelGroups,
    ltv,
    multiTouchModels: multiTouch,
    multiTouchPaths: withPath.length,
    channelTotalRevenue: revenue.totalRevenue,
    channelTotalOrders: revenue.totalOrders,
    channelSubscriptionRevenue: revenue.totalSubscriptionRevenue,
    channelSubscriptionOrders: revenue.totalSubscriptionOrders,
    identity,
  };
}

// Compact money formatting for the revenue table (the merchant's own store currency; no symbol assumed).
const fmtMoney = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Stat({ title, value, sub }) {
  return (
    <div style={{ flex: "1 1 200px" }}>
      <Card>
        <BlockStack gap="200">
          <Text as="span" variant="bodySm" tone="subdued">{title}</Text>
          <Text as="span" variant="heading2xl">{value}</Text>
          {sub && <Text as="span" variant="bodySm" tone="subdued">{sub}</Text>}
        </BlockStack>
      </Card>
    </div>
  );
}

const cell = { padding: "var(--p-space-150) var(--p-space-300)" };
const th = (align = "left") => ({ ...cell, textAlign: align });
// Row-header style: left-aligned like a data cell, but a semantic <th scope="row"> for screen readers.
export const rowHead = { ...cell, textAlign: "left", fontWeight: "normal" };

function Table({ caption, head, rows }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      {caption && (
        <caption style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          {caption}
        </caption>
      )}
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h} scope="col" style={th(i === 0 ? "left" : "right")}>
              <Text as="span" variant="bodySm" tone="subdued">{h}</Text>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );
}

// Placeholder shown while the report streams in — a stat row + two table cards so a sizeable element
// paints early (helps LCP) and the layout stays stable when the data arrives.
function AttributionSkeleton() {
  return (
    <BlockStack gap="400">
      <InlineStack gap="400" wrap>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ flex: "1 1 200px" }}>
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
          <SkeletonBodyText lines={6} />
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="300">
          <SkeletonDisplayText size="small" />
          <Divider />
          <SkeletonBodyText lines={5} />
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

export default function Attribution() {
  const { report, backfill } = useLoaderData();
  const revalidator = useRevalidator();
  return (
    <Page
      title="Attribution"
      subtitle="Which channels drive revenue, where your visitors first came from, and how their journey builds across sessions and devices."
      primaryAction={{ content: "Refresh", onAction: () => revalidator.revalidate() }}
    >
      <BlockStack gap="400">
        <BackfillCard backfill={backfill} />
        <Suspense fallback={<AttributionSkeleton />}>
          <Await resolve={report} errorElement={<Banner tone="critical" title="Couldn't load attribution data">Refresh to try again.</Banner>}>
            {(resolved) => <AttributionBody {...resolved} />}
          </Await>
        </Suspense>
      </BlockStack>
    </Page>
  );
}

/**
 * Rebuild revenue-by-channel from Shopify's order history.
 *
 * This report otherwise only fills from new orders, so it starts empty — and the question a subscription
 * business most wants answered ("which channel acquired the subscribers whose renewals pay us now?") is
 * answered by orders placed long before the app was installed. The backfill reads Shopify's OWN attribution
 * (each order's customer journey) and replays each customer's first touch onto their renewals.
 */
/**
 * Explain the (unattributed) bucket, with numbers.
 *
 * Left unexplained, whoever reads this report WILL assume the unknowns are organic — or direct — because
 * those are the two most flattering guesses and nothing contradicts them. They are neither. "(unattributed)"
 * means Shopify recorded NO customer journey for the order that acquired that customer: an API-created or
 * imported order, a migrated subscriber, or one won before journeys were captured. Organic traffic Shopify
 * DID see is attributed (its referrer resolves to a source) — so it never lands here.
 */
function UnattributedBreakdown({ backfill }) {
  let b = null;
  try {
    b = JSON.parse(backfill?.breakdown || "{}");
  } catch {
    b = null;
  }
  if (!b?.orders) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        <b>About (unattributed):</b> a customer is only credited to a channel if Shopify captured a journey
        (UTMs / referrer) on the order that <b>acquired</b> them. Where it didn&apos;t, we show{" "}
        <b>(unattributed)</b> rather than folding them into <b>(direct)</b> or assuming organic — either would
        flatter a channel and mislead you. Run the backfill and this becomes a breakdown with real numbers.
      </Text>
    );
  }
  const pctSub = b.orders ? Math.round((b.subscriptionOrders / b.orders) * 100) : 0;
  const migratedOrders = b.migratedOrders || 0;
  const lost = Math.max(b.orders - migratedOrders, 0);
  const pctMigrated = b.orders ? Math.round((migratedOrders / b.orders) * 100) : 0;
  return (
    <Banner tone="warning" title={`${b.orders.toLocaleString()} orders (${fmtMoney(b.revenue)}) couldn't be attributed — and they are NOT organic`}>
      <BlockStack gap="200">
        <Text as="p">
          <b>(unattributed)</b> means Shopify recorded <b>no customer journey</b> for the order that acquired
          that customer — not &ldquo;a journey we couldn&apos;t classify&rdquo;. Organic traffic Shopify{" "}
          <i>did</i> see <b>is</b> attributed (its referrer resolves to a source), so it never lands here.
          Counting this bucket as organic — or as direct — would invent revenue for a channel that may not
          have earned it.
        </Text>
        <List>
          <List.Item>
            <b>{b.subscriptionOrders.toLocaleString()} are subscription renewals</b> ({pctSub}% of the bucket,{" "}
            {fmtMoney(b.subscriptionRevenue)}) — their <b>acquiring</b> order carried no journey either.
            Typically subscribers migrated in from another platform, or won before journeys were captured.
          </List.Item>
          <List.Item>
            <b>{b.knownCustomerNoJourney.toLocaleString()}</b> are from known customers whose acquiring order
            we found but which had no journey; <b>{b.guestNoJourney.toLocaleString()}</b> had no customer at
            all (guest / POS / draft / imported).
          </List.Item>
          {typeof b.migratedOrders === "number" && (
            <List.Item>
              <b>{b.migratedOrders.toLocaleString()}</b> ({pctMigrated}%) were <b>imported by a migration tool</b>{" "}
              (e.g. Matrixify) — these were acquired on your previous platform and never had a Shopify journey,
              so they can never be attributed. The other <b>{lost.toLocaleString()}</b> were placed on the
              store. This is the split between &ldquo;back-catalogue&rdquo; and genuinely lost tracking.
            </List.Item>
          )}
          {b.oldest && b.newest && (
            <List.Item>
              Spanning <b>{b.oldest}</b> to <b>{b.newest}</b>.
            </List.Item>
          )}
        </List>
        <Text as="p" tone="subdued">
          To confirm: open one of these orders in Shopify and look at <b>Conversion summary</b>. If it says
          &ldquo;There aren&apos;t any conversion details available for this order&rdquo;, that is Shopify
          itself telling you it has no journey — so no tool, this one included, can attribute it.
        </Text>
        <InlineStack>
          <DownloadUnattributed />
        </InlineStack>
      </BlockStack>
    </Banner>
  );
}

// Downloads the (unattributed) orders CSV. Uses fetch + Blob rather than a plain <a href> because in the
// embedded iframe App Bridge patches window.fetch to attach the session token — a raw navigation would hit
// the authenticated resource route without it and bounce to the auth screen.
function DownloadUnattributed() {
  const [loading, setLoading] = useState(false);
  const onClick = async () => {
    setLoading(true);
    try {
      const res = await fetch("/app/attribution/unattributed.csv");
      if (!res.ok) throw new Error(`export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `unattributed-orders-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Non-fatal: the banner still shows the aggregate; the button just doesn't produce a file.
    } finally {
      setLoading(false);
    }
  };
  return (
    <Button onClick={onClick} loading={loading} variant="plain">
      Download these orders (CSV)
    </Button>
  );
}

function BackfillCard({ backfill }) {
  const fetcher = useFetcher();
  const running = backfill?.status === "running" || fetcher.state !== "idle";
  const done = backfill?.status === "done";
  const errored = backfill?.status === "error";

  return (
    <Card>
      <BlockStack gap="300">
        <SectionHeading
          title="Backfill from order history"
          description="Reads Shopify's own order attribution to learn which channel first acquired each customer, then replays that channel onto their renewals — so subscription revenue is credited to the channel that actually won the subscriber."
        />
        <Divider />
        {errored && <Banner tone="critical" title="Backfill failed">{backfill.detail || "Try again."}</Banner>}
        {running && (
          <Banner tone="info" title="Backfill running">
            <p>
              Processed {(backfill?.ordersProcessed || 0).toLocaleString()} orders so far. It pages through
              your history in the background, so it can take a few minutes — leave the page and come back.
            </p>
          </Banner>
        )}
        {done && (
          <Banner tone="success" title={`Backfill complete — ${(backfill.ordersProcessed || 0).toLocaleString()} orders`}>
            <p>Revenue by channel below now includes your order history, renewals attributed to the channel that acquired the customer.</p>
          </Banner>
        )}
        <UnattributedBreakdown backfill={backfill} />
        <InlineStack>
          <fetcher.Form method="post">
            <input type="hidden" name="_action" value="backfill" />
            <Button submit loading={running} disabled={running}>
              {done ? "Run backfill again" : "Run backfill"}
            </Button>
          </fetcher.Form>
        </InlineStack>
        {/* The two windows are the whole trick, and they're invisible from the button, so say them out loud:
            someone will otherwise read "3 years" and expect three years of revenue in the table below. */}
        <Text as="p" variant="bodySm" tone="subdued">
          Scans up to 3 years of orders to find each subscriber's acquiring order (the only one that ever
          carried a customer journey), but only rebuilds the revenue table for the last 90 days. Older orders
          teach us the channel; they don't add revenue to the report.
        </Text>
      </BlockStack>
    </Card>
  );
}

function MultiTouchCard({ multiTouch, paths }) {
  const [model, setModel] = useState("last_touch");
  const result = multiTouch?.[model];
  return (
    <Card>
      <BlockStack gap="300">
        <SectionHeading
          title="Multi-touch attribution"
          description="Distribute each conversion's value across the visitor's full journey, under the model you choose — not just the last click. Based on the touch paths of converting visitors (collected from when this shipped; earlier orders have no recorded path)."
        />
        <InlineStack gap="300" blockAlign="end" wrap>
          <div style={{ minWidth: 260 }}>
            <Select
              label="Attribution model"
              options={MODELS.map((m) => ({ label: MODEL_LABELS[m], value: m }))}
              value={model}
              onChange={setModel}
            />
          </div>
          <Text as="span" variant="bodySm" tone="subdued">{paths.toLocaleString()} conversion path{paths === 1 ? "" : "s"}</Text>
        </InlineStack>
        <Divider />
        <Table
          caption="Credited revenue and fractional conversions by channel under the selected multi-touch model"
          head={["Source / Medium", "Credited revenue", "Credited conversions", "Share"]}
          rows={(result?.rows || []).map((r) => (
            <tr key={`${r.source}/${r.medium}`} style={{ borderTop: "1px solid var(--p-color-border-subdued)" }}>
              <th scope="row" style={rowHead}><Text as="span" variant="bodyMd">{r.source} / {r.medium}</Text></th>
              <td style={th("right")}><Text as="span" variant="bodyMd">{fmtMoney(r.credit)}</Text></td>
              <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{r.conversions}</Text></td>
              <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{r.share}%</Text></td>
            </tr>
          ))}
        />
      </BlockStack>
    </Card>
  );
}

function AttributionBody({ totalVisitors, topSources, touches, shifted, subSources, capped, scanCap, channels, channelGroups = [], ltv = [], multiTouchModels = null, multiTouchPaths = 0, channelTotalRevenue, channelTotalOrders, channelSubscriptionRevenue, channelSubscriptionOrders, identity }) {
  const hasData = totalVisitors > 0 || channels.length > 0;

  return (
    <BlockStack gap="400">
        {!hasData ? (
          <Banner tone="info">
            No attribution data yet. This populates as visitors arrive with UTM-tagged links (utm_source /
            utm_medium / utm_campaign). It's captured automatically — no setup needed.
          </Banner>
        ) : (
          <>
            {capped && (
              <Banner tone="warning">
                This report reflects your most recent {scanCap.toLocaleString()} tracked visitors — older
                history isn't included in these totals.
              </Banner>
            )}
            <InlineStack gap="400" wrap>
              <Stat title="Attributed revenue" value={fmtMoney(channelTotalRevenue)} sub={`${channelTotalOrders.toLocaleString()} orders, last 90 days`} />
              <Stat
                title="Subscription revenue attributed"
                value={fmtMoney(channelSubscriptionRevenue)}
                sub={`${channelSubscriptionOrders.toLocaleString()} renewals — GA4 reports these as Unassigned`}
              />
              <Stat title="Tracked visitors" value={totalVisitors.toLocaleString()} sub="With a known first-touch source" />
              <Stat title="Identified" value={identity.identified.toLocaleString()} sub={`of ${identity.visitors.toLocaleString()} durable visitors stitched to a customer`} />
              <Stat title="Journeys shifted" value={shifted.toLocaleString()} sub="First source ≠ latest source" />
            </InlineStack>

            {channelGroups.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <SectionHeading
                    title="Revenue by channel group"
                    description="The same revenue rolled up into GA4-style default channel groups (Organic Search, Paid Social, Email, Direct, …). GA4 derives this from the session's source/medium, so it can never produce it for a subscription renewal (no session) — here it covers renewals too. Classification mirrors GA4's rules closely but is an approximation."
                  />
                  <Divider />
                  <Table
                    caption="Revenue grouped by GA4-style default channel group, with orders, subscription and one-off revenue, AOV and share"
                    head={["Channel group", "Orders", "Revenue", "Subscription", "One-off", "AOV", "Share"]}
                    rows={channelGroups.map((r) => (
                      <tr key={r.group} style={{ borderTop: "1px solid var(--p-color-border-subdued)" }}>
                        <th scope="row" style={rowHead}><Text as="span" variant="bodyMd">{r.group}</Text></th>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{r.orders.toLocaleString()}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd">{fmtMoney(r.revenue)}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone={r.subscriptionRevenue > 0 ? undefined : "subdued"}>{fmtMoney(r.subscriptionRevenue)}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{fmtMoney(r.oneOffRevenue)}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{fmtMoney(r.aov)}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{r.share}%</Text></td>
                      </tr>
                    ))}
                  />
                </BlockStack>
              </Card>
            )}

            {ltv.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <SectionHeading
                    title="Lifetime value by acquiring channel"
                    description="Each customer's TOTAL lifetime revenue (all their orders, from the backfill's full-history scan) grouped by the channel that first acquired them — the metric that tells you where to spend acquisition budget, not just which channel drove one order. Repeat = customers with more than one order; Active = ordered in the last 60 days. Reflects the last backfill."
                  />
                  <Divider />
                  <Table
                    caption="Customers, average lifetime value, average orders, repeat rate and active rate by acquiring channel"
                    head={["Source / Medium", "Customers", "Avg LTV", "Total LTV", "Avg orders", "Repeat", "Active"]}
                    rows={ltv.map((r) => (
                      <tr key={`${r.source}/${r.medium}`} style={{ borderTop: "1px solid var(--p-color-border-subdued)" }}>
                        <th scope="row" style={rowHead}><Text as="span" variant="bodyMd">{r.source} / {r.medium}</Text></th>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{r.customers.toLocaleString()}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd">{fmtMoney(r.ltv)}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{fmtMoney(r.revenue)}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{r.avgOrders}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{r.repeatRate}%</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{r.activeRate}%</Text></td>
                      </tr>
                    ))}
                  />
                </BlockStack>
              </Card>
            )}

            {channels.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <SectionHeading
                    title="Revenue by channel"
                    description="Every paid order's revenue attributed to the source/medium that first acquired the customer (first-touch), over the last 90 days — from the orders/paid webhook, so it includes recurring subscription renewals."
                  />
                  {channelSubscriptionRevenue > 0 && (
                    <Banner tone="info" title={`${fmtMoney(channelSubscriptionRevenue)} of subscription revenue is attributed here — GA4 cannot attribute it`}>
                      <p>
                        A recurring renewal has no browser session, so GA4 has no session to take a channel
                        from and reports it as <b>Unassigned</b> forever. This report replays the channel that
                        originally <b>acquired the subscriber</b> onto each renewal, so you can see which
                        channels actually drive your subscription revenue.
                      </p>
                    </Banner>
                  )}
                  <Divider />
                  <Table
                    caption="Channels grouped by first-touch source and medium, with orders, revenue split into subscription and one-off, AOV and revenue share"
                    head={["Source / Medium", "Orders", "Revenue", "Subscription", "One-off", "AOV", "Share"]}
                    rows={channels.map((r) => (
                      <tr key={`${r.source}/${r.medium}`} style={{ borderTop: "1px solid var(--p-color-border-subdued)" }}>
                        <th scope="row" style={rowHead}><Text as="span" variant="bodyMd">{r.source} / {r.medium}</Text></th>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{r.orders.toLocaleString()}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd">{fmtMoney(r.revenue)}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone={r.subscriptionRevenue > 0 ? undefined : "subdued"}>{fmtMoney(r.subscriptionRevenue)}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{fmtMoney(r.oneOffRevenue)}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{fmtMoney(r.aov)}</Text></td>
                        <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{r.share}%</Text></td>
                      </tr>
                    ))}
                  />
                </BlockStack>
              </Card>
            )}

            {multiTouchModels && <MultiTouchCard multiTouch={multiTouchModels} paths={multiTouchPaths} />}

            <Card>
              <BlockStack gap="300">
                <SectionHeading title="Top first-touch sources" description="Visitors grouped by the source/medium that first brought them (never overwritten by later visits)." />
                <Divider />
                <Table
                  caption="Visitors grouped by first-touch source and medium, with visitor and touch counts"
                  head={["Source / Medium", "Visitors", "Touches"]}
                  rows={topSources.map((r) => (
                    <tr key={`${r.source}/${r.medium}`} style={{ borderTop: "1px solid var(--p-color-border-subdued)" }}>
                      <th scope="row" style={rowHead}><Text as="span" variant="bodyMd">{r.source} / {r.medium}</Text></th>
                      <td style={th("right")}><Text as="span" variant="bodyMd">{r.visitors.toLocaleString()}</Text></td>
                      <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{r.touches.toLocaleString()}</Text></td>
                    </tr>
                  ))}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <SectionHeading title="Touch-count distribution" description="How many UTM-tagged visits it takes before a visitor converts or drops off." />
                <Divider />
                <InlineStack gap="400" wrap>
                  {Object.entries(touches).map(([bucket, n]) => (
                    <div key={bucket} style={{ flex: "1 1 120px" }}>
                      <BlockStack gap="100">
                        <Text as="span" variant="headingLg">{n.toLocaleString()}</Text>
                        <Badge>{bucket === "1" ? "1 touch" : `${bucket} touches`}</Badge>
                      </BlockStack>
                    </div>
                  ))}
                </InlineStack>
              </BlockStack>
            </Card>

            {subSources.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <SectionHeading title="Subscription first-order sources" description="The source that won each subscription customer's first order — inherited by every recurring order (so renewals aren't mis-credited to direct)." />
                  <Divider />
                  <Table
                    caption="Subscription customers grouped by the first-order source and medium that won them"
                    head={["Source / Medium", "Customers"]}
                    rows={subSources.map((r) => (
                      <tr key={`${r.source}/${r.medium}`} style={{ borderTop: "1px solid var(--p-color-border-subdued)" }}>
                        <th scope="row" style={rowHead}><Text as="span" variant="bodyMd">{r.source} / {r.medium}</Text></th>
                        <td style={th("right")}><Text as="span" variant="bodyMd">{r.customers.toLocaleString()}</Text></td>
                      </tr>
                    ))}
                  />
                </BlockStack>
              </Card>
            )}
          </>
        )}
      </BlockStack>
  );
}
