import { describe, expect, it, vi } from "vitest";
import { createSpObservationClient } from "./observation.js";

const chat = { ownerUserId: "11111111-1111-4111-8111-111111111111", chatId: "22222222-2222-4222-8222-222222222222" };

function client(fetch: typeof globalThis.fetch) {
  return createSpObservationClient({
    agentOrigin: "https://agent.test", apiOrigin: "https://api.test", trustedOrigin: "https://web.test", sessionToken: "service", fetch,
  });
}

describe("Eval SP observation client", () => {
  it("reads messages and the Workspace tree from the Agent Worker with the service session", async () => {
    const fetch = vi.fn(async () => Response.json([]));
    await client(fetch).messages(chat);
    await client(fetch).tree(chat);
    const [messages, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(messages.href).toBe(`https://agent.test/agents/inbox/${chat.ownerUserId}/chat-sockets/${chat.chatId}/get-messages?view=hydration`);
    expect(init.headers).toEqual({ Authorization: "Bearer service", Origin: "https://web.test" });
    expect((fetch.mock.calls[1] as unknown as [URL])[0].pathname).toMatch(/\/workspace\/tree$/u);
  });

  it("unwraps the SP API trajectory envelope and passes paging", async () => {
    const fetch = vi.fn(async () => Response.json({ success: true, msg: { events: [], beforeSeq: null, hasOlder: false } }));
    expect(await client(fetch).trajectory(chat, { limit: 50, beforeSeq: 3 })).toEqual({ events: [], beforeSeq: null, hasOlder: false });
    expect((fetch.mock.calls[0] as unknown as [URL])[0].href).toBe(`https://api.test/api/chats/${chat.chatId}/trajectory?limit=50&beforeSeq=3`);
  });

  it("maps SP failures and refuses oversized files", async () => {
    await expect(client(vi.fn(async () => new Response("", { status: 404 }))).tree(chat)).rejects.toMatchObject({ code: "EVAL_SP_NOT_FOUND" });
    await expect(client(vi.fn(async () => new Response("", { status: 503 }))).tree(chat)).rejects.toMatchObject({ code: "EVAL_SP_UNAVAILABLE" });
    await expect(client(vi.fn(async () => { throw new Error("down"); })).tree(chat)).rejects.toMatchObject({ code: "EVAL_SP_UNAVAILABLE" });
    const big = vi.fn(async () => new Response("x", { headers: { "content-length": "20000000" } }));
    await expect(client(big).file(chat, "/big.bin")).rejects.toMatchObject({ code: "CATALOG_PAYLOAD_TOO_LARGE" });
    const small = vi.fn(async () => new Response("hello", { headers: { "content-type": "text/plain" } }));
    const file = await client(small).file(chat, "/a b.txt");
    expect(file.contentType).toBe("text/plain");
    expect((small.mock.calls[0] as unknown as [URL])[0].searchParams.get("path")).toBe("/a b.txt");
  });
});
