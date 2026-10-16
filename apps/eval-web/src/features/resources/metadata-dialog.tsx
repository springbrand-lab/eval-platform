import { useState, type ReactNode } from "react";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@springbrand/site-block";
import { CatalogMetadataFields } from "@/features/catalog-metadata-fields";

interface MetadataDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  initial?: { name: string; description: string };
  onSubmit: (value: { name: string; description: string }) => void;
  loading?: boolean;
  children?: ReactNode;
  submitLabel?: string;
  extraValid?: boolean;
}

/** Each opening creates one metadata draft; catalog refreshes never replace it. */
export function MetadataDialog(props: MetadataDialogProps) {
  return props.open ? <MetadataForm {...props} /> : null;
}

function MetadataForm({ onClose, title, initial, onSubmit, loading, children, submitLabel = "保存", extraValid = true }: MetadataDialogProps) {
  const [metadata, setMetadata] = useState(initial ?? { name: "", description: "" });
  const valid = !!metadata.name.trim() && !!metadata.description.trim() && extraValid;
  return <Dialog open onOpenChange={(next) => { if (!next && !loading) onClose(); }}>
    <DialogContent className={`flex max-h-[calc(100dvh-2rem)] flex-col ${children ? "sm:max-w-2xl" : "sm:max-w-lg"}`} showCloseButton={!loading}>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (valid && !loading) onSubmit({ name: metadata.name.trim(), description: metadata.description.trim() }); }}>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain">
          <CatalogMetadataFields value={metadata} disabled={loading} onChange={(patch) => setMetadata((current) => ({ ...current, ...patch }))} />
          {children}
        </div>
        <DialogFooter><Button type="button" variant="outline" disabled={loading} onClick={onClose}>取消</Button>
          <Button type="submit" loading={loading} disabled={!valid}>{submitLabel}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
