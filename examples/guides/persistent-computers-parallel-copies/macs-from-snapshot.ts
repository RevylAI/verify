import { deletePersistent, deleteSnapshot, openPersistent, saveSnapshot } from '@revyl/verify';

const copies = ['snapshot-demo-1', 'snapshot-demo-2'];

const source = await openPersistent('snapshot-demo-source');
try {
  await source.writeFile('shard.sh', 'echo "shard $1 ran on $(hostname -s) at $(date +%T)"\n');
} finally {
  await source.close();
}
console.log('Saving the snapshot (about 5 minutes)...');
await saveSnapshot('snapshot-demo-source', 'snapshot-demo-base');
await deletePersistent('snapshot-demo-source');

const opened = await Promise.allSettled(copies.map((name) => openPersistent(name, { fromSnapshot: 'snapshot-demo-base' })));
try {
  const macs = opened.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  const runs = await Promise.all(macs.map((mac, i) => mac.exec(['/bin/zsh', 'shard.sh', String(i + 1)])));
  runs.forEach((run) => console.log(run.stdout.trim()));
} finally {
  for (const result of opened) if (result.status === 'fulfilled') await result.value.close();
  for (const name of copies) await deletePersistent(name).catch(() => undefined);
  await deleteSnapshot('snapshot-demo-base');
}
