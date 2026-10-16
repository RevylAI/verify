import { RevylClient } from '../../src/api/client.js';

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

/** A PNG header with the given dimensions; enough for Verify's size probe. */
export function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** An in-memory stand-in for Revyl's public API. Unmatched requests fail the test loudly. */
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
      body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
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
}

export const RUN_ID = 'run-1';
export const SESSION_ID = '11111111-2222-4333-8444-555555555555';
export const APP_ID = '0b6a8c3e-1111-4222-8333-944455556666';
export const BUILD_ID = '9a9a9a9a-1111-4222-8333-944455556666';

export interface AndroidNodeSpec {
  text?: string;
  desc?: string;
  id?: string;
  cls?: string;
  bounds: [number, number, number, number];
  enabled?: boolean;
}

export function androidXml(nodes: AndroidNodeSpec[]): string {
  const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const children = nodes
    .map(
      (node) =>
        `<node text="${escape(node.text ?? '')}" content-desc="${escape(node.desc ?? '')}" resource-id="${node.id ?? ''}" class="${node.cls ?? 'android.widget.TextView'}" enabled="${node.enabled === false ? 'false' : 'true'}" bounds="[${node.bounds[0]},${node.bounds[1]}][${node.bounds[2]},${node.bounds[3]}]" />`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">${children}</node></hierarchy>`;
}

export interface StepScript {
  type?: string;
  reply: (request: RecordedRequest) => Response;
}

/** Wires a ready Android device: start, connection, health, hierarchy, actions, live steps, and stop. */
export function fakeAndroid(fake: FakeRevyl, screen: { nodes: AndroidNodeSpec[] }): FakeRevyl {
  const proxy = (action: string): RegExp => new RegExp(`^/api/v1/execution/device-proxy/${RUN_ID}/${action}$`);
  return fake
    .on('POST', /^\/api\/v1\/execution\/start_device$/, () =>
      json({ status: 'starting', platform: 'android', session_id: SESSION_ID, workflow_run_id: RUN_ID }),
    )
    .on('GET', /^\/api\/v1\/execution\/streaming\/worker-connection\/run-1$/, () =>
      json({ status: 'ready', workflow_run_id: RUN_ID, worker_ws_url: 'wss://worker.test' }),
    )
    .on('GET', proxy('health'), () => json({ status: 'ok', device_connected: true, screen_width: 1080, screen_height: 2400 }))
    .on('GET', proxy('hierarchy'), () => new Response(androidXml(screen.nodes)))
    .on('GET', proxy('screenshot'), () => new Response(png(1080, 2400), { headers: { 'content-type': 'image/png' } }))
    .on('POST', /^\/api\/v1\/execution\/device-proxy\/run-1\/(tap|input|swipe|launch|kill_app|back|key|open_url|double_tap|longpress)$/, (request) =>
      json({ success: true, action: request.path.split('/').pop(), latency_ms: 1 }),
    )
    .on('POST', /^\/api\/v1\/execution\/device\/sessions\/[^/]+\/stop$/, () =>
      json({ success: true, request_accepted: true, session_id: SESSION_ID, status: 'stopping', message: 'ok' }),
    );
}

export function stepResult(output: Record<string, unknown>, success = true): Record<string, unknown> {
  return { success, step_type: 'instruction', step_id: 'step-1', session_id: SESSION_ID, step_output: output };
}
