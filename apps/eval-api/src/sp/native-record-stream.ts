import { createHash } from "node:crypto";
import {
  PI_TRAJECTORY_RECORD_FORMAT, isSafePiTrajectoryRecord, spPiTrajectoryIdentityParts,
  spPiTrajectoryRecordIdentity, type JsonValue, type PiTrajectoryRecord,
} from "@eval-platform/eval-contracts";
import { EVAL_RESULT_MAX_BYTES } from "@springbrand/eval-harness";

/**
 * Source-independent byte validation. This is NOT an SP route or a replacement for
 * @springbrand/eval-harness's public wire: the caller must obtain the frozen record
 * identity, length, digest and authorized stream from that wire.
 */
export interface NativeRecordByteBinding {
  readonly identity: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly maxBytes: number;
  readonly scope:
    | { readonly kind: "chat"; readonly chatId: string }
    | { readonly kind: "operation"; readonly chatId: string; readonly submissionId: string;
      readonly verifiedSubmissions?: ReadonlySet<string> };
  /** Bounded native interpretation for Metrics or the Evaluator's result-file fallback.
   * No record object is constructed during evidence export. */
  readonly interpret?: "metrics" | "reply";
  /** Called only after the entire original JSON has been verified; never log its `record`. */
  readonly onVerified?: (inspection: NativeRecordInspection) => void;
}

export interface NativeRecordInspection {
  readonly byteLength: number;
  readonly sha256: string;
  readonly identity: string;
  /** Bounded-memory diagnostics, including when the source supplies a large chunk. */
  readonly maxDecodedChars: number;
  readonly maxCapturedChars: number;
  readonly maxDepth: number;
  /** Present only if requested. At most 512 KiB of original JSON is ever parsed; a
   * larger record is reduced to bounded native facts, with withheld Tool lengths unknown. */
  readonly record?: PiTrajectoryRecord;
  readonly reduced?: boolean;
  readonly maxBufferedBytes?: number;
}

export class NativeRecordStreamError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "NativeRecordStreamError";
  }
}

const DECODE_CHUNK_BYTES = 64 * 1024;
const MAX_INTERPRETED_BYTES = 512 * 1024;
const MAX_CONTENT_BLOCKS = 256;
const OMITTED = "[CONTENT OMITTED]";
const MAX_KEY_CHARS = 512;
const MAX_FIELD_CHARS = 4_096;
const MAX_NUMBER_CHARS = 128;
const MAX_DEPTH = 128;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
const HEX = /^[0-9a-f]$/iu;

type Scalar = string | number | boolean | null;
type ValueType = "object" | "array" | "string" | "number" | "boolean" | "null";
type Frame = {
  readonly type: "object" | "array";
  /** Untracked native bodies have no path and retain no keys or scalar content. */
  readonly path?: string;
  state: "keyOrEnd" | "key" | "colon" | "valueOrEnd" | "value" | "commaOrEnd";
  key: string | undefined;
  /** Array position, or the position of a tracked block inside its content array. */
  index?: number;
  readonly seen?: Set<string>;
};

const ENVELOPE_KEYS: Readonly<Record<string, readonly string[]>> = {
  "": ["format", "resource", "submissionId", "projection", "record", "parent", "origin"],
  resource: ["agentId", "sessionId"],
  projection: ["kind", "policyId", "policyVersion"],
  record: ["type", "value"],
  parent: ["resource", "submissionId", "conversationId", "taskId", "requestId", "toolCallId", "runId"],
  "parent.resource": ["agentId", "sessionId"],
};
const NATIVE_VALUE_KEYS = new Set(["id", "conversationId", "kind", "model"]);
const MESSAGE = "record.value.model[0]";
const BLOCK = `${MESSAGE}.content[*]`;
const BLOCK_TEXT = `${BLOCK}.text`;
const MESSAGE_FIELDS = [
  "role", "timestamp", "stopReason", "content", "usage", "toolCallId", "toolName", "isError", "durationMs",
];
const BLOCK_FIELDS = ["type", "id", "name", "arguments", "text"];
const TRACKED_PATHS = new Set([
  ...Object.keys(ENVELOPE_KEYS),
  ...Object.entries(ENVELOPE_KEYS).flatMap(([parent, keys]) => keys.map((key) => parent ? `${parent}.${key}` : key)),
  "record.value.id", "record.value.conversationId", "record.value.kind", "record.value.model",
  "record.value.byTaskId", "record.value.head", "record.value.edits",
  MESSAGE, ...MESSAGE_FIELDS.map((field) => `${MESSAGE}.${field}`),
  ...["input", "output", "totalTokens"].map((field) => `${MESSAGE}.usage.${field}`),
  BLOCK, ...BLOCK_FIELDS.map((field) => `${BLOCK}.${field}`),
]);
const INSPECTED_PATHS = new Set([...TRACKED_PATHS].filter((path) => path !== ""));
const REQUIRED_STRING_PATHS = new Set([
  "format", "resource.agentId", "resource.sessionId", "projection.kind", "projection.policyId",
  "record.type", "record.value.kind", "submissionId", "origin",
  "parent.resource.agentId", "parent.resource.sessionId", "parent.submissionId",
]);

