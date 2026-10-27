import { open, isVerifyError, type Session, type StepResult, type TargetConfig } from '@revyl/verify';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { collectEvidence, webAppId } from './evidence.ts';

const { values, positionals } = parseArgs({ options: { mock: { type: 'boolean' }, android: { type: 'boolean' }, 'no-open': { type: 'boolean' } }, allowPositionals: true });
const mock = values.mock === true;
const task = positionals.join(' ') || 'Run a cross-platform smoke check';
if (task.length > 200) throw new Error('Keep the task label under 200 characters; edit the plans below to change the steps.');
const root = join(dirname(fileURLToPath(import.meta.url)), '.verify', 'agent-platform', String(Date.now()));
await mkdir(root, { recursive: true, mode: 0o700 });

interface Run {
  target: 'web' | 'ios' | 'android';
  label: string;
  status: 'queued' | 'opening' | 'running' | 'passed' | 'failed';
  phase: string;
  viewerUrl?: string;
  steps: (StepResult & { screenshotUrl?: string })[];
  reportUrl?: string;
  recordingUrl?: string;
  reportJsonUrl?: string;
  error?: string;
  evidenceError?: string;
}
const runs: Run[] = [
  { target: 'web', label: 'Web · task list', status: 'queued', phase: 'Waiting', steps: [] },
  { target: 'ios', label: 'iOS · device settings', status: 'queued', phase: 'Waiting', steps: [] },
  ...(values.android ? [{ target: 'android' as const, label: 'Android · device settings', status: 'queued' as const, phase: 'Waiting', steps: [] }] : []),
];
const state = { mode: mock ? 'mock' : 'live', task, status: 'starting', runs };
const files = new Map<string, { path: string; type: string }>();
const page = await readFile(new URL('./index.html', import.meta.url));
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method !== 'GET' || request.headers.host !== new URL(address).host) {
    response.writeHead(403).end();
    return;
  }
  try {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(page);
    } else if (request.url === '/api/run') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(state));
    } else {
      const file = files.get(request.url ?? '');
      if (!file) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', file.type);
      response.end(await readFile(file.path));
    }
  } catch {
    response.writeHead(500).end('Could not read local evidence');
  }
});
let address = '';
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const bound = server.address();
if (!bound || typeof bound === 'string') throw new Error('Could not start results page');
address = `http://127.0.0.1:${bound.port}`;
console.log(`\nVERIFY / AGENT PLATFORM${mock ? ' / MOCK MODE — no cloud sessions' : ''}\n`);
console.log(`Task: ${task}\nResults: ${address}\n`);
if (!values['no-open']) {
  execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open', [address], { timeout: 10_000 }, error => {
    if (error) console.log('Open the Results link above in your browser.');
  });
}

function plans(target: Run['target']): [string, string][] {
  return target === 'web' ? [
    ['Add a task named Ship the demo to the todo list.', 'The todo list contains an active task named Ship the demo.'],
  ] : [
    [target === 'ios' ? 'Open General, then About.' : 'Open About phone or About device, then scroll or open Android version until the operating system version is visible.', 'The screen shows the operating system version.'],
  ];
}

async function runTarget(run: Run, appId?: string): Promise<void> {
  const directory = join(root, run.target);
  await mkdir(directory, { mode: 0o700 });
  let session: Session | undefined;
  try {
    run.status = 'opening'; run.phase = 'Opening cloud session';
    console.log(`→ ${run.label}: opening`);
    if (!mock) {
      const target: TargetConfig = run.target === 'web'
        ? { platform: 'web', app: { appId: appId!, url: 'https://demo.playwright.dev/todomvc' }, viewport: { width: 1280, height: 800 } }
        : { platform: run.target, app: { bundleId: run.target === 'ios' ? 'com.apple.Preferences' : 'com.android.settings' } };
      session = await open(target, { log: line => {
        const link = line.match(/https:\/\/app\.revyl\.ai\/sessions\/[0-9a-f-]+/i)?.[0];
        if (link && !run.viewerUrl) { run.viewerUrl = link; console.log(`↗ ${run.target}: ${link}`); }
      } });
      run.viewerUrl = session.viewerUrl;
    } else await delay(900);
    run.status = 'running';
    for (const [instruction, validation] of plans(run.target)) {
      for (const [type, text] of [['instruction', instruction], ['validation', validation]] as const) {
        run.phase = `${type}: ${text}`;
        let result: StepResult;
        if (session) result = type === 'instruction' ? await session.instruction(text) : await session.validation(text, { soft: true });
        else { await delay(900); result = { type, text, passed: true, durationMs: 900 }; }
        const step = { ...result, screenshotUrl: `/evidence/${run.target}/${run.steps.length}.png` };
        console.log(`${result.passed ? '✓' : '✗'} ${run.target}: ${type} (${(result.durationMs / 1000).toFixed(1)}s)`);
        const path = join(directory, `${run.steps.length}.png`);
        if (session) { await session.screenshot({ path }); files.set(step.screenshotUrl, { path, type: 'image/png' }); }
        else {
          await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#211a30"/><text x="40" y="210" fill="white" font-size="28">Mock screenshot — no cloud session</text></svg>');
          files.set(step.screenshotUrl, { path, type: 'image/svg+xml' });
        }
        run.steps.push(step);
        if (!result.passed) break;
      }
    }
    run.status = run.steps.every(step => step.passed) ? 'passed' : 'failed';
  } catch (error) {
    run.status = 'failed';
    run.error = isVerifyError(error) ? `Verify: ${error.code}. Inspect the session for details.` : 'Could not run this target. Check the CLI setup and account access.';
    console.log(`✗ ${run.target}: ${run.error}`);
  } finally {
    if (session) {
      try { await session.close(); }
      catch { run.status = 'failed'; run.error = 'Could not confirm session stop. Stop it in Revyl before retrying.'; }
      run.phase = 'Collecting report and recording through the Revyl CLI';
      try {
        const evidence = await collectEvidence(session.id, directory);
        Object.assign(run, evidence);
        if (evidence.hasRecording) {
          run.recordingUrl = `/evidence/${run.target}/recording.mp4`;
          files.set(run.recordingUrl, { path: join(directory, 'recording.mp4'), type: 'video/mp4' });
        }
        if (evidence.reportUrl) {
          run.reportJsonUrl = `/evidence/${run.target}/report.json`;
          files.set(run.reportJsonUrl, { path: join(directory, 'report.json'), type: 'application/json' });
        }
      }
      catch { run.evidenceError = 'Could not collect the report. Open the session in Revyl; no new session was started.'; }
    }
    run.phase = mock ? 'Mock complete — no recording exists' : 'Finished';
  }
}

try {
  const appId = mock ? undefined : await webAppId();
  state.status = 'running';
  await Promise.all(runs.map(run => runTarget(run, appId)));
  state.status = 'completed';
  console.log(`\n${runs.filter(run => run.status === 'passed').length}/${runs.length} targets passed. Results: ${address}`);
  console.log('Results remain available until Ctrl+C. Any stop failure is shown on the page.');
  await writeFile(join(root, 'results.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
} catch {
  server.close();
  console.error('Could not prepare the demo web app. Install the Revyl CLI and check your account/key has web access. No sessions started.');
  process.exitCode = 1;
}
