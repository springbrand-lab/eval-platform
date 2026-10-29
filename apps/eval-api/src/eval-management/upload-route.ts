import { HttpError } from "@eval-platform/eval-contracts/http-errors";
import { createRouter } from "../lib/create-app.js";
import { serviceAccountScope } from "../middlewares/service-account.js";
import { managementBearer } from "./mcp.js";
import { uploadMetadataSchema } from "./files.js";

export const MANAGEMENT_UPLOAD_PATH = "/mcp/eval-management/uploads";
const router = createRouter();

router.post(MANAGEMENT_UPLOAD_PATH, managementBearer, serviceAccountScope, async (c) => {
  if (c.req.header("content-type") !== "application/octet-stream"
    || !["", "identity"].includes(c.req.header("content-encoding") ?? "")) {
    throw new HttpError("REQUEST_UNSUPPORTED_MEDIA_TYPE", "Expected unencoded application/octet-stream bytes");
  }
  let name: string;
  try { name = decodeURIComponent(c.req.header("x-upload-name") ?? ""); }
  catch { throw new HttpError("REQUEST_INVALID_INPUT", "Invalid encoded filename"); }
  const size = c.req.header("x-upload-size") ?? "";
  const length = c.req.header("content-length");
  if (!/^[1-9][0-9]*$/u.test(size) || length !== undefined && length !== size) {
    throw new HttpError("REQUEST_INVALID_INPUT", "Upload byte length is missing or inconsistent");
  }
  const parsed = uploadMetadataSchema.safeParse({
    kind: c.req.header("x-upload-kind"), name, mediaType: c.req.header("x-upload-media-type"),
    byteSize: Number(size), sha256: c.req.header("x-upload-sha256"),
  });
  if (!parsed.success || !c.req.raw.body) throw new HttpError("REQUEST_INVALID_INPUT", "Invalid upload metadata or body");
  const files = c.env.evalManagement?.files;
  if (!files) throw new HttpError("INTERNAL_ERROR");
  const receipt = await files.ingest(c.var.user.id, parsed.data, c.req.raw.body);
  c.header("X-Content-Type-Options", "nosniff");
  return c.json(receipt, 201);
});

for (const method of ["get", "put", "patch", "delete"] as const) {
  router[method](MANAGEMENT_UPLOAD_PATH, (c) => {
    c.header("Cache-Control", "no-store");
    if (!c.env.evalManagement) return c.json({ error: "Not found" }, 404);
    c.header("Allow", "POST");
    return c.json({ error: "Method not allowed" }, 405);
  });
}

export default router;