function invalid(message: string): never {
  throw new NativeRecordStreamError(`Unsafe SAFE Pi record: ${message}`, false);
}

/**
 * A bounded JSON syntax scanner, not a native message interpreter. Only the SAFE
 * envelope and native identity are retained; huge Pi messages/Tool bodies remain
 * opaque, but every byte must still be valid JSON and UTF-8. No reconstructed
 * Universal events, payload projection, or whole-record JSON.parse is involved.
 */
class SafePiJsonScanner {
  private readonly frames: Frame[] = [];
  private readonly types = new Map<string, ValueType>();
  private readonly scalars = new Map<string, Scalar>();
  private readonly blocks: Record<string, JsonValue>[] = [];
  private root: "value" | "done" = "value";
  private token: "idle" | "string" | "escape" | "unicode" | "number" | "literal" = "idle";
  private tokenValue = "";
  private tokenPath: string | undefined;
  private tokenIsKey = false;
  private capture = false;
  private overlongKey = false;
  private unicodeRemaining = 0;
  private literal = "";
  private modelCount = 0;
  private contentCount = 0;
  private contentInvalid = false;
  private replyChars = 0;
  maxCapturedChars = 0;
  maxDepth = 0;

  constructor(private readonly interpret?: "metrics" | "reply") {}

  get hasAmbiguousMessage(): boolean { return this.contentInvalid; }

  feed(text: string): void {
    for (const char of text) {
      // JSONL contains *one* original record on *one* line. Whitespace around
      // JSON values is legal, but a literal CR/LF is not a single JSONL record.
      if (char === "\n" || char === "\r") invalid("literal line break in JSONL record");
      this.advance(char);
    }
  }

  finish(identity: string, scope: NativeRecordByteBinding["scope"]): void {
    if (this.token === "number") this.finishNumber();
    if (this.token !== "idle" || this.frames.length !== 0 || this.root !== "done") invalid("incomplete JSON object");

    const type = (path: string): ValueType | undefined => this.types.get(path);
    const value = (path: string): Scalar | undefined => this.scalars.get(path);
    const text = (path: string): string => {
      const item = value(path);
      if (type(path) !== "string" || typeof item !== "string" || item.length === 0) invalid(`invalid ${path}`);
      return item;
    };
    const positive = (path: string): number => {
      const item = value(path);
      if (type(path) !== "number" || typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
        invalid(`invalid ${path}`);
      }
      return item;
    };
    const object = (path: string): void => { if (type(path) !== "object") invalid(`invalid ${path}`); };

    if (text("format") !== PI_TRAJECTORY_RECORD_FORMAT) invalid("non-native format");
    object("resource");
    const agentId = text("resource.agentId");
    const chatId = text("resource.sessionId");
    if (chatId !== scope.chatId) invalid("foreign Chat");
    object("projection");
    if (text("projection.kind") !== "safe" || !text("projection.policyId")) invalid("unsafe projection");
    positive("projection.policyVersion");
    object("record");
    object("record.value");
    const kind = text("record.type");
    if (kind !== "entry" && kind !== "conversation") invalid("invalid native record type");
    const id = positive("record.value.id");
    if (kind === "entry") {
      positive("record.value.conversationId");
      text("record.value.kind");
      if (type("record.value.model") !== undefined && type("record.value.model") !== "array") {
        invalid("invalid native Pi message array");
      }
    }
    if (JSON.stringify([agentId, chatId, kind, id]) !== identity) invalid("actor or native identity changed");

    const submission = value("submissionId");
    if (type("submissionId") === "null") {
      if (text("origin") !== "context") invalid("missing Context origin");
    } else {
      text("submissionId");
      const origin = type("origin");
      if (origin !== undefined && (origin !== "string" || value("origin") !== "execution")) invalid("invalid execution origin");
    }
    if (type("parent") !== undefined) {
      object("parent");
      object("parent.resource");
      text("parent.resource.agentId");
      if (text("parent.resource.sessionId") !== chatId) invalid("foreign parent Chat");
      text("parent.submissionId");
      for (const path of ["parent.conversationId", "parent.taskId"]) {
        if (type(path) !== undefined) positive(path);
      }
      for (const path of ["parent.requestId", "parent.toolCallId", "parent.runId"]) {
        if (type(path) !== undefined) text(path);
      }
    }
    if (scope.kind === "operation" && submission !== scope.submissionId
      && (type("parent") !== "object" || (value("parent.submissionId") !== scope.submissionId
        && !scope.verifiedSubmissions?.has(value("parent.submissionId") as string)))) {
      invalid("foreign Submission or parent");
    }
  }

