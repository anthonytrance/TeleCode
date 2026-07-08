import { cleanUsagePanel } from "../src/providers/claude-adapter.js";

describe("cleanUsagePanel", () => {
  it("drops old conversation text before the latest usage panel", () => {
    const cleaned = cleanUsagePanel([
      "Claude previous answer that should not be copied",
      "It even mentions usage in normal prose, but it is not the panel.",
      "",
      "Usage",
      "Current plan: Pro",
      "5-hour limit resets at 04:00",
      "Weekly limit: 42%",
      "? for shortcuts",
    ].join("\n"));

    expect(cleaned).toBe([
      "Current plan: Pro",
      "5-hour limit resets at 04:00",
      "Weekly limit: 42%",
    ].join("\n"));
  });
});
