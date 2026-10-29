import { timingSafeEqual } from "node:crypto";

/** Shared constant-time Bearer/header comparison; unequal lengths never reach timingSafeEqual. */
export function sameSecret(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
