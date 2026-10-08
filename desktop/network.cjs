const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const selfsigned = require('selfsigned');
const { verifyIdentity } = require('./google.cjs');

const INITIAL_CREDITS = 10000_000;
const LEASE_MS = 20000;
const KINDS = ['cpu', 'gpu'];
const id = () => crypto.randomUUID();
const secret = () => crypto.randomBytes(32).toString('hex');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fingerprint = pem => hash(new crypto.X509Certificate(pem).raw);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
function integer(value, min, max, label) {
  invariant(Number.isSafeInteger(value) && value >= min && value <= max, `${label} must be an integer from ${min} to ${max}.`);
  return value;
}
function text(value, label, max = 80) {
  invariant(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max, `${label} is required (maximum ${max} characters).`);
  return value.trim();
}

class Store {
  constructor(file) {
    this.file = file;
    this.state = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : { version: 2, wallets: [], accounts: [], offers: [], jobs: [], ledger: [], invitations: [] };
    invariant([1, 2].includes(this.state.version), 'Unsupported coordinator database version.');
    if (this.state.version === 1 && fs.existsSync(file) && !fs.existsSync(`${file}.v1-backup`)) fs.copyFileSync(file, `${file}.v1-backup`);
    // Leases cannot survive a coordinator restart. Release all reservations.
    this.transact(s => {
      if (s.version === 1) {
        s.wallets = s.accounts.map(a => {
          a.walletId = a.id;
          const balance = a.balance;
          delete a.balance;
          return { id: a.id, balance };
        });
        for (const job of s.jobs) { job.renterWallet = job.renterId; job.providerWallet = job.providerId; }
        s.version = 2;
      }
      for (const job of s.jobs.filter(j => ['queued', 'running'].includes(j.status))) this.settle(s, job, 'failed', 0, 'Coordinator restarted; reservation refunded.');
      for (const offer of s.offers) offer.onlineUntil = 0;
    });
  }
  transact(fn) {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(draft), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.state = draft;
    return result;
  }
  addAccount(s, name, token, admin = false) {
    const account = { id: id(), name, tokenHash: hash(token), admin };
    account.walletId = account.id;
    s.accounts.push(account);
    const balance = 0;
    s.wallets.push({ id: account.walletId, balance });
    return account.id;
  }
  linkGoogle(s, deviceId, profile) {
    const account = s.accounts.find(a => a.id === deviceId);
    invariant(!s.jobs.some(j => [j.renterId, j.providerId].includes(deviceId) && ['queued', 'running'].includes(j.status)), 'Finish or cancel active jobs before changing accounts.');
    invariant(!s.offers.some(o => o.providerId === deviceId && o.enabled), 'Pause sharing before changing accounts.');
    let wallet = s.wallets.find(w => w.googleSub === profile.sub);
    if (!wallet) {
      wallet = { id: id(), googleSub: profile.sub, balance: INITIAL_CREDITS };
      s.wallets.push(wallet);
      s.ledger.push({ id: id(), accountId: wallet.id, amount: INITIAL_CREDITS, type: 'Google development allowance', at: Date.now() });
    }
    wallet.profile = { name: profile.name, email: profile.email };
    account.walletId = wallet.id;
    return { ok: true };
  }
  settle(s, job, status, elapsedMs, result) {
    invariant(['queued', 'running'].includes(job.status), 'Job has already settled.');
    const charge = status === 'completed'
      ? Math.min(job.reserved, Math.ceil(job.rate * Math.min(elapsedMs, job.seconds * 1000) / 3600000)) : 0;
    const renter = s.wallets.find(a => a.id === job.renterWallet);
    const provider = s.wallets.find(a => a.id === job.providerWallet);
    renter.balance += job.reserved - charge;
    provider.balance += charge;
    job.status = status;
    job.charge = charge;
    job.elapsedMs = elapsedMs;
    job.result = result;
    job.finishedAt = Date.now();
    if (charge) {
      s.ledger.push({ id: id(), accountId: renter.id, amount: -charge, type: 'Compute rental', jobId: job.id, at: Date.now() });
      s.ledger.push({ id: id(), accountId: provider.id, amount: charge, type: 'Compute earned', jobId: job.id, at: Date.now() });
    }
  }
}

