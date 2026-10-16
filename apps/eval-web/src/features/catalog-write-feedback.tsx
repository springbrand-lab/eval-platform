import { ErrorBlock, Notice } from "@/components/ui/feedback";
import { isWriteOutcomeUnknown } from "@/lib/errors";

/** Reconcile the refreshed catalog before repeating a create/import with an unknown outcome. */
export function CatalogWriteFeedback({ error }: { error: unknown }) {
  if (!error) return null;
  return <>
    <ErrorBlock error={error} />
    {isWriteOutcomeUnknown(error) && <Notice tone="warning">提交结果尚未确认。请先核对目录中的新增条目，再决定是否重新提交。</Notice>}
  </>;
}
