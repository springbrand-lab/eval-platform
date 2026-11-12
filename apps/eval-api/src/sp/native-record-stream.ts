import {
  isPiTrajectoryRecordView, spPiTrajectoryRecordIdentity,
  type JsonValue, type NativeTrajectoryInterpretationEntry, type PiTrajectoryRecord, type PiTrajectoryRecordView,
} from "@eval-platform/eval-contracts";
import {
  EVAL_RESULT_MAX_BYTES, evalNativeRecordSchema, verifyEvalNativeRecordStream, verifiedEvalNativeRecordJsonl,
  TrajectoryRecordStreamError as NativeRecordStreamError,
  type EvalNativeRecordReference, type TrajectoryJsonCloseEvent, type TrajectoryJsonKeyEvent,
  type TrajectoryJsonObserver, type TrajectoryJsonPath, type TrajectoryJsonScalar, type TrajectoryJsonSelection,
  type TrajectoryJsonValueEvent, type TrajectoryJsonValueType, type TrajectoryRecordStreamBinding,
  type TrajectoryRecordStreamVerification,
} from "@springbrand/eval-harness";

export { NativeRecordStreamError };

/**
 * Source-independent byte validation. This is NOT an SP route or a replacement for
 * @springbrand/eval-harness's public wire: the caller must obtain the frozen record
 * identity, length, digest and authorized stream from that wire.
 */
export interface NativeRecordByteBinding extends Pick<
  TrajectoryRecordStreamBinding, "identity" | "byteLength" | "sha256" | "scope" | "signal"
> {
  readonly maxBytes: number;
  /** Bounded native interpretation for Metrics or the Evaluator's result-file fallback.
   * No record object is constructed during evidence export. */
  readonly interpret?: "metrics" | "reply";
  /** Called only after the entire original JSON has been verified; never log its `record`. */
  readonly onVerified?: (inspection: NativeRecordInspection) => void | Promise<void>;
}

export interface NativeRecordInspection extends Pick<
  TrajectoryRecordStreamVerification, "validation" | "identity" | "byteLength" | "sha256"
> {
  /** Bounded-memory diagnostics, including when the source supplies a large chunk. */
  readonly maxDecodedChars: number;
  readonly maxCapturedChars: number;
  readonly maxReplyCapturedChars?: number;
  readonly maxDepth: number;
  /** Present only if requested. At most 512 KiB of original JSON is ever parsed; a
   * larger record is reduced to bounded native facts, with withheld Tool lengths unknown. */
  readonly record?: PiTrajectoryRecord;
  readonly interpretation?: NativeTrajectoryInterpretationEntry["interpretation"];
  readonly reduced?: boolean;
  readonly maxBufferedBytes?: number;
}

const MAX_INTERPRETED_BYTES = 512 * 1024;
const MAX_CONTENT_BLOCKS = 256;
const MAX_FIELD_CHARS = 4_096;
const MESSAGE_PATH = ["record", "value", "model", 0] as const;
const CONTENT_PATH = [...MESSAGE_PATH, "content"] as const;
const MESSAGE = "record.value.model[0]";
const DETAILS = `${MESSAGE}.details`;
const BLOCK = `${MESSAGE}.content[*]`;
const BLOCK_TEXT = `${BLOCK}.text`;
const MESSAGE_FIELDS = [
  "role", "timestamp", "stopReason", "content", "usage", "toolCallId", "toolName", "isError", "durationMs",
];
const BLOCK_FIELDS = ["type", "id", "name", "arguments", "text"];
const USAGE_FIELDS = ["input", "output", "totalTokens"];
const BUSINESS_PATHS = new Map<string, string>(([
  [[], ""], [["record"], "record"], [["record", "type"], "record.type"], [["record", "value"], "record.value"],
  ...["id", "conversationId", "kind", "model", "byTaskId", "head", "edits"]
    .map((field) => [["record", "value", field], `record.value.${field}`] as const),
  [MESSAGE_PATH, MESSAGE],
  ...MESSAGE_FIELDS.map((field) => [[...MESSAGE_PATH, field], `${MESSAGE}.${field}`] as const),
  [[...MESSAGE_PATH, "details"], DETAILS],
  [[...MESSAGE_PATH, "details", "executionId"], `${DETAILS}.executionId`],
  ...USAGE_FIELDS.map((field) => [[...MESSAGE_PATH, "usage", field], `${MESSAGE}.usage.${field}`] as const),
] satisfies readonly (readonly [TrajectoryJsonPath, string])[]).map(([path, name]) => [JSON.stringify(path), name]));

