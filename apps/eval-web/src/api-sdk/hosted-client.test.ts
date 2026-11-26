import { afterEach, describe, expect, it, vi } from "vitest";

const tokens = vi.hoisted(() => ({ issued: [] as boolean[] }));

vi.mock("@/lib/host", () => ({
  hosted: true,
  apiOrigin: "https://eval-api.test",
  hostAccessToken: async (refresh = false) => {
    tokens.issued.push(refresh);
    return refresh ? "fresh-token" : "stale-token";
  },
}));

describe("API client inside the main App", () => {
  afterEach(() => { vi.unstubAllGlobals(); tokens.issued = []; });

  it("keeps the JSON Content-Type and body, adds the IAM token, and resends both after a 401", async () => {
    const seen: { contentType: string | null; authorization: string | null; credentials: string; body: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({
        contentType: request.headers.get("content-type"),
        authorization: request.headers.get("authorization"),
        credentials: request.credentials,
        body: await request.text(),
      });
      if (seen.length === 1) return Response.json({ code: "AUTH_UNAUTHENTICATED", errMsg: "expired" }, { status: 401 });
      return Response.json({ success: true, msg: { datasetId: "dataset-1" } }, { status: 201 });
    }));
    const { importPromptDataset } = await import("./datasets-api");

    const input = { name: "Prompts", description: "", format: "jsonl" as const, content: "{\"prompt\":\"hi\"}\n" };
    await expect(importPromptDataset(input)).resolves.toEqual({ datasetId: "dataset-1" });

    expect(tokens.issued).toEqual([false, true]);
    expect(seen).toHaveLength(2);
    for (const [index, sent] of seen.entries()) {
      expect(sent.contentType).toMatch(/^application\/json/u);
      expect(JSON.parse(sent.body)).toEqual(input);
      expect(sent.credentials).toBe("omit");
      expect(sent.authorization).toBe(index === 0 ? "Bearer stale-token" : "Bearer fresh-token");
    }
  });
});