  /** Only identities, an optional native message's small fields and withholding
   * markers survive a large record. Tool body lengths stay unknown, never zero. */
  reducedRecord(): PiTrajectoryRecord {
    const scalar = (path: string): JsonValue | undefined => this.scalars.get(path);
    const agentId = scalar("resource.agentId") as string;
    const chatId = scalar("resource.sessionId") as string;
    const kind = scalar("record.type") as "entry" | "conversation";
    const id = scalar("record.value.id") as number;
    const parent: Record<string, JsonValue> = {};
    if (this.types.get("parent") === "object") {
      parent.resource = {
        agentId: scalar("parent.resource.agentId") as string,
        sessionId: scalar("parent.resource.sessionId") as string,
      };
      parent.submissionId = scalar("parent.submissionId") as string;
      for (const field of ["conversationId", "taskId", "requestId", "toolCallId", "runId"]) {
        const item = scalar(`parent.${field}`);
        if (item !== undefined) parent[field] = item;
      }
    }
    const value: Record<string, JsonValue> = { id };
    if (kind === "entry") {
      value.conversationId = scalar("record.value.conversationId") as number;
      value.kind = scalar("record.value.kind") as string;
      const byTaskId = scalar("record.value.byTaskId");
      if (byTaskId !== undefined) value.byTaskId = byTaskId;
      for (const field of ["head", "edits"]) {
        if (this.types.has(`record.value.${field}`)) value[field] = true;
      }
      if (this.types.get("record.value.model") === "array") {
        if (this.modelCount !== 1 || this.contentInvalid) {
          // NativeMetricFacts rejects a multi-message/delta Entry instead of
          // treating an omitted second message as absent.
          value.model = [{}, {}];
        } else {
          const message: Record<string, JsonValue> = {};
          for (const field of MESSAGE_FIELDS) {
            const item = scalar(`${MESSAGE}.${field}`);
            if (item !== undefined && field !== "usage" && field !== "content") message[field] = item;
          }
          if (this.types.get(`${MESSAGE}.usage`) === "object") {
            const usage: Record<string, JsonValue> = {};
            for (const field of ["input", "output", "totalTokens"]) {
              const item = scalar(`${MESSAGE}.usage.${field}`);
              if (item !== undefined) usage[field] = item;
            }
            message.usage = usage;
          }
          if (this.types.get(`${MESSAGE}.content`) === "array") {
            message.content = this.contentCount <= MAX_CONTENT_BLOCKS
              ? this.blocks.slice(0, this.contentCount).map((block) => ({ ...block }))
              : OMITTED;
          }
          value.model = [message];
        }
      }
    }
    return {
      format: PI_TRAJECTORY_RECORD_FORMAT,
      resource: { agentId, sessionId: chatId },
      submissionId: scalar("submissionId") as string | null,
      projection: { kind: "safe", policyId: scalar("projection.policyId") as string,
        policyVersion: scalar("projection.policyVersion") as number },
      ...(this.types.has("parent") ? { parent } : {}),
      ...(this.types.has("origin") ? { origin: scalar("origin") as "context" | "execution" } : {}),
      record: { type: kind, value } as PiTrajectoryRecord["record"],
    };
  }

