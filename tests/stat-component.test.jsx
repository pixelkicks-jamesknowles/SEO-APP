/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import { Stat } from "../app/components/Stat.jsx";

// Polaris components need its provider; an empty i18n is enough for the strings we use.
const renderStat = (props) => render(<AppProvider i18n={{}}><Stat {...props} /></AppProvider>);

describe("Stat", () => {
  test("renders the label, value and caption", () => {
    renderStat({ title: "Consent rate (30d)", value: "72%", sub: "1,200 of 1,667 events had analytics consent" });
    expect(screen.getByText("Consent rate (30d)")).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
    expect(screen.getByText(/1,200 of 1,667 events/)).toBeInTheDocument();
  });

  test("the caption is optional", () => {
    const { container } = renderStat({ title: "Retry queue", value: "0" });
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(container.querySelectorAll("span").length).toBeGreaterThan(0);
  });

  test("no progress bar unless a progress value is given", () => {
    const { container } = renderStat({ title: "Events sent", value: "10,070" });
    expect(container.querySelector("progress")).toBeNull();
  });

  test("renders a progress bar when given one", () => {
    const { container } = renderStat({ title: "Delivery success", value: "100%", progress: 100 });
    expect(container.querySelector("progress")).toHaveAttribute("value", "100");
  });

  test("an out-of-range progress value is clamped, not rendered raw", () => {
    // Rates computed from live counters can briefly exceed 100 or go negative, and Polaris renders an
    // out-of-range bar as a visual glitch rather than failing loudly.
    const high = renderStat({ title: "x", value: "y", progress: 150 });
    expect(high.container.querySelector("progress")).toHaveAttribute("value", "100");
    high.unmount();
    const low = renderStat({ title: "x", value: "y", progress: -20 });
    expect(low.container.querySelector("progress")).toHaveAttribute("value", "0");
  });

  test("a semantic tone maps onto the ProgressBar's own vocabulary", () => {
    // ProgressBar has no "warning"; the nearest it understands is "highlight".
    const { container } = renderStat({ title: "x", value: "y", progress: 50, tone: "warning" });
    expect(container.querySelector(".Polaris-ProgressBar").className).toEqual(expect.stringContaining("toneHighlight"));
  });

  test("tone colours the CAPTION, not just the progress bar", () => {
    // The regression this component was extracted to fix: the Accuracy page's copy applied tone only to
    // the progress bar, so a tile with a warning but no bar (e.g. "Orders opted out of tracking")
    // rendered its warning in ordinary subdued grey and read as neutral helper text.
    const { container } = renderStat({ title: "Orders opted out of tracking (30d)", value: "0", sub: "No consent signal captured", tone: "warning" });
    expect(container.querySelector("progress")).toBeNull();
    // "warning" is not a tone Polaris Text understands — it calls that level "caution" — and an
    // unrecognised value renders untoned with no error. Stat maps the semantic tone to the real one.
    const caption = screen.getByText("No consent signal captured");
    expect(caption.className).toEqual(expect.stringContaining("caution"));
  });

  test("without a tone the caption stays subdued", () => {
    renderStat({ title: "x", value: "y", sub: "ordinary helper text" });
    expect(screen.getByText("ordinary helper text").className).toEqual(expect.stringContaining("subdued"));
  });
});
