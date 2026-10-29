import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { nativeAssistantMessage, nativeTransfer, nativeTransferResponse } from "./native-test-fixture.js";
import { createSpObservationClient } from "./observation.js";

const chat = { ownerUserId: "11111111-1111-4111-8111-111111111111", chatId: "22222222-2222-4222-8222-222222222222" };

function client(fetch: typeof globalThis.fetch) {
  return createSpObservationClient({
    agentOrigin: "https://agent.test", apiOrigin: "https://api.test", trustedOrigin: "https://web.test", sessionToken: "service", fetch,
  });
}

const source = nativeAssistantMessage(5, chat.chatId, "submission-1", [
  { type: "text", text: "汉".repeat(2_500) },
]);
const { reference, bytes } = nativeTransfer(source, 5);
const spools = async () => (await readdir(tmpdir())).filter((item) => item.startsWith("eval-trajectory-")).sort();

describe("Eval SP observation client", () => {
  it("reads messages and the Workspace tree from the Agent Worker with the service session", async () => {
    const fetch = vi.fn(async () => Response.json([]));
    await client(fetch).messages(chat);
    await client(fetch).tree(chat);
    const [raw, init] = fetch.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const request = new Request(raw, init);
    const messages = new URL(request.url);
    expect(messages.href).toBe(`https://agent.test/agents/inbox/${chat.ownerUserId}/chat-sockets/${chat.chatId}/get-messages?view=hydration`);
    expect(request.headers.get("Authorization")).toBe("Bearer service");
    expect(request.headers.get("Origin")).toBe("https://web.test");
    expect(new URL((fetch.mock.calls[1] as unknown as [Request])[0].url).pathname).toMatch(/\/workspace\/tree$/u);
  });

  it("unwraps the SP native page and sends afterSeq/throughSeq (never the obsolete beforeSeq)", async () => {
    const page = { format: "sp-pi-trajectory/v1", cursor: { throughSeq: 7 }, records: [], nextAfterSeq: null };
    const fetch = vi.fn(async () => Response.json({ success: true, msg: page }));
    expect(await client(fetch).trajectory(chat, { afterSeq: 3, limit: 50, throughSeq: 7 })).toEqual(page);
    expect((fetch.mock.calls[0] as unknown as [Request])[0].url)
      .toBe(`https://api.test/api/chats/${chat.chatId}/trajectory?afterSeq=3&limit=50&throughSeq=7`);
    await client(fetch).trajectory(chat, {});
    expect((fetch.mock.calls[1] as unknown as [Request])[0].url)
      .toBe(`https://api.test/api/chats/${chat.chatId}/trajectory?afterSeq=0&limit=100`);
    await expect(client(fetch).trajectory(chat, { afterSeq: 8, throughSeq: 7 })).rejects.toMatchObject({
      code: "REQUEST_INVALID_INPUT",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("maps SP failures and refuses oversized Workspace files", async () => {
    await expect(client(vi.fn(async () => new Response("", { status: 404 }))).tree(chat))
      .rejects.toMatchObject({ name: "EvalSpApiError", status: 404 });
    await expect(client(vi.fn(async () => new Response("", { status: 503 }))).tree(chat))
      .rejects.toMatchObject({ name: "EvalSpApiError", status: 503 });
    await expect(client(vi.fn(async () => { throw new Error("down"); })).tree(chat))
      .rejects.toMatchObject({ name: "EvalSpTransportError" });
    const big = vi.fn(async () => new Response("x", { headers: { "content-length": "20000000" } }));
    await expect(client(big).file(chat, "/big.bin")).rejects.toMatchObject({ code: "CATALOG_PAYLOAD_TOO_LARGE" });
    const small = vi.fn(async () => new Response("hello", { headers: { "content-type": "text/plain" } }));
    const file = await client(small).file(chat, "/a b.txt");
    expect(file.contentType).toBe("text/plain");
    expect(new URL((small.mock.calls[0] as unknown as [Request])[0].url).searchParams.get("path")).toBe("/a b.txt");
  });

  it.each([undefined, "1"])("counts actual Workspace bytes when Content-Length is %s", async (length) => {
    const fetch = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(10_000_001)); controller.close();
    } }), { headers: length === undefined ? {} : { "content-length": length } }));
    await expect(client(fetch).file(chat, "/large.bin")).rejects.toMatchObject({ code: "CATALOG_PAYLOAD_TOO_LARGE" });
  });

  it("downloads one whole owner-session reference before releasing any bytes, then disposes its private spool", async () => {
    const before = await spools();
    const fetch = vi.fn(async () => nativeTransferResponse(reference, bytes));
    const record = await client(fetch).trajectoryRecord(chat, reference);
    expect(record.byteLength).toBe(bytes.byteLength);
    expect(record.sha256).toBe(reference.reference.sha256);
    expect(await spools()).toHaveLength(before.length + 1);
    const parts: Uint8Array[] = [];
    for await (const part of record.bytes()) {
      expect(part.byteLength).toBeLessThanOrEqual(64 * 1024);
      parts.push(part);
    }
    expect(Buffer.concat(parts)).toEqual(Buffer.from(bytes));
    await record.dispose();
    expect(await spools()).toEqual(before);
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = new Request((fetch.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit])[0],
      (fetch.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit])[1]);
    const url = new URL(request.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://api.test/api/chats/${chat.chatId}/trajectory/records/5`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      throughSeq: "5", identity: reference.reference.identity,
      byteLength: String(bytes.byteLength), sha256: reference.reference.sha256,
    });
    expect(url.searchParams.has("submissionId")).toBe(false);
    expect(request.headers.get("authorization")).toBe("Bearer service");
    expect(request.headers.get("origin")).toBe("https://web.test");
    expect(request.redirect).toBe("error");
  });

  it("rejects foreign identities, corrupt headers/digest/truncated bytes and foreign parent before returning a spool", async () => {
    const before = await spools();
    const foreign = { ...reference, reference: { ...reference.reference,
      identity: JSON.stringify(["agent-1", "foreign-chat", "entry", 5]) } };
    const never = vi.fn(async () => nativeTransferResponse(reference, bytes));
    await expect(client(never).trajectoryRecord(chat, foreign)).rejects.toMatchObject({ code: "REQUEST_INVALID_INPUT" });
    expect(never).not.toHaveBeenCalled();
    const invalids = [
      nativeTransferResponse(reference, bytes, { "Content-Type": "text/html" }),
      nativeTransferResponse(reference, bytes, { "Content-Length": "1" }),
      nativeTransferResponse(reference, bytes, { "X-Eval-Trajectory-Through-Seq": "6" }),
      nativeTransferResponse(reference, Buffer.from(Buffer.from(bytes).toString("utf8").replace("汉", "字"))),
      nativeTransferResponse(reference, bytes.subarray(0, -1)),
    ];
    for (const response of invalids) {
      await expect(client(vi.fn(async () => response)).trajectoryRecord(chat, reference))
        .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
      expect(await spools()).toEqual(before);
    }
    const badParent = { ...source.record, parent: {
      resource: { agentId: source.record.resource.agentId, sessionId: "foreign-chat" }, submissionId: "submission-1",
    } };
    const parentBytes = Buffer.from(JSON.stringify(badParent));
    const parent = { ...reference, reference: { ...reference.reference,
      byteLength: parentBytes.byteLength, sha256: createHash("sha256").update(parentBytes).digest("hex") } };
    await expect(client(vi.fn(async () => nativeTransferResponse(parent, parentBytes))).trajectoryRecord(chat, parent))
      .rejects.toMatchObject({ code: "RESPONSE_INVALID" });
    expect(await spools()).toEqual(before);
    await expect(client(vi.fn(async () => new Response(null, { status: 403 }))).trajectoryRecord(chat, reference))
      .rejects.toMatchObject({ name: "EvalSpApiError", status: 403 });
  });

  it("aborts an incomplete reference before verification, never returning bytes or leaving a spool", async () => {
    const before = await spools();
    const cancellation = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.subarray(0, 128)); },
      cancel: cancellation,
    });
    const fetch = vi.fn(async () => new Response(body, { headers: nativeTransferResponse(reference, bytes).headers }));
    const abort = new AbortController();
    const reading = client(fetch).trajectoryRecord(chat, reference, abort.signal);
    // A real fetch also aborts the body; the client cancels its own reader even when a test fetch does not.
    await Promise.resolve();
    abort.abort();
    await expect(reading).rejects.toThrow();
    expect(cancellation).toHaveBeenCalledTimes(1);
    expect(await spools()).toEqual(before);
  });
});
