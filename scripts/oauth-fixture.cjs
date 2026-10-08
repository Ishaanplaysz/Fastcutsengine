// Test-only Google responses. Never packaged with the app.
const crypto = require('node:crypto');
async function mockGoogle(app) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'ui-test-key', use: 'sig', alg: 'RS256' };
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  await app.evaluate(({ shell }, { privatePem, publicJwk }) => {
    const crypto = process.getBuiltinModule('node:crypto');
    const realFetch = global.fetch;
    let nonce;
    function token() {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'ui-test-key' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'ui-owner', name: 'Studio owner', email: 'owner@example.test', email_verified: true, iss: 'https://accounts.google.com', aud: 'ui-test.apps.googleusercontent.com', nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
      const data = `${header}.${payload}`;
      return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), privatePem).toString('base64url')}`;
    }
    global.fetch = async (url, options) => {
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [publicJwk] }));
      if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ id_token: token() }));
      return realFetch(url, options);
    };
    shell.openExternal = async url => {
      const auth = new URL(url);
      if (auth.origin !== 'https://accounts.google.com') throw new Error('Unexpected browser destination in test.');
      nonce = auth.searchParams.get('nonce');
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', auth.searchParams.get('state'));
      callback.searchParams.set('code', 'mock-code');
      await realFetch(callback);
    };
  }, { privatePem, publicJwk });
  return (nonce, sub) => {
    const data = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'ui-test-key' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub, name: sub, email: `${sub}@example.test`, email_verified: true, iss: 'https://accounts.google.com', aud: 'ui-test.apps.googleusercontent.com', nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}`;
    return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
  };
}
module.exports = { mockGoogle };
