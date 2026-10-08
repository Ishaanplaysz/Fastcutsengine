const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store, INITIAL_CREDITS, startHub, request } = require('../desktop/network.cjs');
const { verifyToken, signIn } = require('../desktop/google.cjs');
const { filterHosts } = require('../ui/market.js');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] };
const claims = { iss: 'https://accounts.google.com', aud: 'test-client', sub: 'person-1', email: 'tester@example.test', email_verified: true, name: 'Test person', nonce: 'challenge', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
function jwt(payload = claims) {
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}
test('Google tokens require signature, issuer, audience, expiry, verified email and nonce', () => {
  assert.equal(verifyToken(jwt(), 'test-client', 'challenge', jwks).sub, 'person-1');
  for (const change of [{ aud: 'wrong-client' }, { iss: 'evil' }, { exp: 1 }, { nonce: 'replay' }, { email_verified: false }, { sub: '' }, { iat: claims.exp + 500 }]) {
    assert.throws(() => verifyToken(jwt({ ...claims, ...change }), 'test-client', 'challenge', jwks));
  }
  assert.throws(() => verifyToken(jwt().slice(0, -10) + 'invalid', 'test-client', 'challenge', jwks));
});
test('OAuth browser flow uses state, nonce, PKCE, loopback and verified identity (mock Google)', async () => {
  const originalFetch = global.fetch;
  let auth;
  global.fetch = async (url, options) => {
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json(jwks);
    if (url === 'https://oauth2.googleapis.com/token') {
      const params = options.body;
      assert.equal(crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url'), auth.searchParams.get('code_challenge'));
      assert.equal(params.get('redirect_uri'), auth.searchParams.get('redirect_uri'));
      assert.equal(params.get('code'), 'one-time-code');
      return Response.json({ id_token: jwt() });
    }
    return originalFetch(url, options);
  };
  try {
    const token = await signIn({ clientId: 'test-client', clientSecret: 'test-only', nonce: 'challenge', openBrowser: async url => {
      auth = new URL(url);
      assert.equal(auth.origin, 'https://accounts.google.com');
      assert.equal(auth.searchParams.get('nonce'), 'challenge');
      assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname, '127.0.0.1');
      callback.searchParams.set('state', 'wrong');
      assert.equal((await originalFetch(callback)).status, 400);
      callback.searchParams.set('state', auth.searchParams.get('state'));
      callback.searchParams.set('code', 'one-time-code');
      assert.equal((await originalFetch(callback)).status, 200);
    } });
    assert.equal(verifyToken(token, 'test-client', 'challenge', jwks).sub, 'person-1');
  } finally { global.fetch = originalFetch; }
});
test('one Google allowance across devices and repeated logins; legacy upgrade only once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-wallet-'));
  try {
    const file = path.join(dir, 'ledger.json');
    const store = new Store(file);
    let first, second;
    store.transact(s => {
      first = store.addAccount(s, 'First', 'a');
      second = store.addAccount(s, 'Second', 'b');
      store.linkGoogle(s, first, claims);
      store.linkGoogle(s, second, claims);
      store.linkGoogle(s, first, claims);
    });
    assert.equal(store.state.accounts[0].walletId, store.state.accounts[1].walletId);
    assert.equal(store.state.wallets.reduce((n, w) => n + w.balance, 0), INITIAL_CREDITS);
    assert.equal(store.state.ledger.filter(l => l.type === 'Google development allowance').length, 1);
    store.transact(s => { s.wallets.find(w => w.googleSub).balance -= 123; });
    store.transact(s => store.linkGoogle(s, first, claims));
    assert.equal(store.state.wallets.find(w => w.googleSub).balance, INITIAL_CREDITS - 123);
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: [{ id: 'legacy', balance: 900000 }], offers: [], jobs: [], ledger: [], invitations: [] }));
    const migrated = new Store(file);
    assert.equal(migrated.state.wallets[0].balance, 900000);
    assert.ok(fs.existsSync(`${file}.v1-backup`));
    assert.equal(new Store(file).state.wallets[0].balance, 900000);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('Google-required coordinator issues no unsigned allowance and rejects forged tokens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-google-'));
  const hub = await startHub({ directory: dir, host: '127.0.0.1', port: 0, googleClientId: 'test-client' });
  try {
    assert.equal((await request(hub.connection, '/state', undefined, 'GET')).account.balance, 0);
    await assert.rejects(request(hub.connection, '/google', { idToken: jwt() }), /expired/);
    await assert.rejects(request(hub.connection, '/offer', { enabled: true }), /Sign in/);
  } finally { await hub.close(); fs.rmSync(dir, { recursive: true }); }
});
test('missing Google configuration never enables anonymous rentals or sharing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-no-google-'));
  const hub = await startHub({ directory: dir, host: '127.0.0.1', port: 0 });
  try {
    assert.equal((await request(hub.connection, '/state', undefined, 'GET')).account.balance, 0);
    await assert.rejects(request(hub.connection, '/rent', {}), /Sign in with Google/);
    await assert.rejects(request(hub.connection, '/offer', { enabled: true }), /Sign in with Google/);
    await assert.rejects(request(hub.connection, '/auth/challenge', {}), /not configured/);
  } finally { await hub.close(); fs.rmSync(dir, { recursive: true }); }
});
test('host filters combine GPU, CPU, RAM, availability, inclusive prices, and sorting', () => {
  const offers = [
    { id: 'a', enabled: true, online: true, own: false, kind: 'gpu', gpuModel: 'RTX 5090', cpuModel: 'Ryzen 9', ramMb: 32768, rate: 100000, name: 'A' },
    { id: 'b', enabled: true, online: true, own: false, kind: 'cpu', gpuModel: '', cpuModel: 'Core i7', ramMb: 4096, rate: 50000, name: 'B' },
    { id: 'c', enabled: true, online: false, own: false, kind: 'gpu', gpuModel: 'RTX 5090', cpuModel: 'Ryzen 9', ramMb: 8192, rate: 100000, name: 'C' }
  ];
  const options = { kind: 'all', available: true, gpu: '', cpu: '', ram: 0, min: 0, max: 100000, sort: 'price' };
  assert.deepEqual(filterHosts(offers, options).map(o => o.id), ['b', 'a']);
  assert.deepEqual(filterHosts(offers, { ...options, gpu: 'RTX 5090', cpu: 'Ryzen 9', ram: 16384, min: 100, max: 100 }).map(o => o.id), ['a']);
  assert.equal(filterHosts(offers, { ...options, max: 49 }).length, 0);
  assert.equal(filterHosts(offers, { ...options, gpu: 'RTX 5090', cpu: 'Core i7' }).length, 0);
  assert.equal(filterHosts(offers, { ...options, available: false }).length, 3);
});
