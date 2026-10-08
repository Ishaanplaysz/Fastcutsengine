const fs = require('node:fs');
const path = require('node:path');
let clientId = process.env.FASTCOMPUTE_GOOGLE_CLIENT_ID || '';
let clientSecret = process.env.FASTCOMPUTE_GOOGLE_CLIENT_SECRET || '';
if (process.env.FASTCOMPUTE_GOOGLE_CLIENT_FILE) {
  const data = JSON.parse(fs.readFileSync(process.env.FASTCOMPUTE_GOOGLE_CLIENT_FILE, 'utf8'));
  if (!data.installed) throw new Error('Use the downloaded Google OAuth Desktop app JSON, not a Web client.');
  clientId = data.installed.client_id;
  clientSecret = data.installed.client_secret;
}
const configured = typeof clientId === 'string' && /^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId) && typeof clientSecret === 'string' && clientSecret.length > 0;
const preview = process.argv.includes('--preview');
if (!configured && !preview) {
  throw new Error('Release blocked: supply FASTCOMPUTE_GOOGLE_CLIENT_FILE pointing to your Google Desktop OAuth JSON. End users must receive an already-configured installer. Use dist:preview only for an explicitly unconfigured UI preview.');
}
const directory = path.join(__dirname, '..', '.build');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'google-oauth.json'), JSON.stringify(configured ? { clientId, clientSecret } : {}));
console.log(configured ? 'Google Desktop client configured for packaging (credentials not logged).' : 'UNCONFIGURED PREVIEW: Google login and compute actions remain unavailable.');
