const { _electron: electron } = require('playwright-core');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { request } = require('../desktop/network.cjs');
const { ComputeWorker } = require('../desktop/worker.cjs');
const { mockGoogle } = require('./oauth-fixture.cjs');

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fastcompute-ui-'));
  const executable = process.env.FASTCOMPUTE_TEST_EXE;
  let app;
  let worker;
  try {
    const env = { ...process.env, FASTCOMPUTE_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    env.FASTCOMPUTE_GOOGLE_CLIENT_ID = 'ui-test.apps.googleusercontent.com';
    env.FASTCOMPUTE_GOOGLE_CLIENT_SECRET = 'test-only-not-a-real-client';
    app = await electron.launch({
      ...(executable ? { executablePath: path.resolve(executable) } : {}),
      args: executable ? [] : [path.resolve('.')],
      env, timeout: 40000
    });
    const page = await app.firstWindow();
    const makeToken = await mockGoogle(app);
    await page.waitForSelector('#local-name', { state: 'attached' });
    await page.waitForFunction(() => document.querySelector('#host-name').value.length > 0);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    assert.equal(await page.title(), 'FastCompute');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');
    await page.locator('#google-signin').click();
    assert.equal(await page.locator('#google-setup').getAttribute('open'), '');
    await page.locator('[data-page="network"]').click();
    await page.locator('#host-name').fill('Studio coordinator');
    await page.locator('#host-form button').click();
    await page.locator('#connected-panel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#header-balance').textContent(), '0');
    await page.locator('#google-signin').click();
    await page.waitForFunction(() => document.querySelector('#google-button-text').textContent === 'Studio owner');
    assert.equal(await page.locator('#header-balance').textContent(), '10,000');
    await page.locator('#public-url').fill('https://127.0.0.1:48721');
    await page.locator('#create-invite').click();
    await page.locator('#created-invite').waitFor({ state: 'visible' });
    const { parseInvite } = require('../desktop/network.cjs');
    const invitation = parseInvite(await page.locator('#created-invite').inputValue());
    const joined = await request(invitation, '/join', { name: 'Render studio' });
    const peer = { ...invitation, token: joined.token };
    const challenge = await request(peer, '/auth/challenge', {});
    await request(peer, '/google', { idToken: makeToken(challenge.nonce, 'ui-provider') });
    worker = new ComputeWorker(peer, message => errors.push(message));
    await worker.start({ name: 'Studio CPU', kind: 'cpu', cores: 1, ramMb: 64, rate: 100000 });
    await page.locator('[data-page="market"]').click();
    await page.locator('.machine-card').waitFor();
    await page.locator('#ram-filter').selectOption('1024');
    assert.equal(await page.locator('.machine-card').count(), 0);
    await page.locator('#reset-filters').click();
    await page.locator('#price-max-number').fill('99');
    assert.equal(await page.locator('.machine-card').count(), 0);
    await page.locator('#price-max-number').fill('100');
    assert.equal(await page.locator('.machine-card').count(), 1);
    await page.locator('[data-filter="gpu"]').click();
    assert.equal(await page.locator('.machine-card').count(), 0);
    await page.locator('#reset-filters').click();
    const screenshot = process.env.FASTCOMPUTE_SCREENSHOT;
    if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
    await page.locator('[data-rent]').click();
    await page.locator('#rent-seconds').fill('5');
    assert.match(await page.locator('#rent-quote').textContent(), /0\.139/);
    await page.locator('#rent-form button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('.job-status')?.textContent === 'completed', null, { timeout: 30000 });
    assert.match(await page.locator('.job-result').textContent(), /PBKDF2-SHA256/);
    await page.locator('[data-page="wallet"]').click();
    await page.waitForFunction(() => document.querySelector('#wallet-balance').textContent.replaceAll(',', '') === '9999.861');
    await worker.stop();

    // The packaged app itself must execute a worker, not just rent from a Node test peer.
    await page.locator('[data-page="sharing"]').click();
    await page.locator('#hardware-name').fill('Desktop provider CPU');
    await page.locator('#cores').fill('1');
    await page.locator('#ram').fill('64');
    await page.locator('#share-button').click();
    await page.waitForFunction(() => document.querySelector('#sharing-state').textContent === 'READY FOR JOBS');
    const listings = await request(peer, '/state', undefined, 'GET');
    const desktop = listings.offers.find(o => o.name === 'Desktop provider CPU');
    assert.ok(desktop);
    const job = await request(peer, '/rent', { offerId: desktop.id, seconds: 5 });
    let completed;
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      completed = (await request(peer, '/state', undefined, 'GET')).jobs.find(j => j.id === job.id);
      if (['failed', 'completed', 'cancelled'].includes(completed.status)) break;
    }
    assert.equal(completed.status, 'completed', completed.result);
    await page.locator('[data-page="sharing"]').click();
    await page.locator('#pause-button').click();
    await page.waitForFunction(() => document.querySelector('#sharing-state').textContent === 'SHARING PAUSED');
    await page.locator('[data-page="market"]').click();
    assert.deepEqual(errors, []);
    assert.equal(await page.locator('#error-banner').isVisible(), false);
    await page.setViewportSize({ width: 1050, height: 720 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.locator('[data-page="network"]').click();
    await page.locator('#sign-out').click();
    await page.waitForFunction(() => document.querySelector('#header-balance').textContent === '0');
    await page.locator('#google-signin').click();
    await page.waitForFunction(() => document.querySelector('#google-button-text').textContent === 'Studio owner');
    assert.equal(await page.locator('#header-balance').textContent(), '10,000');
    console.log('PASS: light UI, mandatory mocked Google login, filters, per-person 10,000 CU, real jobs, sign-out/re-login without regrant, and narrow layout.');
  } finally {
    if (worker) await worker.close();
    if (app) await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
