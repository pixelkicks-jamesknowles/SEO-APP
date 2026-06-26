import { BlockStack, InlineStack, Text, Tooltip, Icon } from "@shopify/polaris";
import { InfoIcon } from "@shopify/polaris-icons";

// A card section title with an optional always-visible description line and an optional
// hover-for-help info icon (for secondary detail).
export function SectionHeading({ title, help, description }) {
  return (
    <BlockStack gap="100">
      <InlineStack gap="100" blockAlign="center" wrap={false}>
        <Text as="h2" variant="headingMd">
          {title}
        </Text>
        {help ? (
          <Tooltip content={help} preferredPosition="above">
            <span style={{ display: "inline-flex", width: 18, height: 18, cursor: "help" }}>
              <Icon source={InfoIcon} tone="subdued" accessibilityLabel={`About ${title}`} />
            </span>
          </Tooltip>
        ) : null}
      </InlineStack>
      {description ? (
        <Text as="p" tone="subdued" variant="bodySm">
          {description}
        </Text>
      ) : null}
    </BlockStack>
  );
}
