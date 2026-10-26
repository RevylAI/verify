import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const child = spawn(process.execPath, ['demo.ts', '--mock', '--no-open'], { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
try {
  const deadline = Date.now() + 15_000;
  let address;
  let result;
  while (Date.now() < deadline) {
    address = output.match(/Results: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (address) {
      result = await fetch(`${address}/api/run`).then(response => response.json());
      if (result.status === 'completed') break;
    }
    assert.equal(child.exitCode, null, output);
    await delay(100);
  }
  assert.equal(result?.status, 'completed');
  assert.equal(result.mode, 'mock');
  assert.deepEqual(result.runs.map(run => run.target), ['web', 'ios']);
  for (const run of result.runs) {
    assert.equal(run.status, 'passed');
    assert.equal(run.steps.length, 2);
    assert.ok(run.steps.every(step => step.passed));
    assert.equal(run.recordingUrl, undefined);
    const screenshot = await fetch(`${address}${run.steps[1].screenshotUrl}`);
    assert.equal(screenshot.status, 200);
    assert.match(await screenshot.text(), /Mock screenshot/);
  }
  assert.match(await fetch(address).then(response => response.text()), /MOCK MODE/);
  assert.equal((await fetch(`${address}/missing`)).status, 404);
  assert.equal((await fetch(address, { method: 'POST' })).status, 403);
  console.log('Mock demo: parallel outcomes, screenshots, and loopback routes passed.');
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit');
}
