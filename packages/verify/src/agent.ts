import type { LiveStepOutput, LiveStepResult, LiveStepType } from './api/types.js';
import { VerifyError } from './errors.js';
import type { RevylSession } from './session.js';
import type { StepRecorder } from './steps.js';

export interface AgentStepOptions {
  /** Milliseconds before the step is cancelled. Defaults to agentTimeout from the config. */
  timeout?: number;
}

export interface AgentContext {
  agentTimeout: number;
  session(): Promise<RevylSession>;
  signal(): AbortSignal | undefined;
  steps: StepRecorder;
}

const MAX_INSTRUCTION_LENGTH = 4_000;

/**
 * Natural-language steps run by Revyl's agent on the live session. Each call asks the model again;
 * Verify does not cache or replay agent decisions between runs.
 */
export class Agent {
  constructor(private readonly context: AgentContext) {}

  /** Performs a multi-step goal described in plain words, such as "add the first product to the cart". */
  async act(instruction: string, options: AgentStepOptions = {}): Promise<void> {
    await this.run('instruction', 'agent.act', instruction, options, (output, result) => {
      if (result.success && output.status !== 'failed') return output.status_reason ?? undefined;
      throw new VerifyError('AGENT_STEP_FAILED', `agent.act could not complete "${instruction}": ${reasonOf(output)}`);
    });
  }

  /** Checks a visual expectation, such as "the cart shows 2 items". Fails the test when it does not hold. */
  async assert(expectation: string, options: AgentStepOptions = {}): Promise<void> {
    await this.run('validation', 'agent.assert', expectation, options, (output, result) => {
      const passed = output.validation_result ?? (result.success && output.status === 'success');
      if (passed === true) return output.reasoning ?? output.status_reason ?? undefined;
      throw new VerifyError('ASSERTION_FAILED', `agent.assert failed: "${expectation}". ${reasonOf(output)}`);
    });
  }

  /** Reads information off the screen, such as "the order number", and returns it as text. */
  async extract(question: string, options: AgentStepOptions = {}): Promise<string> {
    let information = '';
    await this.run('extract', 'agent.extract', question, options, (output, result) => {
      const value = output.extracted_data?.information;
      if (!result.success || output.status === 'failed' || typeof value !== 'string') {
        throw new VerifyError('AGENT_STEP_FAILED', `agent.extract could not answer "${question}": ${reasonOf(output)}`);
      }
      information = value;
      return output.extracted_data?.reasoning ?? undefined;
    });
    return information;
  }

  private async run(
    type: LiveStepType,
    label: string,
    text: string,
    options: AgentStepOptions,
    interpret: (output: LiveStepOutput, result: LiveStepResult) => string | undefined,
  ): Promise<void> {
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_INSTRUCTION_LENGTH) {
      throw new VerifyError('INVALID_ARGUMENT', `${label}() takes a description of 1 to ${MAX_INSTRUCTION_LENGTH} characters.`);
    }
    const timeoutMs = options.timeout ?? this.context.agentTimeout;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
      throw new VerifyError('INVALID_ARGUMENT', `${label}() takes a timeout of at least 1000 ms.`);
    }
    await this.context.steps.run(`${label}: ${text.trim()}`, async (step) => {
      const session = await this.context.session();
      const signal = this.context.signal();
      const result = await session.runStep(type, text.trim(), { timeoutMs, ...(signal ? { signal } : {}) });
      const detail = interpret(result.step_output ?? {}, result);
      if (detail) step.detail = detail;
    });
  }
}

function reasonOf(output: LiveStepOutput): string {
  return output.status_reason ?? output.reasoning ?? output.extracted_data?.reasoning ?? 'Revyl gave no reason.';
}
