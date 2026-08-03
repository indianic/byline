import { describe, expect, it } from 'vitest';
import { ToolError, fail, ok } from '../src/errors.js';

describe('ToolError', () => {
  it('serialises to the documented envelope', () => {
    const e = new ToolError({
      api: 'ghost:indianic',
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Ghost rejected the JWT',
      hint: 'Run health_check',
    });
    expect(e.toJSON()).toEqual({
      ok: false,
      api: 'ghost:indianic',
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Ghost rejected the JWT',
      hint: 'Run health_check',
    });
  });

  it('is an Error so it can be thrown and caught', () => {
    const e = new ToolError({ api: 'x', code: 'C', message: 'boom' });
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('boom');
  });
});

describe('fail', () => {
  it('passes a ToolError through unchanged', () => {
    const e = new ToolError({ api: 'ghost:a', code: 'C', message: 'm' });
    expect(fail(e, 'ghost:b').api).toBe('ghost:a');
  });

  it('wraps an unknown error under the supplied api name', () => {
    const r = fail(new Error('socket hang up'), 'gemini');
    expect(r).toEqual({
      ok: false,
      api: 'gemini',
      code: 'UNEXPECTED',
      message: 'socket hang up',
    });
  });

  it('wraps a non-Error throwable', () => {
    expect(fail('nope', 'grok').message).toBe('nope');
  });
});

describe('ok', () => {
  it('tags the payload with ok: true', () => {
    expect(ok({ url: 'https://x' })).toEqual({ ok: true, url: 'https://x' });
  });
});
