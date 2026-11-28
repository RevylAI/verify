import assert from 'node:assert/strict';
import { open } from '@revyl/verify';

const session = await open('mac');
try {
  const system = await session.exec(['uname', '-s']);
  assert.equal(system.stdout.trim(), 'Darwin');

  const content = 'Hello from Verify!\n';
  await session.writeFile('hello.txt', content);
  const bytes = await session.readFile('hello.txt');
  assert.equal(bytes.toString('utf8'), content);
  assert.deepEqual(await session.stat('hello.txt'), { kind: 'file', size: Buffer.byteLength(content) });

  const result = await session.exec(['cat', 'hello.txt']);
  assert.equal(result.stdout, content);
  console.log('Mac workspace commands and file round trip passed.');
} finally {
  await session.close();
}
