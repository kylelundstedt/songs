export type ReadModelErrorCode =
  | "GIT_COMMAND_FAILED"
  | "SOURCE_REF_DRIFT"
  | "EVIDENCE_REF_DRIFT"
  | "CONTRACT_INVALID"
  | "CONTRACT_HASH_DRIFT"
  | "SOURCE_HASH_DRIFT"
  | "SOURCE_BYTES_DRIFT"
  | "INVALID_UTF8"
  | "FRONT_MATTER_INVALID"
  | "DOCUMENT_ID_MISSING"
  | "DOCUMENT_ID_DUPLICATE"
  | "DOCUMENT_ID_DRIFT"
  | "SLUG_ROUTE_DRIFT"
  | "TITLE_MISSING"
  | "SET_ENTRY_INVALID"
  | "SET_ENTRY_ID_DUPLICATE"
  | "SET_ENTRY_CONTRACT_DRIFT"
  | "SET_SECTION_INVALID"
  | "TARGET_MISSING";

export interface ReadModelErrorContext {
  readonly path?: string;
  readonly line?: number;
  readonly id?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly detail?: string;
}

export class ReadModelError extends Error {
  readonly code: ReadModelErrorCode;
  readonly context: ReadModelErrorContext;

  constructor(code: ReadModelErrorCode, message: string, context: ReadModelErrorContext = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ReadModelError";
    this.code = code;
    this.context = context;
  }
}

export function fail(code: ReadModelErrorCode, message: string, context: ReadModelErrorContext = {}): never {
  throw new ReadModelError(code, message, context);
}

export function asReadModelError(error: unknown): ReadModelError {
  if (error instanceof ReadModelError) return error;
  if (error instanceof Error) {
    return new ReadModelError("CONTRACT_INVALID", error.message, {}, error);
  }
  return new ReadModelError("CONTRACT_INVALID", String(error));
}
