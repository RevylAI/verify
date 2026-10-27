import { afterEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { DeviceSession, type Session } from '../src/session.js';
import { screenHasContent } from '../src/screen-readiness.js';
import { validateTarget, type ResolvedDeviceTarget } from '../src/config.js';
import { FakeRevyl, fakeAndroid, json } from './helpers/fake-revyl.js';

function frame(content: boolean): Buffer {
  const image = new PNG({ width: 20, height: 20 });
  image.data.fill(255);
  image.data[0] = 0;
  if (content) image.data[(10 * 20 + 10) * 4] = 0;
  return PNG.sync.write(image);
}

let session: Session | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await session?.close();
  session = undefined;
});

async function open(fake: FakeRevyl, lines: string[] = []): Promise<Session> {
  session = await DeviceSession.start(fake.client(), validateTarget({ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } }) as ResolvedDeviceTarget, { stepTimeout: 5_000, log: line => lines.push(line) });
  return session;
}

describe('best-effort mobile first screen', () => {
  it('ignores status-bar pixels but recognizes central content', () => {
    expect(screenHasContent(frame(false))).toBe(false);
    expect(screenHasContent(frame(true))).toBe(true);
    expect(screenHasContent(Buffer.from('invalid'))).toBeUndefined();
    const oversized = frame(true);
    oversized.writeUInt32BE(16_000_001, 16);
    expect(screenHasContent(oversized)).toBeUndefined();
  });

  it('observes after launch and waits for blank content to change without replaying launch', async () => {
    let attempts = 0;
    const fake = fakeAndroid(new FakeRevyl()).on('GET', /screenshot$/, () => {
      expect(fake.calls('POST', /launch$/)).toHaveLength(1);
      return new Response(frame(++attempts > 1));
    });
    const lines: string[] = [];
    await open(fake, lines);
    expect(attempts).toBe(2);
    expect(lines).not.toContain(expect.stringContaining('debug:'));
  });

  it('continues with a debug note when the ten-second observation window expires', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fake = fakeAndroid(new FakeRevyl()).on('GET', /screenshot$/, () => {
      now += 10_000;
      return new Response(frame(false));
    });
    const lines: string[] = [];
    await open(fake, lines);
    expect(fake.calls('GET', /screenshot$/)).toHaveLength(1);
    expect(lines.some(line => line.includes('debug: best-effort first-screen wait'))).toBe(true);
    expect(session?.closed).toBe(false);
  });

  it.each([401, 500])('does not make optional observation HTTP %i fail open', async status => {
    const fake = fakeAndroid(new FakeRevyl()).on('GET', /screenshot$/, () => json({ error: 'unavailable' }, status));
    const lines: string[] = [];
    await open(fake, lines);
    expect(fake.calls('GET', /screenshot$/)).toHaveLength(1);
    expect(lines.some(line => line.includes('debug:'))).toBe(true);
  });

  it('does not make a malformed PNG or transport failure fail open', async () => {
    for (const reply of [() => new Response('not png'), () => { throw new Error('network'); }]) {
      const fake = fakeAndroid(new FakeRevyl()).on('GET', /screenshot$/, reply);
      await open(fake);
      expect(fake.calls('GET', /screenshot$/)).toHaveLength(1);
      await session!.close();
    }
  });
});
