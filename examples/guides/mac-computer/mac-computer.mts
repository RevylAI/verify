import { open } from '@revyl/verify';
import { setTimeout as sleep } from 'node:timers/promises';

const mac = await open({ platform: 'mac', timeoutMs: 15 * 60_000 });
console.log(`Live view: ${mac.viewerUrl}`);
try {
  await mac.writeFile('hello.swift', 'print("Hello from a cloud Mac")\n');
  await mac.exec(['swiftc', 'hello.swift', '-o', 'hello'], { timeout: 180_000 });
  console.log(`Built and ran hello.swift: ${(await mac.exec(['./hello'])).stdout.trim()}`);

  await mac.writeFile('notes.txt', '');
  await mac.exec(['open', '-a', 'TextEdit', 'notes.txt']);
  await sleep(3_000);
  await mac.type({ target: 'the white text area of the TextEdit window' }, 'Written by an agent on a cloud Mac.');
  await mac.pressKey('s', { modifiers: ['meta'] });
  await sleep(1_000);
  console.log(`notes.txt now says: ${(await mac.readFile('notes.txt')).toString().trim()}`);

  await mac.tap({ target: 'the Format menu in the menu bar' });
  await mac.screenshot({ path: 'mac.png' });
  await mac.pressKey('escape');
} finally {
  await mac.close();
}

const recording = await mac.recording();
console.log(recording ? `Recording saved: ${recording.durationSeconds ?? '?'} s` : 'No recording was saved.');
