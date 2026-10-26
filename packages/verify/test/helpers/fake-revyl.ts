import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { RevylClient } from '../../src/api/client.js';

const contract: Record<string, Record<string, unknown>> = JSON.parse(
  readFileSync(new URL('../../../../go/testdata/device-contract.json', import.meta.url), 'utf8'),
);

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: any;
}

type Reply = Response | Promise<Response>;
type Handler = (request: RecordedRequest, match: RegExpMatchArray) => Reply | undefined;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A PNG header with the given dimensions; enough for Verify's PNG check. */
export function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** An in-memory stand-in for Revyl's public API. Unmatched requests fail loudly. */
export class FakeRevyl {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];

  on(method: string, pattern: RegExp, handler: Handler): this {
    this.routes.unshift({ method, pattern, handler });
    return this;
  }

  calls(method: string, pattern: RegExp): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && pattern.test(request.path));
  }

  readonly fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const raw = init?.body;
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : undefined,
    };
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    this.requests.push(request);
    for (const route of this.routes) {
      if (route.method !== request.method) continue;
      const match = request.path.match(route.pattern);
      if (!match) continue;
      const reply = await route.handler(request, match);
      if (reply) return reply;
    }
    return json({ detail: `FakeRevyl has no route for ${request.method} ${request.path}` }, 599);
  };

  client(): RevylClient {
    return new RevylClient({ token: 'test-token', backendUrl: 'https://revyl.test', fetch: this.fetch });
  }

  /** Serves the fake over loopback HTTP, for scripts running in a child process. */
  async serve(): Promise<{ url: string; close(): Promise<void> }> {
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const headers = Object.fromEntries(Object.entries(incoming.headers).map(([name, value]) => [name, String(value)]));
      const body = Buffer.concat(chunks).toString('utf8');
      const response = await this.fetch(`http://127.0.0.1${incoming.url}`, { method: incoming.method ?? 'GET', headers, body });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }
}

export const RUN_ID = 'run-1';
export const SESSION_ID = '11111111-2222-4333-8444-555555555555';
export const APP_ID = '0b6a8c3e-1111-4222-8333-944455556666';
export const BUILD_ID = '9a9a9a9a-1111-4222-8333-944455556666';

const STOP = /^\/api\/v1\/execution\/device\/sessions\/[^/]+\/stop$/;

/** A ready Android device: start, connection, health, screenshot, launch, and stop. */
export function fakeAndroid(fake: FakeRevyl): FakeRevyl {
  return fake
    .on('POST', /^\/api\/v1\/execution\/start_device$/, () =>
      json(contract.androidStart),
    )
    .on('GET', /^\/api\/v1\/execution\/streaming\/worker-connection\/run-1$/, () =>
      json(contract.workerConnection),
    )
    .on('GET', /device-proxy\/run-1\/health$/, () => json(contract.health))
    .on('GET', /device-proxy\/run-1\/screenshot$/, () => new Response(png(1080, 2400), { headers: { 'content-type': 'image/png' } }))
    .on('POST', /device-proxy\/run-1\/launch$/, () => json({ success: true, action: 'launch', latency_ms: 1 }))
    .on('POST', STOP, () => json(contract.stop));
}

/** A web session that becomes ready on its second status poll. */
export function fakeWeb(fake: FakeRevyl): FakeRevyl {
  let polls = 0;
  return fake
    .on('POST', /\/apps\/[^/]+\/builds\/external$/, () => json({ id: BUILD_ID }))
    .on('POST', /^\/api\/v1\/execution\/start_device$/, (request) =>
      json({ ...contract.webStart, session_id: request.body.session_id }),
    )
    .on('GET', /^\/api\/v1\/execution\/device-sessions\/[^/]+$/, () =>
      json(++polls < 2 ? { id: 'x', status: 'starting' } : contract.webReady),
    )
    .on('GET', /device-proxy\/run-1\/screenshot$/, () => new Response(png(1280, 800)))
    .on('POST', STOP, () => json({ success: true, request_accepted: true, session_id: 'x', status: 'stopping', message: '' }));
}

/** A LiveStepResponse as Revyl returns it. step_output is the agent's StepExecutionResult. */
export function stepResult(output: Record<string, unknown>, success = true, stepType = 'instruction'): Record<string, unknown> {
  return {
    ...contract.stepResult,
    success,
    step_type: stepType,
    step_output: output,
  };
}

/** A validation that ran: Revyl reports status 'success' and puts the verdict in validation_result. */
export function verdict(holds: boolean, reason: string): Record<string, unknown> {
  const result = contract[holds ? 'validationPassed' : 'validationFailed']!;
  return { ...result, step_output: { ...(result.step_output as Record<string, unknown>), status_reason: reason } };
}

/** The busy refusal mobile workers and the web live-step adapter both send while a step is queued or running. */
export const STEP_BUSY = { detail: 'A step is already executing. Wait for it to complete before sending another.' };

/** The async live-step contract: execute_step answers 202, then step_status reports running once and then the terminal status. */
export function fakeStep(fake: FakeRevyl, terminal: { status: 'completed' | 'failed' | 'cancelled'; result: Record<string, unknown> }): FakeRevyl {
  let polls = 0;
  return fake
    .on('POST', /execute_step$/, () => json(contract.stepAccepted, 202))
    .on('GET', /step_status\/step-1$/, () =>
      json(++polls < 2 ? contract.stepRunning : { step_id: 'step-1', ...terminal }),
    );
}
