import { printParseErrorCode, visit } from "jsonc-parser";

/** Reject duplicate decoded object keys before JSON.parse discards them. */
export function parseStrictJson(source: string): unknown {
  const objectKeys: Set<string>[] = [];
  visit(source, {
    onObjectBegin() { objectKeys.push(new Set()); },
    onObjectProperty(property, offset) {
      const keys = objectKeys.at(-1)!;
      if (keys.has(property)) throw new SyntaxError(`Duplicate JSON field ${JSON.stringify(property)} at offset ${offset}`);
      keys.add(property);
    },
    onObjectEnd() { objectKeys.pop(); },
    onError(error, offset) {
      throw new SyntaxError(`Invalid JSON at offset ${offset}: ${printParseErrorCode(error)}`);
    },
  }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  return JSON.parse(source);
}
