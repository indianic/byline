export interface ToolErrorShape {
  ok: false;
  api: string;
  status?: number;
  code: string;
  message: string;
  hint?: string;
}

export type ToolErrorInit = Omit<ToolErrorShape, 'ok'>;

export class ToolError extends Error {
  readonly api: string;
  readonly status?: number;
  readonly code: string;
  readonly hint?: string;

  constructor(init: ToolErrorInit) {
    super(init.message);
    this.name = 'ToolError';
    this.api = init.api;
    this.status = init.status;
    this.code = init.code;
    this.hint = init.hint;
  }

  toJSON(): ToolErrorShape {
    const out: ToolErrorShape = {
      ok: false,
      api: this.api,
      code: this.code,
      message: this.message,
    };
    if (this.status !== undefined) out.status = this.status;
    if (this.hint !== undefined) out.hint = this.hint;
    return out;
  }
}

/** Wrap any thrown value in the error envelope. ToolErrors keep their own api name. */
export function fail(e: unknown, api: string): ToolErrorShape {
  if (e instanceof ToolError) return e.toJSON();
  return {
    ok: false,
    api,
    code: 'UNEXPECTED',
    message: e instanceof Error ? e.message : String(e),
  };
}

export function ok<T extends object>(data: T): T & { ok: true } {
  return { ok: true, ...data };
}
