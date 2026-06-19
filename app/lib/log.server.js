// Central error log. Single place to later forward to Sentry/observability (gated on a DSN env).
export function logError(context, error) {
  console.error(`[pixelify-seo] ${context}:`, error?.message ?? error);
}
