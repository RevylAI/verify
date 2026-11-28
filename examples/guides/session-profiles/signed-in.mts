import { open } from '@revyl/verify';

const target = { platform: 'web', app: { url: 'https://the-internet.herokuapp.com' } } as const;

const session = await open(target, { profile: 'signed-in' });
console.log(`Live view: ${session.viewerUrl}`);
try {
  await session.validation('The Secure Area page is shown with a Logout button.');
  await session.screenshot({ path: 'secure-area.png' });
} finally {
  await session.close();
}
