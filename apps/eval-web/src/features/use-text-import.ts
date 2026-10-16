import { useEffect, useRef, useState } from "react";
import type { Accept } from "react-dropzone";

const FORMATS = {
  json: { mime: "application/json", extensions: [".json"] },
  jsonl: { mime: "application/x-ndjson", extensions: [".jsonl"] },
  yaml: { mime: "application/yaml", extensions: [".yaml", ".yml"] },
} as const;
type TextFormat = keyof typeof FORMATS;

export function textImportAccept(formats: readonly TextFormat[]): Accept {
  return Object.fromEntries(formats.map((format) => [FORMATS[format].mime, [...FORMATS[format].extensions]]));
}

/** Recognized extensions take precedence; a MIME-only selection uses its accepted type. */
export function detectTextImportFormat<Format extends TextFormat>(file: File, formats: readonly Format[]): Format | undefined {
  return formats.find((format) => FORMATS[format].extensions.some((extension) => file.name.toLowerCase().endsWith(extension)))
    ?? formats.find((format) => FORMATS[format].mime === file.type.toLowerCase());
}

/** The editable import draft owns file reads; a newer choice or edit supersedes them. */
export function useTextImport(initialContent = "") {
  const selection = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState({ content: initialContent, reading: false, error: "" });
  useEffect(() => () => selection.current?.abort(), []);

  function setContent(content: string) {
    selection.current?.abort();
    setDraft({ content, reading: false, error: "" });
  }

  function startSelection(): AbortSignal {
    selection.current?.abort();
    const next = new AbortController();
    selection.current = next;
    setDraft({ content: "", reading: true, error: "" });
    return next.signal;
  }

  async function readFile(file: File, signal: AbortSignal) {
    try {
      const content = await file.text();
      if (!signal.aborted) setDraft({ content, reading: false, error: "" });
    } catch {
      if (!signal.aborted) {
        setDraft({ content: "", reading: false, error: "无法读取「" + file.name + "」，请重新选择文件。" });
      }
    }
  }

  return { ...draft, setContent, startSelection, readFile };
}
