import { Card, BlockStack, Text, ProgressBar } from "@shopify/polaris";

/**
 * A dashboard stat tile: label, big number, optional progress bar and caption.
 *
 * Shared by the Accuracy and Attribution pages, which each had their own near-identical copy. They had
 * drifted: one applied `tone` to the caption and the other only to the progress bar, so a tile with a
 * tone but no progress bar (e.g. "Orders opted out of tracking") silently rendered its warning in plain
 * subdued grey. Here `tone` colours both.
 */
// Polaris's Text and ProgressBar accept DIFFERENT tone vocabularies and silently ignore a value they
// don't recognise — there is no warning, the element just renders untoned. `warning` in particular is
// valid for neither (Text calls that level "caution"; ProgressBar has no equivalent and takes
// "highlight"), which is how a warning caption ended up rendering as ordinary grey helper text. Callers
// pass ONE semantic tone and this maps it onto what each component actually understands.
const TEXT_TONE = { critical: "critical", warning: "caution", success: "success" };
const BAR_TONE = { critical: "critical", warning: "highlight", success: "success" };

export function Stat({ title, value, sub, progress, tone, basis = "200px" }) {
  return (
    <div style={{ flex: `1 1 ${basis}` }}>
      <Card>
        <BlockStack gap="200">
          <Text as="span" variant="bodySm" tone="subdued">
            {title}
          </Text>
          <Text as="span" variant="heading2xl">
            {value}
          </Text>
          {/* Clamped both ends: a rate computed from live counters can briefly exceed 100 or go negative,
              and Polaris renders an out-of-range bar as a visual glitch rather than failing loudly. */}
          {progress != null && <ProgressBar progress={Math.min(100, Math.max(0, progress))} tone={BAR_TONE[tone]} size="small" />}
          {sub && (
            <Text as="span" variant="bodySm" tone={TEXT_TONE[tone] || "subdued"}>
              {sub}
            </Text>
          )}
        </BlockStack>
      </Card>
    </div>
  );
}