function parseInvite(value) {
  invariant(typeof value === 'string' && value.startsWith('fc1:'), 'Paste a FastCompute invitation beginning with fc1:.');
  let data;
  try { data = JSON.parse(Buffer.from(value.slice(4), 'base64url').toString('utf8')); }
  catch { throw new Error('Invalid invitation. Copy the complete invitation from the coordinator.'); }
  validateConnection(data);
  return data;
}
function validateConnection(data) {
  invariant(data && typeof data.url === 'string', 'Missing coordinator address.');
  const url = new URL(data.url);
  invariant(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Coordinator address must be an HTTPS origin.');
  invariant(/^[a-f0-9]{64}$/.test(data.pin), 'Invalid coordinator certificate fingerprint.');
  invariant(/^[a-f0-9]{64}$/.test(data.token), 'Invalid access token.');
}
function request(connection, route, body, method = 'POST') {
  validateConnection(connection);
  const origin = new URL(connection.url);
  const agent = new https.Agent({ keepAlive: false });
  // Verify the pinned certificate before handing the socket to HTTP.
  agent.createConnection = (options, done) => {
    const socket = tls.connect({ host: origin.hostname, port: Number(origin.port) || 443, rejectUnauthorized: false });
    socket.setTimeout(8000, () => socket.destroy(new Error('Coordinator connection timed out.')));
    let called = false;
    const finish = (error, value) => { if (!called) { called = true; done(error, value); } };
    socket.once('error', error => finish(error));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!cert.raw || hash(cert.raw) !== connection.pin) {
        const error = new Error('Coordinator certificate changed. Pair again using a trusted invitation.');
        finish(error);
        socket.destroy();
      } else finish(null, socket);
    });
  };
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(route, origin), {
      method, agent, headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 4_000_000) res.destroy(new Error('Coordinator response is too large.'));
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(parsed.error || `Coordinator error ${res.statusCode}`));
          else resolve(parsed);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Coordinator request timed out.')));
    req.on('error', reject);
    req.on('close', () => agent.destroy());
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function startHub({ directory, port = 48721, host = '0.0.0.0', name = 'My workstation', googleClientId = '' }) {
  fs.mkdirSync(directory, { recursive: true });
  const certFile = path.join(directory, 'identity.json');
  let identity;
  if (fs.existsSync(certFile)) identity = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  else {
    const cert = selfsigned.generate([{ name: 'commonName', value: 'FastCompute private coordinator' }], { days: 3650, keySize: 2048, algorithm: 'sha256' });
    identity = { key: cert.private, cert: cert.cert, token: secret() };
    fs.writeFileSync(certFile, JSON.stringify(identity), { mode: 0o600 });
  }
  const store = new Store(path.join(directory, 'ledger.json'));
  if (!store.state.accounts.length) store.transact(s => store.addAccount(s, name, identity.token, true));
  const pin = fingerprint(identity.cert);
  const expire = () => {
    const now = Date.now();
    const expired = store.state.jobs.filter(j => (j.status === 'queued' && now - j.createdAt > LEASE_MS) || (j.status === 'running' && now - j.heartbeatAt > LEASE_MS));
    if (expired.length) store.transact(s => {
      for (const job of s.jobs.filter(j => expired.some(e => e.id === j.id))) store.settle(s, job, 'failed', 0, 'Worker disconnected or did not accept the job; reservation refunded.');
    });
  };
  async function route(method, pathname, token, body) {
    expire();
    if (method === 'POST' && pathname === '/join') {
      return store.transact(s => {
        const invite = s.invitations.find(i => i.tokenHash === hash(token) && i.expiresAt > Date.now());
        invariant(invite, 'Invitation expired or already used.');
        const accessToken = secret();
        const accountId = store.addAccount(s, text(body.name, 'Device name'), accessToken);
        s.invitations = s.invitations.filter(i => i !== invite);
        return { token: accessToken, accountId };
      });
    }
    const account = store.state.accounts.find(a => a.tokenHash === hash(token));
    invariant(account, 'Not authorized. Pair this device with the coordinator.');
    if (method === 'POST' && pathname === '/google') {
      invariant(account.authUntil > Date.now(), 'Sign-in expired. Try again.');
      const nonce = account.authNonce;
      const profile = await verifyIdentity(body.idToken, googleClientId, nonce);
      return store.transact(s => {
        const current = s.accounts.find(a => a.id === account.id);
        invariant(current.authNonce === nonce && current.authUntil > Date.now(), 'Sign-in challenge already used or expired.');
        const result = store.linkGoogle(s, account.id, profile);
        delete current.authNonce; delete current.authUntil;
        return result;
      });
    }
    if (method === 'GET' && pathname === '/state') {
      const s = store.state;
      const wallet = s.wallets.find(w => w.id === account.walletId);
      return {
        account: { id: account.id, name: account.name, balance: wallet.googleSub ? wallet.balance : 0, admin: account.admin, profile: wallet.profile || null },
        googleClientId,
        totals: {
          earned: wallet.googleSub ? s.ledger.filter(l => l.accountId === wallet.id && l.type === 'Compute earned').reduce((n, l) => n + l.amount, 0) : 0,
          reserved: s.jobs.filter(j => j.renterWallet === wallet.id && ['queued', 'running'].includes(j.status)).reduce((n, j) => n + j.reserved, 0),
          active: s.jobs.filter(j => (j.renterId === account.id || j.providerId === account.id) && ['queued', 'running'].includes(j.status)).length
        },
        peers: s.accounts.map(a => ({ id: a.id, name: a.name })),
        offers: s.offers.map(o => ({ ...o, own: s.accounts.find(a => a.id === o.providerId).walletId === wallet.id, online: o.onlineUntil > Date.now(), busy: s.jobs.some(j => j.providerId === o.providerId && ['queued', 'running'].includes(j.status)) })),
        jobs: s.jobs.filter(j => j.renterId === account.id || j.providerId === account.id).slice(-100).reverse(),
        ledger: wallet.googleSub ? s.ledger.filter(l => l.accountId === wallet.id).slice(-100).reverse() : []
      };
    }
    return store.transact(s => {
      if (method === 'POST' && pathname === '/auth/challenge') {
        invariant(googleClientId, 'Google sign-in is not configured on this network.');
        const current = s.accounts.find(a => a.id === account.id);
        current.authNonce = secret(); current.authUntil = Date.now() + 180000;
        return { nonce: current.authNonce, clientId: googleClientId };
      }
      if (method === 'POST' && pathname === '/signout') {
        invariant(!s.jobs.some(j => [j.renterId, j.providerId].includes(account.id) && ['queued', 'running'].includes(j.status)), 'Finish or cancel active jobs before signing out.');
        invariant(!s.offers.some(o => o.providerId === account.id && o.enabled), 'Pause sharing before signing out.');
        const current = s.accounts.find(a => a.id === account.id);
        current.walletId = id();
        delete current.authNonce; delete current.authUntil;
        s.wallets.push({ id: current.walletId, balance: 0 });
        return { ok: true };
      }
      if (method === 'POST' && pathname === '/invite') {
        invariant(account.admin, 'Only the coordinator can create invitations.');
        const inviteToken = secret();
        s.invitations = s.invitations.filter(i => i.expiresAt > Date.now());
        invariant(s.invitations.length < 50, 'Too many unused invitations. Wait for them to expire.');
        s.invitations.push({ tokenHash: hash(inviteToken), expiresAt: Date.now() + 600000 });
        return { token: inviteToken, pin };
      }
      if (method === 'POST' && pathname === '/offer') {
        invariant(!body.enabled || s.wallets.find(w => w.id === account.walletId).googleSub, 'Sign in with Google before sharing.');
        invariant(KINDS.includes(body.kind), 'Choose a CPU or GPU worker.');
        const offer = {
          id: account.id, providerId: account.id, name: text(body.name, 'Hardware name'),
          kind: body.kind, cores: integer(body.cores, 1, 32, 'CPU threads'),
          cpuModel: body.cpuModel ? text(body.cpuModel, 'CPU model', 160) : 'Not reported',
          gpuModel: body.kind === 'gpu' ? text(body.gpuModel || body.name, 'GPU model', 160) : '',
          ramMb: integer(body.ramMb, 64, 32768, 'RAM limit'),
          rate: integer(body.rate, 100, 100000000, 'Hourly rate in millicredits'),
          enabled: body.enabled === true, onlineUntil: Date.now() + LEASE_MS
        };
        const index = s.offers.findIndex(o => o.id === account.id);
        if (index === -1) s.offers.push(offer); else s.offers[index] = offer;
        return { ok: true };
      }
      if (method === 'POST' && pathname === '/rent') {
        invariant(s.wallets.find(w => w.id === account.walletId).googleSub, 'Sign in with Google to use your development units.');
        const offer = s.offers.find(o => o.id === body.offerId);
        invariant(offer && offer.enabled && offer.onlineUntil > Date.now(), 'This machine is offline or no longer sharing.');
        const provider = s.accounts.find(a => a.id === offer.providerId);
        invariant(provider.walletId !== account.walletId, 'Rent another device owned by a different person. Own-account rentals are not allowed.');
        invariant(!s.jobs.some(j => j.providerId === offer.providerId && ['queued', 'running'].includes(j.status)), 'This machine is already working on a job.');
        const seconds = integer(body.seconds, 5, 300, 'Job duration');
        const reserved = Math.ceil(offer.rate * seconds / 3600);
        const renter = s.wallets.find(a => a.id === account.walletId);
        invariant(renter.balance >= reserved, 'Not enough available credits for this reservation.');
        renter.balance -= reserved;
        const job = { id: id(), renterId: account.id, providerId: offer.providerId, renterWallet: renter.id, providerWallet: provider.walletId, hardware: offer.name, kind: offer.kind, cores: offer.cores, ramMb: offer.ramMb, rate: offer.rate, seconds, reserved, status: 'queued', createdAt: Date.now() };
        s.jobs.push(job);
        return job;
      }
      if (method === 'POST' && pathname === '/poll') {
        const offer = s.offers.find(o => o.providerId === account.id);
        if (offer) offer.onlineUntil = Date.now() + LEASE_MS;
        const active = s.jobs.find(j => j.providerId === account.id && j.status === 'running');
        if (active) {
          active.heartbeatAt = Date.now();
          return { activeJob: active.id, cancel: active.cancelRequested === true };
        }
        const job = s.jobs.find(j => j.providerId === account.id && j.status === 'queued');
        if (!job || !offer?.enabled) return {};
        job.status = 'running';
        job.startedAt = Date.now();
        job.heartbeatAt = Date.now();
        return { job: structuredClone(job) };
      }
      if (method === 'POST' && pathname === '/finish') {
        const job = s.jobs.find(j => j.id === body.jobId && j.providerId === account.id);
        invariant(job, 'Job not found.');
        if (!['queued', 'running'].includes(job.status)) return { ok: true, status: job.status };
        invariant(job.status === 'running', 'Job was not started.');
        const elapsedMs = integer(body.elapsedMs, 0, job.seconds * 1000 + 30000, 'Elapsed milliseconds');
        invariant(elapsedMs <= Date.now() - job.startedAt + 2000, 'Reported runtime exceeds elapsed wall time.');
        const status = job.cancelRequested ? 'cancelled' : body.success === true ? 'completed' : 'failed';
        store.settle(s, job, status, elapsedMs, text(body.result, 'Job result', 4000));
        return { ok: true, status };
      }
      if (method === 'POST' && pathname === '/cancel') {
        const job = s.jobs.find(j => j.id === body.jobId && (j.renterId === account.id || j.providerId === account.id));
        invariant(job && ['queued', 'running'].includes(job.status), 'No active job found.');
        if (job.status === 'queued') store.settle(s, job, 'cancelled', 0, 'Cancelled before execution.');
        else job.cancelRequested = true;
        return { ok: true };
      }
      throw new Error('Unknown coordinator operation.');
    });
  }
  const server = https.createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2' }, async (req, res) => {
    try {
      invariant(req.url.length < 256, 'Invalid request URL.');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        invariant(raw.length < 16000, 'Request too large.');
      }
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      invariant(/^[a-f0-9]{64}$/.test(token), 'Invalid access token.');
      const result = await route(req.method, req.url, token, raw ? JSON.parse(raw) : {});
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  server.requestTimeout = 12000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const timer = setInterval(expire, 2000);
  timer.unref();
  return {
    store, server, pin,
    connection: { url: `https://127.0.0.1:${server.address().port}`, pin, token: identity.token },
    close: async () => { clearInterval(timer); await new Promise(resolve => server.close(resolve)); }
  };
}
module.exports = { startHub, request, parseInvite, validateConnection, Store, INITIAL_CREDITS };
