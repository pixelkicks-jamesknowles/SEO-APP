// Persist + read the background-worker heartbeat. One `_global` row: the worker's liveness is shop-agnostic
// (a stopped cron affects every shop), so a single row is enough and the per-shop dashboard reads it. The
// pure staleness math lives in heartbeat.js. Best-effort: recording a heartbeat must never fail a tick.
import prisma from "../db.server";

const SCOPE = "_global";

/** Stamp a completed (or errored) tick. `jobs` = per-sub-job summary; `errors` = array of {job, message}. */
export async function recordTick({ durationMs = 0, jobs = {}, errors = null } = {}) {
  const now = new Date();
  const data = {
    lastTickAt: now,
    durationMs: Math.max(0, Math.round(durationMs)),
    jobs: JSON.stringify(jobs || {}),
    errors: errors && errors.length ? JSON.stringify(errors) : null,
  };
  await prisma.cronHeartbeat
    .upsert({ where: { scope: SCOPE }, create: { scope: SCOPE, ...data }, update: data })
    .catch(() => {});
}

/** The worker heartbeat, or null if it has never run. */
export async function getHeartbeat() {
  return prisma.cronHeartbeat.findUnique({ where: { scope: SCOPE } }).catch(() => null);
}
