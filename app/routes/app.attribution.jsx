import { Suspense } from "react";
import { useLoaderData, useRevalidator, useFetcher, Await } from "@remix-run/react";
import { defer } from "@remix-run/node";
import { Page, Card, BlockStack, InlineStack, Text, Banner, Divider, Badge, Button, SkeletonBodyText, SkeletonDisplayText } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { SectionHeading } from "../components/SectionHeading";
import { byFirstTouch, touchDistribution, multiTouchShare, firstVsLastShift, bySubscriptionSource, byChannelRevenue } from "../lib/attribution-report";
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
  const [visitors, customers, channelRows, identity] = await Promise.all([
    prisma.visitorAttribution.findMany({ where: { shopDomain }, orderBy: { lastSeen: "desc" }, take: SCAN_CAP }),
    prisma.customerAttribution.findMany({ where: { shopDomain }, orderBy: { updatedAt: "desc" }, take: SCAN_CAP }),
    prisma.channelRevenueDaily.findMany({ where: { shopDomain, date: { gte: since90 } } }).catch(() => []),
    identityStats(shopDomain),
  ]);
  const revenue = byChannelRevenue(channelRows);
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
          description="Rebuilds revenue-by-channel from Shopify's own order attribution, and replays each customer's first-touch channel onto their renewals — so subscription revenue is credited to the channel that actually won the subscriber."
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
        <Text as="p" variant="bodySm" tone="subdued">
          <b>About <span>(unattributed)</span>:</b> a customer can only be credited to a channel if Shopify
          captured a journey (UTMs / referrer) on the order that <b>acquired</b> them. Where it didn&apos;t —
          an offline or imported order, or a subscriber won before any of this was tracked — we show{" "}
          <b>(unattributed)</b> rather than folding them into <b>(direct)</b>, which would flatter direct and
          mislead you. It&apos;s an honest &ldquo;we don&apos;t know&rdquo;, not a bug.
        </Text>
        <InlineStack>
          <fetcher.Form method="post">
            <input type="hidden" name="_action" value="backfill" />
            <Button submit loading={running} disabled={running}>
              {done ? "Run backfill again" : "Backfill last 90 days"}
            </Button>
          </fetcher.Form>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function AttributionBody({ totalVisitors, topSources, touches, shifted, subSources, capped, scanCap, channels, channelTotalRevenue, channelTotalOrders, channelSubscriptionRevenue, channelSubscriptionOrders, identity }) {
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
