const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
let keys;
let keysUntil = 0;
async function googleJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Google authentication request failed (${res.status}). Check your OAuth setup and network access.`);
  return res.json();
}
function verifyToken(token, audience, nonce, jwks, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 12000) throw new Error('Invalid Google identity token.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid Google identity token.');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
  const jwk = jwks.keys.find(k => k.kid === header.kid && k.kty === 'RSA' && k.alg === 'RS256' && k.use === 'sig');
  if (header.alg !== 'RS256' || !jwk || !crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error('Google token signature could not be verified.');
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss) ||
      payload.aud !== audience || (payload.azp && payload.azp !== audience) ||
      typeof payload.exp !== 'number' || payload.exp * 1000 <= now ||
      typeof payload.iat !== 'number' || payload.iat * 1000 > now + 60000 ||
      typeof payload.sub !== 'string' || !payload.sub || payload.email_verified !== true ||
      typeof payload.email !== 'string' || typeof nonce !== 'string' || !nonce || payload.nonce !== nonce) {
    throw new Error('Google identity, audience, expiry, or login challenge is invalid.');
  }
  return { sub: payload.sub, email: payload.email, name: typeof payload.name === 'string' ? payload.name : payload.email };
}

function config() {
  const bundledFile = path.join(process.resourcesPath || __dirname, 'google-oauth.json');
  const bundled = fs.existsSync(bundledFile) ? JSON.parse(fs.readFileSync(bundledFile, 'utf8')) : {};
  const clientId = process.env.FASTCOMPUTE_GOOGLE_CLIENT_ID || bundled.clientId || '';
  const clientSecret = process.env.FASTCOMPUTE_GOOGLE_CLIENT_SECRET || bundled.clientSecret || '';
  return { clientId, clientSecret };
}
async function verifyIdentity(token, audience, nonce) {
  if (!audience) throw new Error('Google sign-in is not configured on this network.');
  if (!keys || keysUntil < Date.now()) {
    keys = await googleJson('https://www.googleapis.com/oauth2/v3/certs');
    keysUntil = Date.now() + 300000;
  }
  return verifyToken(token, audience, nonce, keys);
}
async function signIn({ openBrowser, clientId, clientSecret, nonce }) {
  if (!clientId || !clientSecret) throw new Error('Google sign-in needs an OAuth Desktop client. See the developer setup in Connections.');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(32).toString('base64url');
  let resolveCode, rejectCode;
  const codePromise = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Attach a handler before browser startup so timeout/error never becomes unhandled.
  codePromise.catch(() => {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
      res.writeHead(400); res.end('Invalid sign-in callback.'); return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (url.searchParams.has('error') || !url.searchParams.get('code')) {
      res.end('Sign-in was not completed. Return to FastCompute.');
      rejectCode(new Error('Google sign-in was cancelled or denied.'));
    } else {
      res.end('You can close this tab and return to FastCompute.');
      resolveCode(url.searchParams.get('code'));
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const timer = setTimeout(() => rejectCode(new Error('Google sign-in timed out. Try again.')), 120000);
  try {
    const redirect = `http://127.0.0.1:${server.address().port}/callback`;
    const query = new URLSearchParams({
      client_id: clientId, redirect_uri: redirect, response_type: 'code',
      scope: 'openid email profile', access_type: 'online', prompt: 'select_account',
      state, nonce, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256'
    });
    await openBrowser(`https://accounts.google.com/o/oauth2/v2/auth?${query}`);
    const code = await codePromise;
    const tokens = await googleJson('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, code_verifier: verifier, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' })
    });
    if (!tokens.id_token) throw new Error('Google did not return an identity token.');
    await verifyIdentity(tokens.id_token, clientId, nonce);
    return tokens.id_token;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
module.exports = { config, signIn, verifyIdentity, verifyToken };
