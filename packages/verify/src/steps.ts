export interface StepRecord {
  title: string;
  status: 'passed' | 'failed';
  durationMs: number;
  detail?: string;
  error?: string;
  steps: StepRecord[];
}

export interface StepHandle {
  detail?: string;
}

/** Records the nested step tree of one test attempt for reporters. */
export class StepRecorder {
  readonly root: StepRecord[] = [];
  private stack: StepRecord[][] = [this.root];

  async run<T>(title: string, body: (step: StepHandle) => Promise<T>): Promise<T> {
    const record: StepRecord = { title, status: 'passed', durationMs: 0, steps: [] };
    const parent = this.stack[this.stack.length - 1] ?? this.root;
    parent.push(record);
    const startedAt = Date.now();
    this.stack.push(record.steps);
    const handle: StepHandle = {};
    try {
      return await body(handle);
    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.stack.pop();
      record.durationMs = Date.now() - startedAt;
      if (handle.detail) record.detail = handle.detail;
    }
  }
}