function businessPath(path: TrajectoryJsonPath): string | undefined {
  const fixed = BUSINESS_PATHS.get(JSON.stringify(path));
  if (fixed !== undefined) return fixed;
  if ((path.length !== 6 && path.length !== 7)
    || !CONTENT_PATH.every((part, index) => path[index] === part)
    || typeof path[5] !== "number" || path[5] < 0 || path[5] >= MAX_CONTENT_BLOCKS) return undefined;
  if (path.length === 6) return BLOCK;
  return typeof path[6] === "string" && BLOCK_FIELDS.includes(path[6]) ? `${BLOCK}.${path[6]}` : undefined;
}

/** Only the raw Tool Result's execution ID survives a large Pi body, solely
 * for optional Tool association. Action identity comes from SP's receipt. */
function safeChargeId(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length <= 128
    && /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/u.test(value)
    && !/(?:^|[_.:-])(?:secret|token|password|api[_-]?key|bearer)(?:$|[_.:-])/iu.test(value)
    && !/^(?:sk-|key_)/iu.test(value);
}

class NativeRecordInterpreter implements TrajectoryJsonObserver {
  private readonly types = new Map<string, TrajectoryJsonValueType>();
  private readonly scalars = new Map<string, TrajectoryJsonScalar>();
  private readonly blocks: Record<string, JsonValue>[] = [];
  private readonly omitted = new Set<string>();
  private modelCount = 0;
  private contentCount = 0;
  private contentInvalid = false;
  private replyChars = 0;
  private replyBytes = 0;
  maxReplyCapturedChars = 0;

  constructor(private readonly interpret: "metrics" | "reply") {}

  get hasAmbiguousMessage(): boolean { return this.contentInvalid; }
  get omittedPaths(): readonly string[] { return [...this.omitted]; }
  get maxScalarChars(): number {
    return 6 * (this.interpret === "reply" ? EVAL_RESULT_MAX_BYTES : MAX_FIELD_CHARS) + 2;
  }

  select(path: TrajectoryJsonPath, type: TrajectoryJsonValueType): TrajectoryJsonSelection {
    const selected = businessPath(path);
    if (selected === undefined || selected === `${BLOCK}.arguments`) return false;
    if (selected === BLOCK_TEXT) {
      return this.interpret === "reply" && type === "string" && this.replyChars < EVAL_RESULT_MAX_BYTES
        && this.replyBytes < EVAL_RESULT_MAX_BYTES
        ? { maxTokenChars: 6 * (EVAL_RESULT_MAX_BYTES - this.replyChars) + 2 } : false;
    }
    if (type === "object" || type === "array") {
      return selected !== "record.value.head" && selected !== "record.value.edits";
    }
    return { maxTokenChars: 6 * MAX_FIELD_CHARS + 2 };
  }

  trackKey(path: TrajectoryJsonPath, key: string): boolean {
    const selected = businessPath(path);
    return selected === MESSAGE && MESSAGE_FIELDS.includes(key)
      || selected === BLOCK && BLOCK_FIELDS.includes(key)
      || selected === `${MESSAGE}.usage` && USAGE_FIELDS.includes(key)
      || selected === DETAILS && key === "executionId";
  }

  onKey(event: TrajectoryJsonKeyEvent): void {
    const selected = businessPath(event.path);
    if (selected === undefined) return;
    if (event.truncated || event.duplicate) this.contentInvalid = true;
    if (selected === BLOCK && event.key !== undefined && !BLOCK_FIELDS.includes(event.key)) this.omit(event.path);
  }

