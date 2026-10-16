export type VerifyErrorCode =
  | 'INVALID_ARGUMENT'
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'COLLECTION_ERROR'
  | 'NO_TESTS'
  | 'ONLY_IN_CI'
  | 'AUTH_MISSING'
  | 'AUTH_REJECTED'
  | 'API_ERROR'
  | 'SESSION_START_FAILED'
  | 'SESSION_ENDED'
  | 'NOT_AVAILABLE_ON_PLATFORM'
  | 'LOCATOR_NOT_FOUND'
  | 'LOCATOR_AMBIGUOUS'
  | 'ACTION_FAILED'
  | 'ACTION_UNCERTAIN'
  | 'AGENT_STEP_FAILED'
  | 'ASSERTION_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED';

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
