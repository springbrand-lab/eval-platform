import { evalInitialContextSchema } from "@springbrand/eval-harness";
import { readSessionZip } from "../../bundle-zip/bundle-zip.js";
import { SESSION_BODY_BYTES } from "../../limits.js";
import { bundleRouter, metadata } from "../bundle-catalog.js";

export default bundleRouter({
  tag: "Session Bundle",
  resource: "Session",
  segment: "sessions",
  idParam: "sessionId",
  body: evalInitialContextSchema.extend(metadata),
  bodyBytes: SESSION_BODY_BYTES,
  catalog: (services) => services.sessionBundles,
  readZip: readSessionZip,
  content: ({ content }) => content,
  imported: (source, session) => ({ source, session }),
});
