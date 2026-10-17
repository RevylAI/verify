import { open } from '@revyl/verify';

const session = await open('web');
try {
  await session.screenshot({ path: '.verify/sign-in.png' });
  // Sauce Demo publishes these practice credentials on its sign-in page.
  await session.instruction('Sign in with username standard_user and password secret_sauce');
  await session.validation('A list of products is shown');
  await session.instruction('Add the Sauce Labs Backpack to the cart, then open the cart');
  await session.validation('The cart lists the Sauce Labs Backpack and nothing else');
  await session.screenshot({ path: '.verify/cart.png' });
} finally {
  await session.close();
}
