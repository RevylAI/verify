export type Platform = 'ios' | 'android' | 'web';
export type MobilePlatform = Exclude<Platform, 'web'>;

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
  platform: Platform;
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
