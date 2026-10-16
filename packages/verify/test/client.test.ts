import { describe, expect, it } from 'vitest';
import { RevylClient } from '../src/api/client.js';
import { FakeRevyl, json } from './helpers/fake-revyl.js';

describe('RevylClient', () => {
  it('identifies itself as Verify on every request', async () => {
    const fake = new FakeRevyl().on('GET', /get_user_uuid/, () => json({ email: 'dev@example.com' }));
    await fake.client().whoAmI();
    const [request] = fake.requests;
    expect(request?.headers.get('authorization')).toBe('Bearer test-token');
    expect(request?.headers.get('x-revyl-client')).toBe('verify');
    expect(request?.headers.get('user-agent')).toMatch(/^revyl-verify\/\d+\.\d+\.\d+ node\//);
  });

  it('retries a read after a gateway error', async () => {
    let calls = 0;
    const fake = new FakeRevyl().on('GET', /get_user_uuid/, () => (++calls < 2 ? json({}, 503) : json({ email: 'ok' })));
    expect(await fake.client().whoAmI()).toEqual({ email: 'ok' });
    expect(calls).toBe(2);
  });

  it('never retries a device action, even after a gateway error', async () => {
    const fake = new FakeRevyl().on('POST', /device-proxy\/run-1\/input/, () => json({ detail: 'busy' }, 503));
    const response = await fake.client().worker('run-1', 'input', { method: 'POST', body: { text: 'x', x: 1, y: 1 } });
    expect(response.status).toBe(503);
    expect(fake.calls('POST', /input/)).toHaveLength(1);
    expect(fake.requests[0]?.headers.get('x-revyl-agent')).toBe('Verify');
  });

  it('turns 401 into an actionable auth error', async () => {
    const fake = new FakeRevyl().on('GET', /get_user_uuid/, () => json({ detail: 'Invalid token' }, 401));
    await expect(fake.client().whoAmI()).rejects.toMatchObject({ code: 'AUTH_REJECTED', message: expect.stringContaining('REVYL_API_KEY') });
  });

  it('refuses a plain-HTTP backend that is not loopback', () => {
    expect(() => new RevylClient({ token: 't', backendUrl: 'http://backend.example.com' })).toThrow('HTTPS');
    expect(() => new RevylClient({ token: 't', backendUrl: 'http://127.0.0.1:8000' })).not.toThrow();
  });
});
