import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fanOutServerSide, isBot } from "../lib/server-side.server";
import { recordDeliveries } from "../lib/delivery.server";

// App Proxy entrypoint - Shopify signs and forwards /apps/<subpath>/track here.
//   track -> bot-filter, record the event, fan out server-side to GA4 / Meta CAPI / sGTM, log outcomes.
export const action = async ({ request, params }) => {
  const { session } = await authenticate.public.appProxy(request);
  const shopDomain = session?.shop;
  if (!shopDomain) return new Response("Unauthorized", { status: 401 });
  if (params.type !== "track") return new Response("Not found", { status: 404 });

  const body = await request.json().catch(() => null);
  if (!body?.event) return new Response(null, { status: 204 });

  const settings = await prisma.trackingSettings.findUnique({ where: { shopDomain } });

  // Bot filtering: drop known bots/headless agents before anything is recorded or delivered.
  const ua = body.event.userAgent || request.headers.get("user-agent") || "";
  if (settings?.botFiltering !== false && isBot(ua)) {
    return new Response(null, { status: 204 });
  }

  // Buffer the raw event for the Live events inspector (cap 50 most recent per shop).
  await prisma.recentEvent.create({
    data: {
      shopDomain,
      name: body.event?.name ?? "event",
      platform: body.platform ?? null,
      payload: JSON.stringify(body).slice(0, 4000),
    },
  });
  const stale = await prisma.recentEvent.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "desc" },
    skip: 50,
    select: { id: true },
  });
  if (stale.length) {
    await prisma.recentEvent.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }

  // Server-side fan-out + delivery health logging.
  const clientIp = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || undefined;
  const results = await fanOutServerSide(settings, { ...body.event, clientIp: body.event.clientIp || clientIp });
  await recordDeliveries(shopDomain, results);

  return new Response(null, { status: 204 });
};
