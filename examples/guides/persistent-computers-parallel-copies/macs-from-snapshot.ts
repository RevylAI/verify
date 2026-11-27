import { deletePersistent, deleteSnapshot, isVerifyError, openPersistent, saveSnapshot } from '@revyl/verify';

const run = Date.now().toString(36);
const source = `snapshot-demo-${run}-source`;
const snapshot = `snapshot-demo-${run}-base`;
const copies = [1, 2].map((shard) => `snapshot-demo-${run}-${shard}`);
const unlessMissing = (error: unknown) => {
  if (!isVerifyError(error) || error.code !== 'NOT_FOUND') throw error;
};

try {
  const mac = await openPersistent(source);
  try {
    await mac.writeFile('shard.sh', 'echo "shard $1 ran on $(hostname -s) at $(date +%T)"\n');
  } finally {
    await mac.close();
  }
  console.log('Saving the snapshot (about 5 minutes)...');
  await saveSnapshot(source, snapshot);

  const opened = await Promise.allSettled(copies.map((name) => openPersistent(name, { fromSnapshot: snapshot })));
  try {
    const macs = opened.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    const runs = await Promise.all(macs.map((copy, i) => copy.exec(['/bin/zsh', 'shard.sh', String(i + 1)])));
    runs.forEach((result) => console.log(result.stdout.trim()));
  } finally {
    await Promise.allSettled(opened.map((result) => (result.status === 'fulfilled' ? result.value.close() : undefined)));
  }
} finally {
  const cleanup = await Promise.allSettled([
    ...[source, ...copies].map((name) => deletePersistent(name).catch(unlessMissing)),
    deleteSnapshot(snapshot).catch(unlessMissing),
  ]);
  for (const result of cleanup) if (result.status === 'rejected') console.error(`Cleanup failed: ${result.reason}`);
}
