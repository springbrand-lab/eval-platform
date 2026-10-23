import { Download } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { downloadProjectEvaluationResults } from "@/api-sdk/projects-api";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { downloadFile } from "@/lib/files";

export function ProjectResultsDownloadButton({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const pending = useRef(false);
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    if (disabled || pending.current) return;
    pending.current = true;
    setDownloading(true);
    try {
      const zip = await downloadProjectEvaluationResults(projectId);
      downloadFile(`project-${encodeURIComponent(projectId)}-evaluation-results.zip`, zip, "application/zip");
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      pending.current = false;
      setDownloading(false);
    }
  };
  return (
    <Button size="sm" icon={<Download />} disabled={disabled} loading={downloading} aria-busy={downloading}
      onClick={() => void download()}>{downloading ? "下载中…" : "下载评估结果"}</Button>
  );
}
