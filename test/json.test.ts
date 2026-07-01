import { parseJsonFileText } from "../src/json.js";

describe("parseJsonFileText", () => {
  it("parses JSON with a leading UTF-8 BOM", () => {
    expect(parseJsonFileText<{ ok: boolean }>("\uFEFF{\"ok\":true}")).toEqual({ ok: true });
  });
});