  private childPath(parent: Frame): string | undefined {
    if (parent.path === undefined) return undefined;
    if (parent.type === "array") {
      if (this.interpret === undefined) return undefined;
      if (parent.path === "record.value.model" && parent.index === 0) return MESSAGE;
      if (parent.path === `${MESSAGE}.content` && parent.index! < MAX_CONTENT_BLOCKS) return BLOCK;
      return undefined;
    }
    if (parent.key === undefined) return undefined;
    const candidate = parent.path ? `${parent.path}.${parent.key}` : parent.key;
    return TRACKED_PATHS.has(candidate) ? candidate : undefined;
  }

  private valueType(path: string | undefined, type: ValueType, scalar?: Scalar): void {
    const parent = this.frames.at(-1);
    if (parent?.type === "array" && parent.path === "record.value.model" && type !== "object") {
      invalid("invalid native Pi message");
    }
    if (path !== undefined && INSPECTED_PATHS.has(path)) {
      this.types.set(path, type);
      if (scalar !== undefined || type === "null") this.scalars.set(path, scalar ?? null);
    }
    if (this.interpret !== undefined && path === BLOCK) {
      if (type !== "object") this.contentInvalid = true;
      else if (parent?.type === "array" && parent.index! < MAX_CONTENT_BLOCKS) {
        this.blocks[parent.index!] ??= { text: OMITTED };
      }
    }
    if (this.interpret !== undefined && path?.startsWith(`${BLOCK}.`) && parent?.path === BLOCK) {
      const index = parent.index!;
      if (index >= MAX_CONTENT_BLOCKS) return;
      const block = this.blocks[index] ??= { text: OMITTED };
      const field = path.slice(BLOCK.length + 1);
      if (field === "arguments") block.arguments = type === "null" ? null : OMITTED;
      else if (field === "text") block.text = typeof scalar === "string" && this.interpret === "reply" ? scalar : OMITTED;
      else if (typeof scalar === "string") block[field] = scalar;
    }
  }

  private completeValue(): void {
    const parent = this.frames.at(-1);
    if (!parent) {
      this.root = "done";
      return;
    }
    if (parent.state !== "value" && parent.state !== "valueOrEnd") invalid("invalid JSON value position");
    parent.state = "commaOrEnd";
    if (parent.type === "array") parent.index!++;
    parent.key = undefined;
  }

  private startString(key: boolean, path?: string): void {
    this.token = "string";
    this.tokenIsKey = key;
    this.tokenPath = path;
    this.capture = key ? this.frames.at(-1)?.path !== undefined
      : path !== undefined && INSPECTED_PATHS.has(path)
        && (path !== BLOCK_TEXT || this.interpret === "reply");
    this.overlongKey = false;
    this.tokenValue = this.capture ? "\"" : "";
  }

  private append(char: string): void {
    if (!this.capture) return;
    this.tokenValue += char;
    this.maxCapturedChars = Math.max(this.maxCapturedChars, this.tokenValue.length);
    const maximum = this.tokenIsKey ? MAX_KEY_CHARS : this.tokenPath === BLOCK_TEXT
      ? EVAL_RESULT_MAX_BYTES - this.replyChars : MAX_FIELD_CHARS;
    if (this.tokenValue.length > maximum) {
      if (!this.tokenIsKey && REQUIRED_STRING_PATHS.has(this.tokenPath ?? "")) invalid("oversized native identity field");
      // An opaque Tool object may have a large key; do not retain it. A strict
      // envelope will reject the unknown key, and it cannot be an expected key.
      // An overlong reply/optional metric field stays unknown, not an empty value.
      this.tokenValue = "";
      this.capture = false;
      if (this.tokenIsKey) this.overlongKey = true;
    }
  }

