import { z } from "@hono/zod-openapi";
import { readMaterialZip } from "../../bundle-zip/bundle-zip.js";
import { MATERIAL_BODY_BYTES } from "../../limits.js";
import { materialFilesSchema } from "../../sp/bundle-content.js";
import { bundleRouter, metadata } from "../bundle-catalog.js";

export default bundleRouter({
  tag: "Material Bundle",
  resource: "Material",
  segment: "materials",
  idParam: "materialId",
  body: z.strictObject({ ...metadata, files: materialFilesSchema }),
  bodyBytes: MATERIAL_BODY_BYTES,
  catalog: (services) => services.materialBundles,
  readZip: readMaterialZip,
  content: ({ files }) => ({ files }),
  imported: (source, material) => ({ source, material }),
});
