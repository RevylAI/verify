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
  | 'COMPUTER_LIMIT'
  | 'NOT_AVAILABLE_ON_PLATFORM'
  | 'ACTION_FAILED'
  | 'ACTION_UNCERTAIN'
  | 'INSTRUCTION_FAILED'
  | 'VALIDATION_FAILED'
  | 'STEP_FAILED'
  | 'COMMAND_FAILED'
  | 'NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'TIMEOUT';

export type RefusalReason = 'web_runtime_unavailable' | 'web_runtime_not_configured' | 'computer_limit' | 'runtime_unavailable' | 'computer_runtime_unavailable' | 'computer_at_capacity' | 'computer_not_running' | 'computer_cannot_host_platform' | 'computer_not_found' | 'web_build_required' | 'web_build_not_supported' | 'ios_build_required' | 'ios_build_not_supported' | 'android_build_required' | 'android_build_not_supported' | 'web_session_conflict' | 'ios_session_conflict' | 'android_session_conflict' | 'not_available_on_platform';

export class VerifyError extends Error {
  readonly code: VerifyErrorCode;
  readonly reason?: RefusalReason;
  readonly httpStatus?: number;

  constructor(code: VerifyErrorCode, message: string, options?: { cause?: unknown; reason?: RefusalReason; httpStatus?: number }) {
    super(message, options);
    this.name = 'VerifyError';
    this.code = code;
    this.reason = options?.reason;
    this.httpStatus = options?.httpStatus;
  }
}

export function isVerifyError(error: unknown): error is VerifyError {
  return error instanceof Error && typeof (error as Partial<VerifyError>).code === 'string' && error.name === 'VerifyError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
