import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const exec = promisify(execFile);
const appName = 'Verify Agent Platform Demo';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected CLI response');
  return value as Record<string, unknown>;
}

export async function cli(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await exec('revyl', [...args, '--json'], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return object(JSON.parse(stdout));
}

export function httpsUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('Invalid evidence URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid evidence URL');
  return url.href;
}

export async function webAppId(): Promise<string> {
  const result = await cli(['app', 'list', '--platform', 'web', '--search', appName]);
  if (!Array.isArray(result.apps) || typeof result.total !== 'number' || result.total > result.apps.length) {
    throw new Error('Could not completely list demo apps');
  }
  const matches = result.apps.map(object).filter(app => app.name === appName && app.platform === 'web');
  if (matches.length > 1) throw new Error('Multiple demo apps have the same name');
  if (!matches.length) console.log('Creating the reusable web app: Verify Agent Platform Demo');
  const app = matches[0] ?? await cli(['app', 'create', '--name', appName, '--platform', 'web']);
  if (app.name !== appName || app.platform !== 'web' || typeof app.id !== 'string' || !uuid.test(app.id)) {
    throw new Error('Unexpected demo app response');
  }
  return app.id;
}

export async function collectEvidence(sessionId: string, directory: string): Promise<{ reportUrl?: string; hasRecording?: boolean; evidenceError?: string }> {
  const deadline = Date.now() + 120_000;
  let reportUrl: string | undefined;
  while (Date.now() < deadline) {
    let report: Record<string, unknown>;
    try {
      report = await cli(['device', 'report', '--session-id', sessionId]);
    } catch (error) {
      const stderr = object(error).stderr;
      if (typeof stderr !== 'string' || !/404|502|503|504|no report/i.test(stderr)) throw new Error('CLI report failed; check Revyl authentication and access');
      await delay(5_000);
      continue;
    }
    if (report.session_id !== sessionId) throw new Error('Report does not match the session');
    reportUrl = httpsUrl(report.report_url);
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    const videoUrl = httpsUrl(report.video_url);
    if (videoUrl) {
      const response = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error('Could not download recording');
      let bytes = 0;
      await pipeline(Readable.fromWeb(response.body), new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > 250 * 1024 * 1024 ? new Error('Recording exceeds 250 MiB') : null, chunk);
        },
      }), createWriteStream(join(directory, 'recording.mp4'), { mode: 0o600 }));
      return { reportUrl, hasRecording: true };
    }
    await delay(5_000);
  }
  return { reportUrl, evidenceError: 'Recording is still processing. Open the report later; no session was restarted.' };
}
