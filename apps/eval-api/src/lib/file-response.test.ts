import { getRequestListener } from "@hono/node-server";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { validateMaterialFiles } from "../sp/bundle-content.js";
import { fileResponse } from "./file-response.js";

it("serves accepted Material MIME values through Node HTTP without breaking headers, bytes or multipart parameters", async () => {
  const content = "--AbC\r\nContent-Disposition: form-data; name=\"x\"\r\n\r\na\r\n--AbC--\r\n";
  let mediaType = "application/octet-stream";
  const server = createServer(getRequestListener(() => fileResponse({
    body: content, contentType: mediaType, contentLength: String(Buffer.byteLength(content)),
  })));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    for (const value of [
      "text/plain; charset=日本語", "text/plain\r\nx-header: injected", "text/plain; x=\u0001a", "text/plain; x=\u007fa",
      "multipart/form-data; boundary=AbC", "multipart/form-data;\tboundary=AbC",
    ]) {
      const { files: [file] } = validateMaterialFiles([{
        path: "/file.bin", mediaType: value, contentBase64: Buffer.from(content).toString("base64"),
      }]);
      mediaType = file!.mediaType;
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Disposition")).toBe("attachment");
      expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
      expect(response.headers.has("x-header")).toBe(false);
      if (value.startsWith("multipart/")) {
        expect(response.headers.get("Content-Type")).toBe(value);
        expect((await response.formData()).get("x")).toBe("a");
      } else {
        expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
        expect(await response.text()).toBe(content);
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