  private finishString(): void {
    this.token = "idle";
    const value = this.capture ? JSON.parse(this.tokenValue) as string : undefined;
    if (this.tokenIsKey) {
      const parent = this.frames.at(-1);
      if (!parent || parent.type !== "object" || (parent.state !== "key" && parent.state !== "keyOrEnd")) {
        invalid("invalid JSON object key");
      }
      const key = this.overlongKey ? undefined : value;
      const allowed = parent.path === undefined ? undefined : ENVELOPE_KEYS[parent.path];
      if (allowed !== undefined && (key === undefined || !allowed.includes(key))) invalid("unexpected native envelope field");
      if (this.overlongKey && this.interpret !== undefined && parent.path !== undefined) this.contentInvalid = true;
      if (key !== undefined && (allowed !== undefined || (parent.path === "record.value" && NATIVE_VALUE_KEYS.has(key)))) {
        if (parent.seen!.has(key)) invalid("duplicate native envelope field");
        parent.seen!.add(key);
      }
      if (this.interpret !== undefined && key !== undefined && (parent.path === MESSAGE || parent.path === BLOCK
        || parent.path === `${MESSAGE}.usage`)) {
        if (parent.seen!.has(key)) this.contentInvalid = true;
        parent.seen!.add(key);
      }
      if (this.interpret !== undefined && parent.path === BLOCK && key?.toLowerCase().endsWith("signature")) {
        const block = this.blocks[parent.index!] ??= { text: OMITTED };
        block[key] = OMITTED;
      }
      parent.key = key;
      parent.state = "colon";
    } else {
      this.valueType(this.tokenPath, "string", value);
      if (this.tokenPath === BLOCK_TEXT && this.capture) this.replyChars += this.tokenValue.length;
      this.completeValue();
    }
    this.tokenValue = "";
    this.tokenPath = undefined;
  }

