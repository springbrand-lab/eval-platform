import { printParseErrorCode, visit as visitJson } from "jsonc-parser";
import { isScalar, parseDocument, stringify, visit } from "yaml";
import { z } from "zod";
import type { Data, Dataset, DatasetDocument } from "./model.js";
import { parseInput } from "./input.js";
import { dataInputSchema, datasetDocumentSchema } from "./model.js";
import { DatasetInputError } from "./store.js";

const datasetFormatSchema = z.enum(["json", "yaml"]);
export type DatasetFormat = z.infer<typeof datasetFormatSchema>;

const requiredLabel = z.string().trim().min(1);
const promptDatasetLabelsSchema = z.object({
  name: requiredLabel,
  description: requiredLabel,
});
/** One Prompt Dataset upload: Dataset metadata plus a JSON or JSONL Data file. */
export const promptDatasetUploadSchema = z.strictObject({
  ...promptDatasetLabelsSchema.shape,
  format: z.enum(["json", "jsonl"]),
  content: z.string().min(1),
});
export type PromptDatasetUploadInput = Readonly<z.input<typeof promptDatasetUploadSchema>>;
const promptRowLabelsSchema = z.looseObject({
  name: requiredLabel,
  description: requiredLabel,
  evalPrompt: z.string().refine((value) => value.trim().length > 0),
});

/** Store-level invariant for Datasets created through prompt upload. */
export function assertPromptDatasetMetadata(dataset: Dataset): void {
  parseInput(() => promptDatasetLabelsSchema.parse(dataset));
}

/** Store-level invariant for every active member of a Prompt Dataset. */
export function assertPromptData(data: Data): void {
  parseInput(() => promptRowLabelsSchema.parse(data));
}

/** Parse a Data-only file and separately supplied Dataset metadata. */
export function parsePromptDatasetUpload(input: PromptDatasetUploadInput): DatasetDocument {
  return parseInput(() => {
    const upload = promptDatasetUploadSchema.parse(input);
    const rawRows: unknown = upload.format === "json"
      ? parseStrictJson(upload.content)
      : upload.content.split(/\r?\n/u).filter((line) => line.trim()).map(parseStrictJson);
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      throw new DatasetInputError("Prompt data file must contain a nonempty array of rows");
    }
    const rows = rawRows.map((raw) => {
      const row = dataInputSchema.parse(raw);
      if ("initialMaterials" in row || "evalInitialMaterials" in row || "initialSession" in row) {
        throw new DatasetInputError("Prompt data file rows must not contain initial resource references");
      }
      return promptRowLabelsSchema.parse(row);
    });
    return datasetDocumentSchema.parse({
      dataset: { name: upload.name, description: upload.description },
      data: rows,
    });
  });
}

/** Parse a user-supplied Dataset document. */
export function parseDatasetDocument(source: string, format: DatasetFormat): DatasetDocument {
  return parseInput(() => {
    if (typeof source !== "string") throw new DatasetInputError("Dataset source must be a string");
    const document = datasetFormatSchema.parse(format) === "json" ? parseStrictJson(source) : parseStrictYaml(source);
    return datasetDocumentSchema.parse(document);
  });
}

function parseStrictYaml(source: string): unknown {
  const parsed = parseDocument(source, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
    resolveKnownTags: false,
    intAsBigInt: true,
  });
  const error = parsed.errors[0] ?? parsed.warnings[0];
  if (error) throw new DatasetInputError(error.message, { cause: error });
  visit(parsed, {
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new DatasetInputError("YAML mapping keys must be strings");
      }
    },
    Scalar(_key, scalar) {
      if (typeof scalar.value !== "bigint") return;
      if (
        scalar.value < BigInt(Number.MIN_SAFE_INTEGER)
        || scalar.value > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new DatasetInputError("YAML integers must be within the safe-integer range; encode large integers as strings");
      }
      scalar.value = Number(scalar.value);
    },
  });
  return parsed.toJS({ maxAliasCount: 0 });
}

/** Parse JSON while rejecting duplicate decoded object keys, comments and trailing commas. */
export function parseStrictJson(source: string): unknown {
  const objectKeys: Set<string>[] = [];
  visitJson(source, {
    onObjectBegin() {
      objectKeys.push(new Set());
    },
    onObjectProperty(property, offset) {
      const keys = objectKeys.at(-1)!;
      if (keys.has(property)) {
        throw new SyntaxError(`Duplicate JSON field ${JSON.stringify(property)} at offset ${offset}`);
      }
      keys.add(property);
    },
    onObjectEnd() {
      objectKeys.pop();
    },
    onError(error, offset) {
      throw new SyntaxError(`Invalid JSON at offset ${offset}: ${printParseErrorCode(error)}`);
    },
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  return JSON.parse(source);
}

/** Serialize a stored Dataset; only the requested format is caller input. */
export function serializeDatasetDocument(document: DatasetDocument, format: DatasetFormat): string {
  const selected = parseInput(() => datasetFormatSchema.parse(format));
  const parsed = datasetDocumentSchema.parse(document);
  return selected === "json"
    ? `${JSON.stringify(parsed, null, 2)}\n`
    : stringify(parsed, { aliasDuplicateObjects: false, lineWidth: 0, schema: "core" });
}
