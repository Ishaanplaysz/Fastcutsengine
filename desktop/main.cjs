const { app, BrowserWindow, ipcMain, clipboard, safeStorage, shell } = require('electron');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { startHub, request, parseInvite } = require('./network.cjs');
const { ComputeWorker, probeGpu } = require('./worker.cjs');
const google = require('./google.cjs');
const startCoordinator = options => startHub({ ...options, googleClientId: google.config().clientId });

if (process.env.FASTCOMPUTE_DATA_DIR) {
  if (!path.isAbsolute(process.env.FASTCOMPUTE_DATA_DIR)) throw new Error('FASTCOMPUTE_DATA_DIR must be an absolute directory.');
  app.setPath('userData', process.env.FASTCOMPUTE_DATA_DIR);
}
let window;
let hub;
let connection;
let worker;
let lastError = '';
let closing = false;
let busy = false;
const settingsFile = () => path.join(app.getPath('userData'), 'connection.bin');
function saveConnection() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable. Pairing cannot be saved safely.');
  fs.writeFileSync(settingsFile(), safeStorage.encryptString(JSON.stringify(connection)));
}
function attachWorker() {
  worker = new ComputeWorker(connection, message => { lastError = message; });
}
function hardware() {
  const cpus = os.cpus();
  return { name: os.hostname(), cpu: cpus[0]?.model || 'CPU', cores: Math.min(os.availableParallelism(), 32), ramMb: Math.floor(os.totalmem() / 1024 / 1024), addresses: Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address) };
}
async function invoke(action, data = {}) {
  if (action === 'snapshot') {
    let remote = null;
    let error = lastError;
    if (connection) {
      try { remote = await request(connection, '/state', undefined, 'GET'); }
      catch (e) { error = e.message; }
    }
    const oauth = google.config();
    return { hardware: hardware(), connected: !!connection, hosting: !!hub, googleReady: !!(oauth.clientId && oauth.clientSecret && remote?.googleClientId === oauth.clientId), url: connection?.url, sharing: worker?.enabled || false, working: worker?.running?.job.id || null, error, remote };
  }
  if (action === 'probeGpu') return probeGpu();
  if (action === 'host') {
    if (connection) throw new Error('This device is already paired. Restart after disconnecting to change networks.');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable.');
    hub = await startCoordinator({ directory: path.join(app.getPath('userData'), 'coordinator'), name: data.name || os.hostname() });
    connection = { ...hub.connection, hosting: true };
    try { saveConnection(); }
    catch (error) { await hub.close(); hub = null; connection = null; throw error; }
    attachWorker();
    return { ok: true };
  }
  if (action === 'join') {
    if (connection) throw new Error('Disconnect from the current network before joining another.');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable.');
    const invitation = parseInvite(data.invitation);
    const joined = await request(invitation, '/join', { name: data.name || os.hostname() });
    connection = { url: invitation.url, pin: invitation.pin, token: joined.token, hosting: false };
    try { saveConnection(); }
    catch (error) { connection = null; throw error; }
    attachWorker();
    return { ok: true };
  }
  if (!connection) throw new Error('Create or join a private network first.');
  if (action === 'googleSignIn') {
    const settings = google.config();
    const challenge = await request(connection, '/auth/challenge', {});
    if (challenge.clientId !== settings.clientId) throw new Error('The desktop and coordinator must use the same Google OAuth client ID.');
    const idToken = await google.signIn({ ...settings, nonce: challenge.nonce, openBrowser: url => shell.openExternal(url) });
    await request(connection, '/google', { idToken });
    return { ok: true };
  }
  if (action === 'signOut') return request(connection, '/signout', {});
  if (action === 'invite') {
    if (!hub) throw new Error('Only the coordinator can invite peers.');
    const address = new URL(data.url);
    if (address.protocol !== 'https:' || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error('Use an HTTPS origin, for example https://192.168.1.10:48721.');
    const invite = await request(connection, '/invite', {});
    const value = `fc1:${Buffer.from(JSON.stringify({ url: address.origin, ...invite })).toString('base64url')}`;
    clipboard.writeText(value);
    return { invitation: value };
  }
  if (action === 'share') { lastError = ''; await worker.start(data); return { ok: true }; }
  if (action === 'pause') { await worker.stop(); return { ok: true }; }
  if (action === 'rent') return request(connection, '/rent', data);
  if (action === 'cancel') return request(connection, '/cancel', data);
  if (action === 'disconnect') {
    if (hub) throw new Error('The coordinator network is stored on this machine. Close the application to stop it; its ledger is retained.');
    await worker.stop();
    await worker.close();
    connection = null;
    worker = null;
    fs.unlinkSync(settingsFile());
    lastError = '';
    return { ok: true };
  }
  throw new Error('Unsupported application action.');
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    try {
      if (fs.existsSync(settingsFile())) {
        connection = JSON.parse(safeStorage.decryptString(fs.readFileSync(settingsFile())));
        if (connection.hosting) {
          hub = await startCoordinator({ directory: path.join(app.getPath('userData'), 'coordinator'), name: os.hostname() });
          connection = { ...hub.connection, hosting: true };
        }
        attachWorker();
      }
    } catch (error) { connection = null; lastError = `Could not restore network: ${error.message}`; }
    ipcMain.handle('compute', async (event, action, data) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted caller.');
      try {
        if (action === 'snapshot') return { value: await invoke(action, data) };
        if (busy) throw new Error('Another operation is in progress. Please wait.');
        busy = true;
        try { return { value: await invoke(action, data) }; }
        finally { busy = false; }
      } catch (error) { return { error: error.message }; }
    });
    window = new BrowserWindow({
      width: 1440, height: 950, minWidth: 1050, minHeight: 720,
      title: 'FastCompute', backgroundColor: '#faf9fd', autoHideMenuBar: true,
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    await window.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    (async () => {
      if (worker) await worker.close();
      if (hub) await hub.close();
    })().catch(error => console.error(error)).finally(() => app.quit());
  });
}
