import type { StepResult } from './session.js';
import type { SessionProfileOutcome } from './session-profile.js';

export type VerifyErrorCode =
  | 'INVALID_ARGUMENT'
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'AUTH_MISSING'
  | 'COMPUTER_ID_MISSING'
  | 'AUTH_REJECTED'
  | 'EDGE_BLOCKED'
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
  | 'MODEL_ERROR'
  | 'MODEL_KEY_MISSING'
  | 'SESSION_PROFILE_FAILED'
  | 'TIMEOUT';

export type RefusalReason = 'web_runtime_unavailable' | 'web_runtime_not_configured' | 'computer_limit' | 'runtime_unavailable' | 'computer_runtime_unavailable' | 'computer_at_capacity' | 'computer_platform_at_capacity' | 'computer_not_running' | 'computer_cannot_host_platform' | 'computer_not_found' | 'web_build_required' | 'web_build_not_supported' | 'ios_build_required' | 'ios_build_not_supported' | 'android_build_required' | 'android_build_not_supported' | 'web_session_conflict' | 'ios_session_conflict' | 'android_session_conflict' | 'not_available_on_platform' | 'persistent_computers_not_enabled' | 'upgrade_required' | 'request_timeout' | 'protocol_error' | 'session_profile_undefined' | 'session_profile_source_required' | 'session_profile_files_need_named' | 'session_profile_script_unavailable' | 'repository_connection_missing' | 'project_not_found' | 'repository_unavailable' | 'lifetime_unsupported' | 'no_focused_input' | 'computer_local_inference_unavailable' | 'inference_not_enabled' | 'inference_unavailable' | 'step_engine_unavailable';

export class VerifyError extends Error {
  readonly code: VerifyErrorCode;
  readonly reason?: RefusalReason;
  readonly httpStatus?: number;
  /** The failed step on INSTRUCTION_FAILED and VALIDATION_FAILED, with its turns and tokens when it ran on your own model. */
  readonly result?: StepResult;
  /** On SESSION_PROFILE_FAILED: how the profile's run ended, such as 'script_failed'. */
  readonly outcome?: SessionProfileOutcome;
  /** On SESSION_PROFILE_FAILED: Revyl's reason, which never holds a secret or the script's output. */
  readonly failureReason?: string;

  constructor(code: VerifyErrorCode, message: string, options?: { cause?: unknown; reason?: RefusalReason; httpStatus?: number; result?: StepResult; outcome?: SessionProfileOutcome; failureReason?: string }) {
    super(message, options);
    this.name = 'VerifyError';
    this.code = code;
    this.reason = options?.reason;
    this.httpStatus = options?.httpStatus;
    this.result = options?.result;
    this.outcome = options?.outcome;
    this.failureReason = options?.failureReason;
  }
}

export function isVerifyError(error: unknown): error is VerifyError {
  return error instanceof Error && typeof (error as Partial<VerifyError>).code === 'string' && error.name === 'VerifyError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
