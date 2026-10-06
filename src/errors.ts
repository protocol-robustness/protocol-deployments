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
