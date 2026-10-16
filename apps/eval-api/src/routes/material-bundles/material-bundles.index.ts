import { z } from "@hono/zod-openapi";
import { EVAL_INITIAL_FILE_MAX_BYTES, EVAL_INITIALIZATION_MAX_BYTES, EVAL_MATERIAL_MAX_FILES } from "@springbrand/eval-harness";
import { readMaterialZip } from "../../bundle-zip/bundle-zip.js";
import { MATERIAL_BODY_BYTES } from "../../limits.js";
import { bundleRouter, metadata } from "../bundle-catalog.js";

/** Shape only; the catalog applies the Material content rule once, answering `400`/`413` file codes. */
const filesSchema = z.array(z.looseObject({ path: z.string(), mediaType: z.string(), contentBase64: z.string() })).openapi({
  description: `1 to ${EVAL_MATERIAL_MAX_FILES} files with unique paths, each at most ${EVAL_INITIAL_FILE_MAX_BYTES} `
    + `decoded bytes and together at most ${EVAL_INITIALIZATION_MAX_BYTES}`,
});

export default bundleRouter({
  tag: "Material Bundle",
  resource: "Material",
  segment: "materials",
  idParam: "materialId",
  body: z.strictObject({ ...metadata, files: filesSchema }),
  bodyBytes: MATERIAL_BODY_BYTES,
  catalog: (services) => services.materialBundles,
  readZip: readMaterialZip,
  content: ({ files }) => ({ files }),
  imported: (source, material) => ({ source, material }),
});
