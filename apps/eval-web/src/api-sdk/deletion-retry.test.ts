import { ApiError } from "@springbrand/http/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteWithConfirmation } from "./delete-confirmation";

const lostResponse = () => new ApiError({ status: 0, kind: "network", code: "NETWORK_ERROR", message: "Write response lost" });

describe("shared deletion confirmation retry", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("queries at most ten times using capped exponential backoff and never repeats DELETE", async () => {
    const error = lostResponse();
    const remove = vi.fn().mockRejectedValue(error);
    const confirm = vi.fn().mockResolvedValue(false);
    const started = Date.now();
    const observed = deleteWithConfirmation(remove, confirm).then((value) => ({ value }), (error: unknown) => ({ error }));

    await vi.runAllTimersAsync();

    expect(await observed).toEqual({ error });
    expect(remove).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledTimes(10);
    expect(Date.now() - started).toBe(45_750);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops on the first confirmed absence and preserves the editor result", async () => {
    const remove = vi.fn().mockRejectedValue(lostResponse());
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const result = { id: "item" };
    const started = Date.now();
    const observed = deleteWithConfirmation(remove, confirm, result).then((value) => ({ value }), (error: unknown) => ({ error }));

    await vi.runAllTimersAsync();

    expect(await observed).toEqual({ value: result });
    expect(remove).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBe(750);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new ApiError({ status: 0, kind: "network", code: "NETWORK_ERROR", message: "Read connection lost" }),
    new ApiError({ status: 0, kind: "timeout", code: "REQUEST_TIMEOUT", message: "Read timed out" }),
    new ApiError({ status: 503, code: "EVAL_API_UNAVAILABLE", message: "Read unavailable" }),
    new ApiError({ status: 429, code: "REQUEST_RATE_LIMITED", message: "Read rate limited" }),
  ])("recovers from a transient confirmation failure (%j)", async (readError) => {
    const remove = vi.fn().mockRejectedValue(lostResponse());
    const confirm = vi.fn().mockRejectedValueOnce(readError).mockResolvedValueOnce(false).mockResolvedValue(true);
    const observed = deleteWithConfirmation(remove, confirm).then((value) => ({ value }), (error: unknown) => ({ error }));
    const started = Date.now();

    await vi.runAllTimersAsync();

    expect(await observed).toEqual({ value: undefined });
    expect(remove).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBe(750);
  });

  it("preserves the DELETE error after ten transient read failures", async () => {
    const error = lostResponse();
    const remove = vi.fn().mockRejectedValue(error);
    const confirm = vi.fn().mockRejectedValue(new ApiError({ status: 503, code: "EVAL_API_UNAVAILABLE", message: "Read unavailable" }));
    const observed = deleteWithConfirmation(remove, confirm).then((value) => ({ value }), (error: unknown) => ({ error }));

    await vi.runAllTimersAsync();

    expect(await observed).toEqual({ error });
    expect(remove).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledTimes(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new ApiError({ status: 401, code: "AUTH_UNAUTHENTICATED", message: "Session expired" }),
    new ApiError({ status: 403, code: "EVAL_ACCESS_DENIED", message: "Access denied" }),
    new ApiError({ status: 404, code: "REQUEST_NOT_FOUND", message: "Unrelated route" }),
    new ApiError({ status: 500, code: "INTERNAL_ERROR", message: "Permanent read failure" }),
    new ApiError({ status: 200, kind: "response", code: "RESPONSE_INVALID", message: "Invalid read response" }),
    new DOMException("Read cancelled", "AbortError"),
    new TypeError("Confirmation callback failed"),
  ])("stops after a permanent confirmation failure without masking the write error (%j)", async (readError) => {
    const error = lostResponse();
    const remove = vi.fn().mockRejectedValue(error);
    const confirm = vi.fn().mockRejectedValue(readError);
    const observed = deleteWithConfirmation(remove, confirm).then((value) => ({ value }), (error: unknown) => ({ error }));
    const started = Date.now();

    await vi.runAllTimersAsync();

    expect(await observed).toEqual({ error });
    expect(remove).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(Date.now() - started).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
