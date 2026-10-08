import { printParseErrorCode, visit as visitJson } from "jsonc-parser";
import { isScalar, parseDocument, stringify, visit } from "yaml";
import type { DatasetDocument } from "./model.js";
import { datasetDocumentSchema } from "./model.js";

export type DatasetFormat = "json" | "yaml";

export function parseDatasetDocument(source: string, format: DatasetFormat): DatasetDocument {
  if (typeof source !== "string") throw new TypeError("Dataset source must be a string");
  let document: unknown;
  switch (format) {
    case "json":
      document = parseJsonDocument(source);
      break;
    case "yaml": {
      const parsed = parseDocument(source, {
        schema: "core",
        strict: true,
        uniqueKeys: true,
        resolveKnownTags: false,
        intAsBigInt: true,
      });
      const error = parsed.errors[0] ?? parsed.warnings[0];
      if (error) throw error;
      visit(parsed, {
        Pair(_key, pair) {
          if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
            throw new TypeError("YAML mapping keys must be strings");
          }
        },
        Scalar(_key, scalar) {
          if (typeof scalar.value !== "bigint") return;
          if (
            scalar.value < BigInt(Number.MIN_SAFE_INTEGER)
            || scalar.value > BigInt(Number.MAX_SAFE_INTEGER)
          ) {
            throw new RangeError("YAML integers must be within the safe-integer range; encode large integers as strings");
          }
          scalar.value = Number(scalar.value);
        },
      });
      document = parsed.toJS({ maxAliasCount: 0 });
      break;
    }
    default:
      throw new TypeError(`Unsupported dataset format: ${format}`);
  }
  return datasetDocumentSchema.parse(document);
}

function parseJsonDocument(source: string): unknown {
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

export function serializeDatasetDocument(document: DatasetDocument, format: DatasetFormat): string {
  const parsed = datasetDocumentSchema.parse(document);
  switch (format) {
    case "json":
      return `${JSON.stringify(parsed, null, 2)}\n`;
    case "yaml":
      return stringify(parsed, { aliasDuplicateObjects: false, lineWidth: 0, schema: "core" });
    default:
      throw new TypeError(`Unsupported dataset format: ${format}`);
  }
}
