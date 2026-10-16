import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@springbrand/site-block";
import { toast } from "sonner";
import { projectKeys } from "@/api-sdk/projects-api";
import { runKeys, stopRun } from "@/api-sdk/runs-api";
import { ErrorBlock } from "@/components/ui/feedback";

export interface StopRunTarget { readonly projectId: string; readonly runId: string }

/** The confirmation names the Run selected by the click, even when a newer Run starts meanwhile. */
export function StopRunDialog({ target, onClose }: { target: StopRunTarget | null; onClose: () => void }) {
  return target ? <StopConfirmation key={`${target.projectId}:${target.runId}`} target={target} onClose={onClose} /> : null;
}

function StopConfirmation({ target, onClose }: { target: StopRunTarget; onClose: () => void }) {
  const client = useQueryClient();
  const stop = useMutation({
    mutationFn: () => stopRun(target.projectId, target.runId),
    meta: { silent: true },
    onSuccess: async () => {
      toast.success("已请求停止");
      await Promise.all([
        client.invalidateQueries({ queryKey: projectKeys.detail(target.projectId) }),
        client.invalidateQueries({ queryKey: runKeys.detail(target.projectId, target.runId) }),
      ]);
      onClose();
    },
  });
  return <AlertDialog open onOpenChange={(open) => { if (!open && !stop.isPending) onClose(); }}>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>停止 Run {target.runId.slice(0, 8)}</AlertDialogTitle>
        <AlertDialogDescription>中断这个 Run 正在运行的全部 Agent，不再开始新的采样和评估。已完成的结果保留。</AlertDialogDescription>
      </AlertDialogHeader>
      {stop.error && <ErrorBlock error={stop.error} />}
      <AlertDialogFooter><AlertDialogCancel variant="outline" size="default" disabled={stop.isPending}>取消</AlertDialogCancel>
        <AlertDialogAction variant="destructive" loading={stop.isPending} onClick={() => stop.mutate()}>停止</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
