import { useEffect, useState } from "react";

/** A URL belongs to its Blob and is unavailable as soon as the input changes. */
export function useBlobUrl(blob: Blob | undefined): string | null {
  const [current, setCurrent] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setCurrent({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return current && current.blob === blob ? current.url : null;
}