  onValue(event: TrajectoryJsonValueEvent): void {
    const selected = businessPath(event.path);
    if (selected === undefined || selected === "") return;
    const limit = selected === BLOCK_TEXT ? EVAL_RESULT_MAX_BYTES - this.replyChars : MAX_FIELD_CHARS;
    let scalar = event.value;
    if (event.truncated || typeof scalar === "string" && scalar.length > limit
      || typeof scalar === "number" && (!Number.isFinite(scalar)
        || Number.isInteger(scalar) && !Number.isSafeInteger(scalar))) {
      scalar = undefined;
      this.omit(event.path);
    }
    this.types.set(selected, event.type);
    if (scalar !== undefined && selected !== BLOCK_TEXT) this.scalars.set(selected, scalar);
    if (selected === MESSAGE && event.type !== "object") this.contentInvalid = true;
    if (selected === BLOCK) {
      if (event.type !== "object") this.contentInvalid = true;
      else this.blocks[event.path[5] as number] ??= {};
    }
    if (!selected.startsWith(`${BLOCK}.`)) return;
    const block = this.blocks[event.path[5] as number] ??= {};
    const field = event.path[6] as string;
    if (field === "arguments") this.omit(event.path);
    else if (field === "text") {
      if (typeof scalar === "string" && this.interpret === "reply") {
        const bytes = new TextEncoder().encode(scalar).byteLength;
        // An overlong reply/optional metric field stays unknown, not an empty value.
        if (bytes > EVAL_RESULT_MAX_BYTES - this.replyBytes) this.omit(event.path);
        else {
          block.text = scalar;
          this.replyChars += scalar.length;
          this.replyBytes += bytes;
          this.maxReplyCapturedChars = Math.max(this.maxReplyCapturedChars, this.replyChars);
        }
      } else this.omit(event.path);
    } else if (typeof scalar === "string") block[field] = scalar;
  }

  onClose(event: TrajectoryJsonCloseEvent): void {
    const selected = businessPath(event.path);
    if (event.type === "array" && selected === "record.value.model") this.modelCount = event.count;
    if (event.type === "array" && selected === `${MESSAGE}.content`) this.contentCount = event.count;
  }

  /** Only identities, an optional native message's small fields and omission
   * facts survive a large record. Tool body lengths stay unknown, never zero. */
  reducedRecord(receipt: TrajectoryRecordStreamVerification): PiTrajectoryRecordView {
    const scalar = (path: string): JsonValue | undefined => this.scalars.get(path);
    const kind = scalar("record.type") as "entry" | "conversation";
    const id = scalar("record.value.id") as number;
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
          this.omitted.add("/record/value/model");
        } else {
          const message: Record<string, JsonValue> = {};
          for (const field of MESSAGE_FIELDS) {
            const item = scalar(`${MESSAGE}.${field}`);
            if (item !== undefined && field !== "usage" && field !== "content") message[field] = item;
          }
          if (this.types.get(`${MESSAGE}.usage`) === "object") {
            const usage: Record<string, JsonValue> = {};
            for (const field of USAGE_FIELDS) {
              const item = scalar(`${MESSAGE}.usage.${field}`);
              if (item !== undefined) usage[field] = item;
            }
            message.usage = usage;
          }
          if (message.role === "toolResult" && this.types.get(DETAILS) === "object") {
            const path = `${DETAILS}.executionId`;
            if (this.types.has(path)) {
              const item = scalar(path);
              // Keep invalidity without retaining a private source value.
              message.details = { executionId: safeChargeId(item) ? item : null };
            }
          }
          if (this.types.get(`${MESSAGE}.content`) === "array") {
            if (this.contentCount <= MAX_CONTENT_BLOCKS) {
              message.content = this.blocks.slice(0, this.contentCount).map((block) => ({ ...block }));
            } else this.omitted.add("/record/value/model/0/content");
          }
          value.model = [message];
        }
      }
    }
    const write: PiTrajectoryRecordView["record"] = kind === "entry"
      ? { type: "entry", value: { ...value, id,
        conversationId: scalar("record.value.conversationId") as number,
        kind: scalar("record.value.kind") as string } }
      : { type: "conversation", value: { ...value, id } };
    return { ...receipt.metadata, record: write };
  }

  private omit(path: TrajectoryJsonPath): void {
    this.omitted.add(`/${path.join("/")}`);
  }
}

