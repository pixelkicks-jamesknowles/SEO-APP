import prisma from "../db.server";

// Append an entry to the audit trail. Best-effort: logging must never break the action.
export async function logActivity(shopDomain, action, detail = null) {
  try {
    await prisma.activityLog.create({ data: { shopDomain, action, detail } });
  } catch {
    // swallow — the surrounding action's result is what matters
  }
}
