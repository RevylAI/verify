import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectEvidence } from './evidence.ts';

test('recording failures preserve the collected report without leaving a partial video', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-evidence-'));
  const previousPath = process.env.PATH;
  const report = { session_id: 'fake-session', report_url: 'https://example.invalid/report', video_url: 'https://example.invalid/recording' };
  await writeFile(join(directory, 'revyl'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(report))});\n`, { mode: 0o700 });
  process.env.PATH = `${directory}:${previousPath}`;
  try {
    for (const failure of ['http', 'stream', 'network']) {
      await t.test(failure, async t => {
        t.mock.method(globalThis, 'fetch', async () => {
          if (failure === 'network') throw new Error('untrusted provider details');
          if (failure === 'http') return new Response(null, { status: 503 });
          return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
            pull(controller) { controller.error(new Error('untrusted provider details')); },
          }));
        });
        await writeFile(join(directory, 'recording.mp4'), 'partial');
        const result = await collectEvidence(report.session_id, directory);
        assert.equal(result.reportUrl, report.report_url);
        assert.equal(result.hasRecording, undefined);
        assert.match(result.evidenceError, /Recording could not be downloaded/);
        assert.doesNotMatch(result.evidenceError, /untrusted provider details/);
        assert.deepEqual(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')), report);
        await assert.rejects(readFile(join(directory, 'recording.mp4')), { code: 'ENOENT' });
      });
    }
    await t.test('successful download', async t => {
      t.mock.method(globalThis, 'fetch', async () => new Response('video'));
      assert.deepEqual(await collectEvidence(report.session_id, directory), { reportUrl: report.report_url, hasRecording: true });
      assert.equal(await readFile(join(directory, 'recording.mp4'), 'utf8'), 'video');
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