  private finishNumber(): void {
    if (!NUMBER.test(this.tokenValue)) invalid("invalid JSON number");
    const number = Number(this.tokenValue);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) {
      invalid("non-finite or unsafe JSON number");
    }
    this.valueType(this.tokenPath, "number", number);
    this.token = "idle";
    this.tokenValue = "";
    this.tokenPath = undefined;
    this.completeValue();
  }

  private closeFrame(): void {
    const frame = this.frames.pop()!;
    if (frame.type === "array" && frame.path === "record.value.model") this.modelCount = frame.index!;
    if (frame.type === "array" && frame.path === `${MESSAGE}.content`) this.contentCount = frame.index!;
    this.completeValue();
  }

  private beginValue(char: string): void {
    const parent = this.frames.at(-1);
    if (!parent && this.root !== "value") invalid("trailing JSON content");
    if (!parent && char !== "{") invalid("expected a native JSON object");
    const path = parent === undefined ? "" : this.childPath(parent);
    if (char === "{" || char === "[") {
      const type = char === "{" ? "object" : "array";
      this.valueType(path, type);
      if (this.frames.length >= MAX_DEPTH) invalid("native JSON nesting is too deep");
      this.frames.push({
        type, ...(path === undefined ? {} : { path }),
        state: type === "object" ? "keyOrEnd" : "valueOrEnd",
        key: undefined,
        ...(type === "array" ? { index: 0 } : parent?.path === `${MESSAGE}.content`
          && parent.type === "array" ? { index: parent.index } : {}),
        ...(path === undefined ? {} : { seen: new Set<string>() }),
      });
      this.maxDepth = Math.max(this.maxDepth, this.frames.length);
    } else if (char === "\"") {
      this.startString(false, path);
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      this.token = "number";
      this.tokenPath = path;
      this.tokenValue = char;
    } else if (char === "t" || char === "f" || char === "n") {
      this.token = "literal";
      this.tokenPath = path;
      this.literal = char === "t" ? "true" : char === "f" ? "false" : "null";
      this.tokenValue = char;
    } else invalid("invalid JSON value");
  }

  private advance(char: string): void {
    if (this.token === "string") {
      if (char === "\"") {
        this.append(char);
        this.finishString();
      } else if (char === "\\") {
        this.append(char);
        this.token = "escape";
      } else {
        if (char.charCodeAt(0) < 32) invalid("unescaped JSON control character");
        this.append(char);
      }
      return;
    }
    if (this.token === "escape") {
      if (!"\"\\/bfnrtu".includes(char)) invalid("invalid JSON string escape");
      this.append(char);
      if (char === "u") { this.token = "unicode"; this.unicodeRemaining = 4; }
      else this.token = "string";
      return;
    }
    if (this.token === "unicode") {
      if (!HEX.test(char)) invalid("invalid JSON Unicode escape");
      this.append(char);
      if (--this.unicodeRemaining === 0) this.token = "string";
      return;
    }
    if (this.token === "number") {
      if ("0123456789.eE+-".includes(char)) {
        this.tokenValue += char;
        if (this.tokenValue.length > MAX_NUMBER_CHARS) invalid("oversized JSON number");
        return;
      }
      this.finishNumber();
      // The delimiter also closes an object/array or starts its next member.
    } else if (this.token === "literal") {
      const expected = this.literal[this.tokenValue.length];
      if (char !== expected) invalid("invalid JSON literal");
      this.tokenValue += char;
      if (this.tokenValue === this.literal) {
        this.valueType(this.tokenPath, this.literal === "null" ? "null" : "boolean",
          this.literal === "null" ? null : this.literal === "true");
        this.token = "idle";
        this.tokenPath = undefined;
        this.tokenValue = "";
        this.completeValue();
      }
      return;
    }
    if (char === " " || char === "\t") return;
    const frame = this.frames.at(-1);
    if (!frame) {
      if (this.root !== "value") invalid("trailing JSON content");
      this.beginValue(char);
      return;
    }
    if (frame.type === "object") {
      if (frame.state === "keyOrEnd" || frame.state === "key") {
        if (char === "}" && frame.state === "keyOrEnd") { this.closeFrame(); return; }
        if (char !== "\"") invalid("expected a JSON object key");
        this.startString(true);
        return;
      }
      if (frame.state === "colon") {
        if (char !== ":") invalid("missing JSON object colon");
        frame.state = "value";
        return;
      }
      if (frame.state === "commaOrEnd") {
        if (char === "}") { this.closeFrame(); return; }
        if (char !== ",") invalid("missing JSON object comma");
        frame.state = "key";
        return;
      }
    } else {
      if (frame.state === "commaOrEnd") {
        if (char === "]") { this.closeFrame(); return; }
        if (char !== ",") invalid("missing JSON array comma");
        frame.state = "value";
        return;
      }
      if (char === "]" && frame.state === "valueOrEnd") { this.closeFrame(); return; }
    }
    if (frame.state !== "value" && frame.state !== "valueOrEnd") invalid("invalid JSON value position");
    this.beginValue(char);
  }
}

function validateBinding(binding: NativeRecordByteBinding): void {
  const identity = spPiTrajectoryIdentityParts(binding.identity);
  if (!identity || identity[1] !== binding.scope.chatId
    || !Number.isSafeInteger(binding.byteLength) || binding.byteLength <= 0
    || !Number.isSafeInteger(binding.maxBytes) || binding.maxBytes <= 0
    || binding.byteLength > binding.maxBytes
    || !/^[0-9a-f]{64}$/u.test(binding.sha256)
    || (binding.scope.kind !== "chat" && binding.scope.kind !== "operation")
    || (binding.scope.kind === "operation" && !binding.scope.submissionId)) {
    throw new NativeRecordStreamError("Invalid SAFE Pi byte-stream binding or evidence file limit", false);
  }
}

/**
 * Checks the *entire* original native JSON while passing its bytes through unchanged.
 * A complete EOF, byte count, SHA-256, strict UTF-8, JSON syntax, SAFE projection,
 * actor/Chat/native identity, Context/Submission and same-Chat parent must all
 * agree before the returned stream closes successfully. An interrupted transport
 * is never a verified record; consumers must not commit partial blobs/progress.
 */
