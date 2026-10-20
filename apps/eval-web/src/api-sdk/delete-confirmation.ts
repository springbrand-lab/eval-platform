import { ApiError } from "@springbrand/http/client";
import { isTransientHttpError } from "@springbrand/http/errors";
import { IDEMPOTENT_RETRY_POLICY, idempotentRetryBackoffMs } from "@eval-platform/eval-contracts";
import type { HttpErrorCode } from "@eval-platform/eval-contracts/http-errors";
import { isWriteOutcomeUnknown } from "@/lib/errors";

export function deleteWithConfirmation(remove: () => Promise<void>, confirm: () => Promise<boolean>): Promise<void>;
export function deleteWithConfirmation<T>(remove: () => Promise<T>, confirm: () => Promise<boolean>, confirmedResult: T): Promise<T>;
export async function deleteWithConfirmation<T>(
  remove: () => Promise<T>,
  confirm: () => Promise<boolean>,
  confirmedResult?: T,
): Promise<T | undefined> {
  try {
    return await remove();
  } catch (error) {
    if (isWriteOutcomeUnknown(error)) {
      for (let attemptNumber = 1; attemptNumber <= IDEMPOTENT_RETRY_POLICY.maxRetries; attemptNumber += 1) {
        try {
          if (await confirm()) return confirmedResult;
        } catch (confirmationError) {
          if (!isTransientHttpError(confirmationError)) break;
        }
        if (attemptNumber < IDEMPOTENT_RETRY_POLICY.maxRetries) {
          await new Promise<void>((resolve) => setTimeout(resolve, idempotentRetryBackoffMs(attemptNumber)));
        }
      }
    }
    // Verification cannot replace the original write error or authorize replaying DELETE.
    throw error;
  }
}

export async function isConfirmedAbsent(read: () => Promise<unknown>, notFoundCode: HttpErrorCode): Promise<boolean> {
  try {
    await read();
    return false;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === notFoundCode) return true;
    throw error;
  }
}
