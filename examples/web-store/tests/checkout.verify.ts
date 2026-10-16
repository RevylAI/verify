import { expect, test } from '@revyl/verify';

test.beforeEach(async ({ screen }) => {
  // Sauce Demo publishes these credentials on its sign-in page for anyone to use.
  await screen.getByRole('textbox', { name: 'Username' }).fill('standard_user');
  await screen.getByRole('textbox', { name: 'Password' }).fill('secret_sauce');
  await screen.getByRole('button', { name: 'Login' }).tap();
  await expect(screen.getByText('Products')).toBeVisible({ timeout: 20_000 });
});

test('a shopper can add a backpack to the cart', async ({ screen }) => {
  await screen.locate('the "Add to cart" button under Sauce Labs Backpack').tap();
  await expect(screen.locate('the shopping cart icon showing a badge with the number 1')).toBeVisible();
  await screen.locate('the shopping cart icon in the top right corner').tap();
  await expect(screen.getByText('Your Cart')).toBeVisible();
  await expect(screen.getByText('Sauce Labs Backpack')).toBeVisible();
});

test('a shopper can sort products by price', async ({ screen, app }) => {
  await screen.locate('the product sort dropdown in the top right').tap();
  await screen.getByText('Price (low to high)').tap();
  await expect(screen.locate('Sauce Labs Onesie as the first product in the list')).toBeVisible();
  await app.screenshot('sorted-by-price');
});
