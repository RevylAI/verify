import { deletePersistent, openPersistent } from '@revyl/verify';
import { setTimeout as sleep } from 'node:timers/promises';

const name = 'mac-that-remembers';

const first = await openPersistent(name, { inference: true, timeoutMs: 20 * 60_000 });
console.log(`Run 1, created: ${first.created}`);
try {
  await first.writeFile('hello.swift', 'print("Built in run 1, still here")\n');
  await first.exec(['swiftc', 'hello.swift', '-o', 'hello'], { timeout: 180_000 });
  await first.exec(['open', '-a', 'Safari', 'https://www.saucedemo.com']);
  await sleep(5_000);
  await first.type({ target: 'the Username field on the Swag Labs page' }, 'standard_user');
  await first.type({ target: 'the Password field on the Swag Labs page' }, 'secret_sauce');
  await first.tap({ target: 'the Login button on the Swag Labs page' });
  await sleep(3_000);
  await first.validation('Safari shows the Swag Labs products page');
} finally {
  await first.close();
}

const again = await openPersistent(name, { timeoutMs: 20 * 60_000 });
console.log(`Run 2, created: ${again.created}`);
try {
  console.log(`./hello says: ${(await again.exec(['./hello'])).stdout.trim()}`);
  await again.exec(['open', '-a', 'Safari', 'https://www.saucedemo.com/inventory.html']);
  await sleep(5_000);
  const check = await again.validation('Safari shows the Swag Labs products page, not a login form');
  console.log(`Still signed in: ${check.passed}`);
} finally {
  await again.close();
}

await deletePersistent(name);
