const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('releases require Desktop OAuth configuration and package only the required fields', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-release-'));
  const script = path.join(directory, 'scripts', 'prepare-release.cjs');
  const output = path.join(directory, '.build', 'google-oauth.json');
  const clientFile = path.join(directory, 'desktop-client.json');
  const clientId = 'release-test.apps.googleusercontent.com';
  const clientSecret = 'test-only-desktop-configuration';
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('FASTCOMPUTE_GOOGLE_')) delete env[key];
  }
  const run = (overrides = {}, args = []) => spawnSync(process.execPath, [script, ...args], {
    cwd: directory, env: { ...env, ...overrides }, encoding: 'utf8'
  });
  try {
    fs.mkdirSync(path.dirname(script));
    fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'prepare-release.cjs'), script);

    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Release blocked/);
    assert.equal(fs.existsSync(output), false);

    const preview = run({}, ['--preview']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), {});
    assert.match(preview.stdout, /UNCONFIGURED PREVIEW/);

    fs.writeFileSync(clientFile, JSON.stringify({ web: { client_id: clientId, client_secret: clientSecret } }));
    const web = run({ FASTCOMPUTE_GOOGLE_CLIENT_FILE: clientFile });
    assert.equal(web.status, 1);
    assert.match(web.stderr, /Desktop app JSON, not a Web client/);

    fs.writeFileSync(clientFile, JSON.stringify({ installed: { client_id: clientId } }));
    assert.equal(run({ FASTCOMPUTE_GOOGLE_CLIENT_FILE: clientFile }).status, 1);

    fs.writeFileSync(clientFile, JSON.stringify({
      installed: { client_id: clientId, client_secret: clientSecret, project_id: 'not-needed-in-package' }
    }));
    const configured = run({ FASTCOMPUTE_GOOGLE_CLIENT_FILE: clientFile });
    assert.equal(configured.status, 0, configured.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { clientId, clientSecret });
    assert.equal((configured.stdout + configured.stderr).includes(clientSecret), false);
    assert.equal((configured.stdout + configured.stderr).includes(clientId), false);

    assert.equal(run().status, 1, 'A stale build configuration must not bypass the release guard.');
    assert.equal(run({}, ['--preview']).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), {}, 'Preview must clear stale configuration.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