export function verifiedSafePiRecordBytes(
  source: ReadableStream<Uint8Array>, binding: NativeRecordByteBinding,
): ReadableStream<Uint8Array> {
  validateBinding(binding);
  const scanner = new SafePiJsonScanner(binding.interpret);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const hash = createHash("sha256");
  let received = 0;
  let maxDecodedChars = 0;
  let buffered = 0;
  const parts: Uint8Array[] = [];
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > binding.byteLength) invalid("more bytes than the frozen record length");
      hash.update(chunk);
      if (binding.interpret !== undefined && buffered <= MAX_INTERPRETED_BYTES) {
        if (buffered + chunk.byteLength <= MAX_INTERPRETED_BYTES) {
          parts.push(chunk.slice());
          buffered += chunk.byteLength;
        } else {
          parts.length = 0;
          buffered = MAX_INTERPRETED_BYTES + 1;
        }
      }
      for (let offset = 0; offset < chunk.byteLength; offset += DECODE_CHUNK_BYTES) {
        let text: string;
        try {
          text = decoder.decode(chunk.subarray(offset, offset + DECODE_CHUNK_BYTES), { stream: true });
        } catch {
          invalid("invalid UTF-8");
        }
        maxDecodedChars = Math.max(maxDecodedChars, text.length);
        scanner.feed(text);
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (received !== binding.byteLength) {
        throw new NativeRecordStreamError("SAFE Pi record transfer ended before its frozen byte length", true);
      }
      try {
        scanner.feed(decoder.decode());
      } catch (error) {
        if (error instanceof NativeRecordStreamError) throw error;
        invalid("invalid UTF-8");
      }
      scanner.finish(binding.identity, binding.scope);
      const actualHash = hash.digest("hex");
      if (actualHash !== binding.sha256) invalid("SHA-256 differs from the frozen record");
      let record: PiTrajectoryRecord | undefined;
      if (binding.interpret !== undefined) {
        if (buffered <= MAX_INTERPRETED_BYTES && !scanner.hasAmbiguousMessage) {
          const original = new Uint8Array(buffered);
          let offset = 0;
          for (const part of parts) { original.set(part, offset); offset += part.byteLength; }
          try {
            record = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original)) as unknown as PiTrajectoryRecord;
          } catch {
            invalid("verified native record is not JSON");
          }
        } else record = scanner.reducedRecord();
        if (!isSafePiTrajectoryRecord(record) || spPiTrajectoryRecordIdentity(record) !== binding.identity) {
          invalid("invalid native interpretation");
        }
      }
      binding.onVerified?.({
        byteLength: received, sha256: actualHash, identity: binding.identity,
        maxDecodedChars, maxCapturedChars: scanner.maxCapturedChars, maxDepth: scanner.maxDepth,
        ...(record === undefined ? {} : { record, reduced: buffered > MAX_INTERPRETED_BYTES || scanner.hasAmbiguousMessage,
          maxBufferedBytes: Math.min(buffered, MAX_INTERPRETED_BYTES) }),
      });
    },
  }));
}

/** Existing v2 evidence format: one original JSON record per JSONL line, with no re-serialization. */
export function verifiedSafePiJsonlLine(
  source: ReadableStream<Uint8Array>,
  binding: NativeRecordByteBinding & { readonly ingestSeq: number; readonly maxFileBytes: number },
): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(binding.ingestSeq) || binding.ingestSeq <= 0) {
    throw new NativeRecordStreamError("Invalid native source sequence", false);
  }
  const prefix = new TextEncoder().encode(`{"ingestSeq":${binding.ingestSeq},"record":`);
  const suffix = Uint8Array.of(125, 10); // }\n
  if (!Number.isSafeInteger(binding.maxFileBytes) || binding.maxFileBytes <= 0
    || prefix.byteLength + binding.byteLength + suffix.byteLength > binding.maxFileBytes) {
    throw new NativeRecordStreamError("Native JSONL record exceeds one evidence file", false);
  }
  const reader = verifiedSafePiRecordBytes(source, binding).getReader();
  let prefixSent = false;
  let closed = false;
  const release = async (cancel: boolean, reason?: unknown) => {
    if (closed) return;
    closed = true;
    if (cancel) await reader.cancel(reason).catch(() => undefined);
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true;
        controller.enqueue(prefix);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          // The newline and successful EOF are emitted only after a complete
          // verified record, never after cancellation or a short transport.
          await release(false);
          controller.enqueue(suffix);
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        await release(true, error);
        controller.error(error);
      }
    },
    async cancel(reason) { await release(true, reason); },
  });
}
