import { json } from "@remix-run/node";
import { unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { runAudit } from "../lib/audit.server";
import { logError } from "../lib/log.server";

// Scheduled re-audit. Hit by an external scheduler: GET /cron/audit?secret=<CRON_SECRET>.
// For each monitored shop: run the audit, store a score snapshot, and POST a Slack-compatible
// alert if the score regressed since the last run.
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  if (!process.env.CRON_SECRET || url.searchParams.get("secret") !== process.env.CRON_SECRET) {
    throw new Response("Forbidden", { status: 403 });
  }

  const shops = await prisma.seoSettings.findMany({ where: { monitoring: true } });
  const results = [];

  for (const s of shops) {
    try {
      const { admin } = await unauthenticated.admin(s.shopDomain);
      const audit = await runAudit(admin, { maxProducts: 100 });
      if (audit.error) {
        results.push({ shop: s.shopDomain, error: audit.error });
        continue;
      }
      const prev = await prisma.auditSnapshot.findFirst({
        where: { shopDomain: s.shopDomain },
        orderBy: { createdAt: "desc" },
      });
      await prisma.auditSnapshot.create({
        data: { shopDomain: s.shopDomain, score: audit.score, issues: JSON.stringify(audit.issues) },
      });

      // Regression alert: a meaningful score drop since the previous run.
      if (prev && s.alertWebhook && audit.score <= prev.score - 5) {
        await fetch(s.alertWebhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `⚠️ Pixelify SEO — ${s.shopDomain}: SEO score dropped ${prev.score} → ${audit.score}.`,
          }),
        }).catch((e) => logError(`cron alert ${s.shopDomain}`, e));
      }
      results.push({ shop: s.shopDomain, score: audit.score, prev: prev?.score ?? null });
    } catch (e) {
      logError(`cron audit ${s.shopDomain}`, e);
      results.push({ shop: s.shopDomain, error: e.message });
    }
  }

  return json({ ran: results.length, results });
};