function interpretedStream(source: ReadableStream<Uint8Array>, binding: NativeRecordByteBinding): {
  readonly source: ReadableStream<Uint8Array>;
  readonly binding: TrajectoryRecordStreamBinding;
  connect(): void;
} {
  const interpreter = binding.interpret === undefined ? undefined : new NativeRecordInterpreter(binding.interpret);
  let original = interpreter !== undefined && Number.isSafeInteger(binding.byteLength)
    && binding.byteLength > 0 && binding.byteLength <= MAX_INTERPRETED_BYTES ? new Uint8Array(binding.byteLength) : undefined;
  let buffered = 0;
  const capture = original === undefined ? undefined : new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (original !== undefined && buffered + chunk.byteLength <= original.byteLength) {
        original.set(chunk, buffered);
        buffered += chunk.byteLength;
      }
      controller.enqueue(chunk);
    },
  });
  return { source: capture?.readable ?? source,
    connect() { if (capture !== undefined) void source.pipeTo(capture.writable).catch(() => undefined); },
    binding: {
      identity: binding.identity, byteLength: binding.byteLength, sha256: binding.sha256,
      maxBytes: binding.maxBytes, scope: binding.scope,
      ...(binding.signal === undefined ? {} : { signal: binding.signal }),
      ...(interpreter === undefined ? {} : { observer: interpreter, json: { maxScalarChars: interpreter.maxScalarChars } }),
      async onVerified(receipt) {
        let record: PiTrajectoryRecord | undefined;
        let interpretation: NativeTrajectoryInterpretationEntry["interpretation"] | undefined;
        if (interpreter !== undefined) {
          if (original !== undefined) {
            const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original));
            const checked = evalNativeRecordSchema.shape.record.safeParse(parsed);
            if (!checked.success) {
              throw new NativeRecordStreamError("invalid_envelope", "Invalid raw Pi native interpretation", { cause: checked.error });
            }
            if (!interpreter.hasAmbiguousMessage) record = checked.data as PiTrajectoryRecord;
          }
          if (record !== undefined) {
            const { format: _format, ...view } = record;
            interpretation = { record: view, omittedPaths: [] };
          } else {
            const view = interpreter.reducedRecord(receipt);
            if (!isPiTrajectoryRecordView(view) || spPiTrajectoryRecordIdentity(view) !== receipt.identity) {
              throw new NativeRecordStreamError("invalid_envelope", "Invalid bounded Pi native interpretation");
            }
            interpretation = { record: view, omittedPaths: interpreter.omittedPaths };
          }
        }
        original = undefined;
        await binding.onVerified?.({
          validation: receipt.validation, identity: receipt.identity, byteLength: receipt.byteLength, sha256: receipt.sha256,
          ...receipt.stats,
          ...(binding.interpret === "reply" ? { maxReplyCapturedChars: interpreter!.maxReplyCapturedChars } : {}),
          ...(record === undefined ? {} : { record }),
          ...(interpretation === undefined ? {} : { interpretation, reduced: record === undefined, maxBufferedBytes: buffered }),
        });
      },
    },
  };
}

/**
 * Checks the *entire* original native JSON while passing its bytes through unchanged.
 * A complete EOF, byte count, SHA-256, strict UTF-8, JSON syntax, raw envelope,
 * actor/Chat/native identity, Context/Submission and same-Chat parent must all
 * agree before the returned stream closes successfully. An interrupted transport
 * is never a verified record; consumers must not commit partial blobs/progress.
 */
export function verifiedPiRecordBytes(
  source: ReadableStream<Uint8Array>, binding: NativeRecordByteBinding,
): ReadableStream<Uint8Array> {
  const prepared = interpretedStream(source, binding);
  const verified = verifyEvalNativeRecordStream(prepared.source, prepared.binding);
  prepared.connect();
  return verified;
}

/** Existing v2 evidence format: one original JSON record per JSONL line, with no re-serialization. */
export function verifiedPiJsonlLine(
  source: ReadableStream<Uint8Array>, row: EvalNativeRecordReference,
  options: Omit<NativeRecordByteBinding, "identity" | "byteLength" | "sha256"> & { readonly maxFileBytes: number },
): ReadableStream<Uint8Array> {
  const prepared = interpretedStream(source, { ...options, ...row.reference });
  // JSONL contains *one* original record on *one* line. Whitespace around
  // JSON values is legal, but a literal CR/LF is not a single JSONL record.
  // The newline and successful EOF are emitted only after a complete
  // verified record, never after cancellation or a short transport.
  const verified = verifiedEvalNativeRecordJsonl(prepared.source, row, {
    ...prepared.binding, maxFileBytes: options.maxFileBytes,
  });
  prepared.connect();
  return verified;
}
