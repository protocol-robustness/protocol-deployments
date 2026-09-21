/**
 * Central error type for the deployment configuration resolver.
 *
 * Every validation/parse failure is a ConfigError carrying a stable machine
 * code and a human-readable message. Tests assert on codes, not messages.
 */
export type ErrorCode = string;

export class ConfigError extends Error {
  readonly code: ErrorCode;
  readonly path?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { path?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.path = opts.path;
    this.details = opts.details;
  }
}

export function isConfigError(e: unknown): e is ConfigError {
  return e instanceof ConfigError;
}

/** Normalize any thrown error into a ConfigError if it is not already one. */
export function asConfigError(
  code: ErrorCode,
  e: unknown,
  opts: { path?: string } = {},
): ConfigError {
  if (isConfigError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new ConfigError(code, message, opts);
}
