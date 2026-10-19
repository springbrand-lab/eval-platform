/** Base64 of a file's bytes, without a data: URL prefix. */
export async function fileToBase64(file: Blob): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < buffer.length; index += chunk) {
    binary += String.fromCharCode(...buffer.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function guessMediaType(path: string, fallback = "application/octet-stream"): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", html: "text/html", htm: "text/html", css: "text/css",
    js: "text/javascript", mjs: "text/javascript", ts: "text/plain", tsx: "text/plain", json: "application/json",
    csv: "text/csv", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", pdf: "application/pdf", yaml: "application/yaml", yml: "application/yaml",
  };
  return types[extension] ?? fallback;
}

export function downloadFile(name: string, content: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
