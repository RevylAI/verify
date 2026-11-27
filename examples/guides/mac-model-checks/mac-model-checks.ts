import { open } from '@revyl/verify';
import { setTimeout as sleep } from 'node:timers/promises';

const mac = await open({ platform: 'mac', inference: true, timeoutMs: 15 * 60_000 });
console.log(`Live view: ${mac.viewerUrl}`);
console.log(`Mac's model: ${mac.inference}`);
try {
  await mac.writeFile('release-notes.txt', 'Release 4.2\nFixed: checkout crash on empty cart\n');
  await mac.exec(['open', '-a', 'TextEdit', 'release-notes.txt']);
  await sleep(3_000);

  const check = await mac.validation('A TextEdit window shows release notes for Release 4.2');
  console.log(`validation: ${check.passed} in ${check.durationMs} ms, engine ${check.engine}`);
  const fix = await mac.extract('the bug fix listed in the TextEdit window');
  console.log(`extract: "${fix.value}" in ${fix.durationMs} ms, engine ${fix.engine}`);
} finally {
  await mac.close();
}
