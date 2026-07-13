import { isUsefulClaudeSessionTitle, provisionalClaudeTitle } from "../src/bot.js";

describe("Claude session titles", () => {
  it("does not let model commands or picker replies become session topics", () => {
    expect(provisionalClaudeTitle("/model fable")).toBe("");
    expect(provisionalClaudeTitle("1")).toBe("");
    expect(provisionalClaudeTitle("okay")).toBe("");
  });

  it("uses the first meaningful request as the topic", () => {
    expect(provisionalClaudeTitle("Build and package the YouTube clipper for Windows and Mac"))
      .toBe("Build and package the YouTube clipper for Windows and Mac");
  });

  it("rejects transcript plumbing even after XML tags are removed", () => {
    const raw = "<task-notification><summary>background job finished</summary></task-notification>";
    expect(isUsefulClaudeSessionTitle("background job finished", raw)).toBe(false);
  });
});
