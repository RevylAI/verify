export type Platform = 'ios' | 'android' | 'web' | 'mac' | 'linux';
export type MobilePlatform = 'ios' | 'android';
export type ComputerPlatform = 'mac' | 'linux';

export interface WebViewportRequest {
  width?: number;
  height?: number;
  device_scale_factor?: number;
}

export interface WebSignInRequest {
  path: string;
  secret_name: string;
  persona?: string;
}

export interface StartDeviceRequest {
  platform: MobilePlatform | 'web';
  is_simulation?: boolean;
  session_id?: string;
  app_id?: string;
  build_id?: string;
  app_url?: string;
  device_model?: string;
  os_version?: string;
  idle_timeout_seconds?: number;
  web?: { viewport?: WebViewportRequest; sign_in?: WebSignInRequest };
}

export interface StartDeviceResponse {
  status: string;
  platform: string;
  session_id?: string | null;
  workflow_run_id?: string | null;
  error?: string | null;
  message?: string | null;
  trace_id?: string | null;
}

export type SessionStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'verifying'
  | 'stopping'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface DeviceSessionDetail {
  id: string;
  status: SessionStatus | string;
  platform?: string | null;
  workflow_run_id?: string | null;
  viewer_kind?: string | null;
  error_message?: string | null;
  screen_width?: number | null;
  screen_height?: number | null;
}

export interface WorkerConnection {
  status: 'ready' | 'not_ready' | 'cancelled' | 'stopped' | 'failed';
  workflow_run_id: string;
  worker_ws_url?: string | null;
  message?: string | null;
}

export interface WorkerHealth {
  status?: string;
  device_connected?: boolean;
  platform?: string;
  screen_width?: number;
  screen_height?: number;
}

export interface DeviceSessionStopResponse {
  success: boolean;
  request_accepted: boolean;
  session_id: string;
  status: string;
  message: string;
}

export interface AppResponse {
  id: string;
  name?: string | null;
  platform?: string | null;
  default_branch_id?: string | null;
}

export interface BuildResponse {
  id?: string | null;
  app_id?: string | null;
  artifact_kind?: string | null;
  version?: string | null;
}

export interface BuildPage {
  items: BuildResponse[];
}

export interface WhoAmI {
  user_id?: string | null;
  org_id?: string | null;
  org_name?: string | null;
  email?: string | null;
}

export interface WorkerActionResult {
  success: boolean;
  action?: string;
  error?: string | null;
}

export type LiveStepType = 'instruction' | 'validation';

export interface LiveStepOutput {
  status?: 'success' | 'warning' | 'failed' | null;
  status_reason?: string | null;
  /** The verdict of a validation step. Revyl reports a validation that ran as status 'success', whatever its verdict. */
  validation_result?: boolean | null;
  reasoning?: string | null;
}

export interface LiveStepResult {
  success: boolean;
  step_type: LiveStepType | string;
  step_id: string;
  workflow_run_id?: string | null;
  session_id?: string | null;
  step_output: LiveStepOutput;
}

/** HTTP 202 from execute_step: the step runs asynchronously; poll step_status/{step_id}. */
export interface StepAccepted {
  step_id: string;
  status: 'accepted';
}

export interface StepStatus {
  step_id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  /** Present once the status is terminal. */
  result?: LiveStepResult | null;
}

export interface ComputerRunCreate {
  computer_session_id: string;
  os: 'macos' | 'linux';
}

export type ComputerState = 'starting' | 'active' | 'closing' | 'stopped' | 'failed' | 'owner_lost';

/** The fields Verify reads from a ComputerReport. */
export interface ComputerReport {
  computer_session_id: string;
  state: ComputerState;
  release: 'pending' | 'confirmed' | 'unknown';
  failure_reason?: string | null;
}

export interface ComputerProcessHandle {
  computer_session_id: string;
  handle_id: string;
}

/** Binary fields are base64. */
export type ComputerCommand = { timeout_ms: number } & (
  | { kind: 'exec'; argv: string[]; stdin?: string }
  | { kind: 'file_read'; path: string }
  | { kind: 'file_write'; path: string; data: string }
  | { kind: 'file_stat'; path: string }
  | { kind: 'process_list' }
  | { kind: 'process_terminate'; handle: ComputerProcessHandle }
);

export interface ComputerExecResult {
  kind: 'exec';
  exit_code: number;
  stdout?: string;
  stderr?: string;
}

export type ComputerResult =
  | ComputerExecResult
  | { kind: 'file_read'; data: string }
  | { kind: 'file_write'; byte_count: number }
  | { kind: 'file_stat'; file_kind: 'file' | 'directory'; size_bytes: number }
  | { kind: 'process_list'; processes: Array<{ handle: ComputerProcessHandle; state: 'running' | 'exited'; exit_code?: number | null }> }
  | { kind: 'process_terminate'; termination: 'confirmed' };

export type ComputerExecution =
  | { outcome: 'succeeded'; result: ComputerResult }
  | { outcome: 'failed'; error_code: 'not_found' | 'access_denied' | 'exec_nonzero'; result?: ComputerExecResult | null }
  | { outcome: 'timed_out'; error_code: 'timed_out'; termination: 'confirmed' | 'unknown'; observed_exit_code?: number | null }
  | { outcome: 'unknown'; error_code: string; termination: 'confirmed' | 'unknown' };

export interface ComputerCommandResponse {
  computer_session_id: string;
  operation_id: string;
  execution: ComputerExecution;
  evidence: 'recorded' | 'pending' | 'failed';
}

export interface ComputerScreenshot {
  width: number;
  height: number;
  /** Standard base64. */
  png: string;
}
