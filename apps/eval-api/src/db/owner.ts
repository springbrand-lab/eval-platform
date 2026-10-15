import { IDENTIFIER_RULE, isIdentifier } from "@eval-platform/eval-contracts";

export function requireOwnerUserId(value: string): string {
  if (!isIdentifier(value)) throw new TypeError(`ownerUserId ${IDENTIFIER_RULE}`);
  return value;
}
