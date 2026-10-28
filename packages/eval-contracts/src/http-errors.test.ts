import { requiredErrorCodes } from "@springbrand/http/catalog";
import { describe, expect, it } from "vitest";
import { decodeError, errorCatalog, HttpError } from "./http-errors.js";

describe("Eval API error catalog", () => {
  it("defines every code the SpringBrand HTTP SDK can produce on the server", () => {
    expect(errorCatalog.codes).toEqual(expect.arrayContaining([...requiredErrorCodes]));
  });

  it("fixes status and default text per code", () => {
    const error = new HttpError("PROJECT_BUSY");
    expect({ status: error.status, message: error.message })
      .toEqual({ status: 409, message: "Project already has an unfinished Run" });
  });

  it.each([
    ["DASHBOARD_NOT_FOUND", 404, "Dashboard not found"],
    ["DASHBOARD_IDEMPOTENCY_CONFLICT", 409, "Idempotency key was used to create a different Dashboard"],
    ["DASHBOARD_REVISION_CONFLICT", 409, "Dashboard changed. Refresh and try again"],
  ] as const)("defines and decodes persisted Dashboard error %s", (code, status, message) => {
    const error = new HttpError(code);
    expect({ status: error.status, message: error.message }).toEqual({ status, message });
    expect(decodeError({ code, errMsg: message, requestId: "dashboard-request" }, { status, headers: {} }))
      .toMatchObject({ code, status, requestId: "dashboard-request" });
  });

  it("decodes Eval API failures and rejects foreign error bodies", () => {
    const known = decodeError({ code: "RUN_NOT_FOUND", errMsg: "Run not found", requestId: "r-1" }, { status: 404, headers: {} });
    expect(known).toMatchObject({ status: 404, code: "RUN_NOT_FOUND", requestId: "r-1" });
    const foreign = decodeError({ error: { code: "project_busy", message: "busy" } }, { status: 409, headers: {} });
    expect(foreign.code).toBe("RESPONSE_INVALID");
  });
});
