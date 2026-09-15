import { test, expect } from '@playwright/test';
test('first administrator and password changes work in the browser',async ({page,browser})=>{
 test.skip(process.env.E2E_SETUP !== '1','Run with E2E_SETUP=1 against a fresh setup fixture');
 await page.goto('/');
 await expect(page.getByRole('heading',{name:'Create your administrator'})).toBeVisible();
 await page.getByLabel('Email address').fill('owner@example.test');
 await page.getByLabel('Password',{exact:true}).fill('browser-owner-password');
 await page.getByLabel('Confirm password',{exact:true}).fill('browser-owner-password');
 await page.getByLabel('Installation token').fill('browser-installation-token-1234567890');
 await page.getByRole('button',{name:'Create administrator',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();
 await page.getByLabel('Password',{exact:true}).fill('browser-owner-password');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('link',{name:'Account',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Change password',exact:true})).toBeVisible();
 const other=await browser.newContext({baseURL:new URL(page.url()).origin});
 try {
  const login=await other.request.post('/api/v1/auth/login',{data:{email:'owner@example.test',password:'browser-owner-password'}});expect(login.status()).toBe(200);
  await page.getByLabel('Current password',{exact:true}).fill('wrong-password');
  await page.getByLabel('New password',{exact:true}).fill('updated-browser-password');
  await page.getByLabel('Confirm new password',{exact:true}).fill('updated-browser-password');
  await page.getByRole('button',{name:'Change password',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Current password is incorrect');
  await page.getByLabel('Current password',{exact:true}).fill('browser-owner-password');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/account-mobile.png',fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Change password',exact:true}).click();
  await expect(page.getByText('Password changed. Sign in with your new password.')).toBeVisible();
  expect((await other.request.get('/api/v1/auth/session')).status()).toBe(401);
  await page.getByLabel('Email address').fill('owner@example.test');
  await page.getByLabel('Password',{exact:true}).fill('updated-browser-password');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Account',exact:true})).toBeVisible();
 } finally {await other.close();}
});
