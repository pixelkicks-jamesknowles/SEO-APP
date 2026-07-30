// Analytics-consent classification for an ingested event (pure — unit-tested). The app's convention is
// that UNKNOWN consent (no consent-management platform, or the state wasn't provided) is treated as
// GRANTED — the same way the GA4 delivery path flags it — so only an explicit analytics:false is "denied".
// Feeds the Accuracy "consent rate".
export function analyticsConsented(consent) {
  return !consent || consent.analytics !== false;
}
