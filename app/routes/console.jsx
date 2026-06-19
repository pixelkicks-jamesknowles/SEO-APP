import { useLoaderData } from "@remix-run/react";
import prisma from "../db.server";

// Standalone (non-embedded) agency console. Gated by ?token=<AGENCY_CONSOLE_TOKEN>. Lists every
// installed store + whether SEO / tracking are configured. SCAFFOLD: cross-store audit scores and
// per-store drill-in are the next step.
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const token = process.env.AGENCY_CONSOLE_TOKEN;
  if (!token || url.searchParams.get("token") !== token) {
    throw new Response("Forbidden", { status: 403 });
  }
  const sessions = await prisma.session.findMany({ select: { shop: true }, distinct: ["shop"] });
  const shops = [];
  for (const { shop } of sessions) {
    const [seo, tracking] = await Promise.all([
      prisma.seoSettings.findUnique({ where: { shopDomain: shop } }),
      prisma.trackingSettings.findUnique({ where: { shopDomain: shop } }),
    ]);
    shops.push({
      shop,
      seo: Boolean(seo),
      tracking: Boolean(tracking && (tracking.gtmId || tracking.ga4Id || tracking.metaPixelId)),
    });
  }
  return { shops };
};

const th = { textAlign: "left", borderBottom: "2px solid #ddd", padding: 8 };
const td = { borderBottom: "1px solid #eee", padding: 8 };

export default function Console() {
  const { shops } = useLoaderData();
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 820, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>Pixelify SEO — Agency console</h1>
      <p>{shops.length} installed store(s)</p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={th}>Store</th>
            <th style={th}>SEO</th>
            <th style={th}>Tracking</th>
          </tr>
        </thead>
        <tbody>
          {shops.map((s) => (
            <tr key={s.shop}>
              <td style={td}>{s.shop}</td>
              <td style={td}>{s.seo ? "✓" : "—"}</td>
              <td style={td}>{s.tracking ? "✓" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
