const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startHub, request, parseInvite, INITIAL_CREDITS } = require('../desktop/network.cjs');
const { ComputeWorker } = require('../desktop/worker.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fastcompute-test-'));
  const hub = await startHub({ directory, port: 0, host: '127.0.0.1', name: 'Coordinator' });
  t.after(async () => { await hub.close(); fs.rmSync(directory, { recursive: true }); });
  const owner = hub.connection;
  const invite = await request(owner, '/invite', {});
  const invitation = { ...invite, url: owner.url };
  const joined = await request(invitation, '/join', { name: 'Provider' });
  const provider = { ...owner, token: joined.token };
  hub.store.transact(s => {
    for (const a of s.accounts) hub.store.linkGoogle(s, a.id, { sub: a.id, name: a.name, email: `${a.id}@example.test` });
  });
  return { hub, owner, provider, invitation };
}
const state = connection => request(connection, '/state', undefined, 'GET');
const offer = { name: 'Test CPU', kind: 'cpu', cores: 1, ramMb: 64, rate: 100000, enabled: true };

test('one-use invitations, authentication, TLS pinning, and self-rental rejection', async t => {
  const { owner, provider, invitation } = await fixture(t);
  assert.equal(parseInvite(`fc1:${Buffer.from(JSON.stringify(invitation)).toString('base64url')}`).pin, owner.pin);
  assert.throws(() => parseInvite('bad'), /invitation/);
  await assert.rejects(request(invitation, '/join', { name: 'Again' }), /already used/);
  await assert.rejects(request({ ...owner, pin: 'a'.repeat(64) }, '/state', undefined, 'GET'), /certificate changed/);
  await assert.rejects(request({ ...owner, token: 'b'.repeat(64) }, '/state', undefined, 'GET'), /Not authorized/);
  await assert.rejects(request(provider, '/invite', {}), /Only the coordinator/);
  await request(provider, '/offer', offer);
  const listing = (await state(owner)).offers[0];
  await assert.rejects(request(provider, '/rent', { offerId: listing.id, seconds: 5 }), /another device/);
  await assert.rejects(request(owner, '/rent', { offerId: listing.id, seconds: -5 }), /duration/);
  await assert.rejects(request(provider, '/offer', { ...offer, cores: 0 }), /CPU threads/);
});

test('real remote CPU job transfers credits exactly once and preserves total supply', { timeout: 30000 }, async t => {
  const { owner, provider, hub } = await fixture(t);
  const errors = [];
  const worker = new ComputeWorker(provider, error => errors.push(error));
  t.after(() => worker.close());
  await worker.start(offer);
  const listing = (await state(owner)).offers[0];
  const job = await request(owner, '/rent', { offerId: listing.id, seconds: 5 });
  assert.equal((await state(owner)).account.balance, INITIAL_CREDITS - job.reserved);
  await assert.rejects(request(owner, '/rent', { offerId: listing.id, seconds: 5 }), /already working/);
  await worker.poll();
  assert.ok(worker.running);
  await worker.completion;
  const renterState = await state(owner);
  const providerState = await state(provider);
  const finished = renterState.jobs.find(j => j.id === job.id);
  assert.equal(finished.status, 'completed');
  assert.match(finished.result, /PBKDF2-SHA256: \d+ batches/);
  assert.ok(finished.charge > 0 && finished.charge <= job.reserved);
  assert.equal(renterState.account.balance + providerState.account.balance, INITIAL_CREDITS * 2);
  assert.equal(providerState.account.balance, INITIAL_CREDITS + finished.charge);
  await request(provider, '/finish', { jobId: job.id, success: true, elapsedMs: 5000, result: 'duplicate' });
  assert.equal((await state(provider)).account.balance, providerState.account.balance);
  assert.equal(hub.store.state.ledger.filter(l => l.jobId === job.id).length, 2);
  assert.deepEqual(errors, []);
  await worker.stop();
});

test('cancellation, insufficient balance, worker failure, and expired leases refund reservations', async t => {
  const { owner, provider, hub } = await fixture(t);
  await request(provider, '/offer', offer);
  const listing = (await state(owner)).offers[0];
  const first = await request(owner, '/rent', { offerId: listing.id, seconds: 5 });
  await request(owner, '/cancel', { jobId: first.id });
  assert.equal((await state(owner)).account.balance, INITIAL_CREDITS);
  const second = await request(owner, '/rent', { offerId: listing.id, seconds: 5 });
  await request(provider, '/poll', {});
  await assert.rejects(request(owner, '/finish', { jobId: second.id, success: true, elapsedMs: 0, result: 'forged' }), /not found/);
  await request(provider, '/finish', { jobId: second.id, success: false, elapsedMs: 0, result: 'Missing CUDA' });
  assert.equal((await state(owner)).account.balance, INITIAL_CREDITS);
  const third = await request(owner, '/rent', { offerId: listing.id, seconds: 5 });
  await request(provider, '/poll', {});
  hub.store.transact(s => { s.jobs.find(j => j.id === third.id).heartbeatAt = Date.now() - 25000; });
  assert.equal((await state(owner)).jobs[0].status, 'failed');
  assert.equal((await state(owner)).account.balance, INITIAL_CREDITS);
  await request(provider, '/offer', { ...offer, rate: 100000000 });
  hub.store.transact(s => { s.wallets.find(w => w.id === s.accounts.find(a => a.admin).walletId).balance = 1000; });
  await assert.rejects(request(owner, '/rent', { offerId: listing.id, seconds: 300 }), /Not enough/);
});

test('running cancellation terminates a real worker and returns all reserved credit', { timeout: 30000 }, async t => {
  const { owner, provider } = await fixture(t);
  const worker = new ComputeWorker(provider);
  t.after(() => worker.close());
  await worker.start(offer);
  const listing = (await state(owner)).offers[0];
  const job = await request(owner, '/rent', { offerId: listing.id, seconds: 30 });
  await worker.poll();
  await sleep(500);
  await request(owner, '/cancel', { jobId: job.id });
  await worker.poll();
  await worker.completion;
  assert.equal((await state(owner)).jobs[0].status, 'cancelled');
  assert.equal((await state(owner)).account.balance, INITIAL_CREDITS);
  await worker.stop();
});

test('restart retains accounts and ledger, refunds pending jobs, and takes offers offline', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fastcompute-restart-'));
  let hub;
  try {
    hub = await startHub({ directory, port: 0, host: '127.0.0.1' });
    const owner = hub.connection;
    const invitation = { ...await request(owner, '/invite', {}), url: owner.url };
    const joined = await request(invitation, '/join', { name: 'Provider' });
    const provider = { ...owner, token: joined.token };
    hub.store.transact(s => {
      for (const a of s.accounts) hub.store.linkGoogle(s, a.id, { sub: a.id, name: a.name, email: `${a.id}@example.test` });
    });
    await request(provider, '/offer', offer);
    await request(owner, '/rent', { offerId: joined.accountId, seconds: 10 });
    await hub.close();
    hub = await startHub({ directory, port: 0, host: '127.0.0.1' });
    const restored = await state(hub.connection);
    assert.equal(restored.account.balance, INITIAL_CREDITS);
    assert.equal(restored.jobs[0].status, 'failed');
    assert.equal(restored.offers[0].online, false);
    assert.equal(restored.peers.length, 2);
  } finally { if (hub) await hub.close(); fs.rmSync(directory, { recursive: true }); }
});
