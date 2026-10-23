import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const projectId = "project /中文?#%";

describe("Project evaluation results download SDK", () => {
  beforeEach(async () => {
    vi.resetModules();
    (await import("@/auth/session")).resetAuthForTest({ status: "ready", token: "eval-download-token" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    (await import("@/auth/session")).resetAuthForTest();
    vi.resetModules();
  });

  it.each([true, false])("encodes the Project identity and forwards the long download timeout with a signal: %s", async (withSignal) => {
    const { api } = await import("./client");
    const { downloadProjectEvaluationResults } = await import("./projects-api");
    const zip = new Blob(["PK\u0003\u0004"], { type: "application/zip" });
    const signal = withSignal ? new AbortController().signal : undefined;
    const download = vi.spyOn(api, "blob").mockResolvedValue(zip);

    await expect(downloadProjectEvaluationResults(projectId, signal)).resolves.toBe(zip);
    expect(download).toHaveBeenCalledExactlyOnceWith(
      `/api/projects/${encodeURIComponent(projectId)}/evaluation-results.zip`,
      { signal, timeoutMs: 600_000 },
    );
  });

  it("reads the ZIP bytes through the existing authenticated client, outside the JSON envelope", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.method).toBe("GET");
      expect(request.headers.get("Authorization")).toBe("Bearer eval-download-token");
      expect(request.url).toBe(`${window.location.origin}/api/projects/${encodeURIComponent(projectId)}/evaluation-results.zip`);
      return new Response(bytes, {
        headers: { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=results.zip" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const { downloadProjectEvaluationResults } = await import("./projects-api");

    const zip = await downloadProjectEvaluationResults(projectId);
    expect(zip.type).toBe("application/zip");
    const content = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(zip);
    });
    expect(new Uint8Array(content)).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects an HTTP error instead of returning its JSON body as a ZIP", async () => {
    const fetcher = vi.fn(async () => Response.json(
      { success: false, code: "DATABASE_UNAVAILABLE", errMsg: "private database detail" },
      { status: 503 },
    ));
    vi.stubGlobal("fetch", fetcher);
    const { downloadProjectEvaluationResults } = await import("./projects-api");

    await expect(downloadProjectEvaluationResults(projectId)).rejects.toMatchObject({
      status: 503, code: "DATABASE_UNAVAILABLE",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await import("@/auth/session")).getAuthState().status).toBe("ready");
  });
});
