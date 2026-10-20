export type VerifyErrorCode =
  | 'INVALID_ARGUMENT'
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'AUTH_MISSING'
  | 'AUTH_REJECTED'
  | 'API_ERROR'
  | 'SESSION_START_FAILED'
  | 'SESSION_ENDED'
  | 'SESSION_BUSY'
  | 'NOT_AVAILABLE_ON_PLATFORM'
  | 'ACTION_FAILED'
  | 'ACTION_UNCERTAIN'
  | 'INSTRUCTION_FAILED'
  | 'VALIDATION_FAILED'
  | 'STEP_FAILED'
  | 'TIMEOUT';

export class VerifyError extends Error {
  readonly code: VerifyErrorCode;

  constructor(code: VerifyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VerifyError';
    this.code = code;
  }
}

export function isVerifyError(error: unknown): error is VerifyError {
  return error instanceof Error && typeof (error as Partial<VerifyError>).code === 'string' && error.name === 'VerifyError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
