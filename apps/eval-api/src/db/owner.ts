export function requireOwnerUserId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("ownerUserId must be a non-empty identifier without surrounding whitespace");
  }
  return value;
}
