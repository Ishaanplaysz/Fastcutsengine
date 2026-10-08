const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const credits = value => (value / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const date = value => new Date(value).toLocaleString();
let snapshot = null;
let filter = 'all';
let selectedOffer = null;
let initialized = false;
let refreshing = false;
let toastTimer;
const api = (action, data) => window.compute.invoke(action, data);
function toast(message, error = false) {
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}
function go(page) {
  $$('.page').forEach(el => { el.hidden = el.id !== `page-${page}`; });
  $$('[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  $('#breadcrumb-current').textContent = ({ market: 'Find compute', jobs: 'My jobs', sharing: 'Earn units', wallet: 'My wallet', network: 'Account & network' })[page];
  window.scrollTo({ top: 0 });
}
async function act(button, fn) {
  button.disabled = true;
  try { await fn(); await refresh(); }
  catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}
function empty(title, description, page, label) {
  return `<div class="empty-state"><span class="empty-symbol">&#10022;</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p>${page ? `<button class="button secondary" data-go="${page}">${label} &#8599;</button>` : ''}</div>`;
}
function renderMarket() {
  const state = snapshot?.remote;
  for (const [field, selector, label] of [['gpuModel', '#gpu-filter', 'Any GPU / CPU only'], ['cpuModel', '#cpu-filter', 'Any CPU']]) {
    const select = $(selector), selected = select.value;
    const values = [...new Set((state?.offers || []).filter(o => o.enabled).map(o => o[field]).filter(Boolean))].sort();
    if (selected && !values.includes(selected)) values.push(selected);
    const html = `<option value="">${label}</option>` + values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    if (select.innerHTML !== html) { select.innerHTML = html; select.value = selected; }
  }
  const offers = window.filterHosts(state?.offers || [], {
    kind: filter, gpu: $('#gpu-filter').value, cpu: $('#cpu-filter').value, ram: Number($('#ram-filter').value),
    min: Number($('#price-min-number').value), max: Number($('#price-max-number').value), available: $('#available-only').checked, sort: $('#sort').value
  });
  $('#host-count').textContent = `${offers.length} ${offers.length === 1 ? 'match' : 'matches'}`;
  $('#machine-grid').innerHTML = offers.length ? offers.map(o => {
    const own = o.own;
    const available = o.online && !o.busy && !own;
    const status = !o.online ? 'Offline' : o.busy ? 'Working' : own ? 'Your listing' : 'Available';
    return `<article class="machine-card"><div class="card-top"><span class="hardware-mark">${o.kind === 'gpu' ? '&#9707;' : '&#10022;'}</span><span class="status ${o.online ? '' : 'offline'}"><span class="online-dot"></span>${status}</span></div><h3>${escapeHtml(o.kind === 'gpu' ? o.gpuModel || o.name : o.name)}</h3><div class="provider">${escapeHtml(state.peers.find(p => p.id === o.providerId)?.name || 'Peer')}</div><div class="specs"><div><span>CPU MODEL</span><strong>${escapeHtml(o.cpuModel || 'Not reported')}</strong></div><div><span>THREADS</span><strong>${o.cores}</strong></div><div><span>JOB RAM</span><strong>${o.ramMb >= 1024 ? `${(o.ramMb / 1024).toFixed(1)} GiB` : `${o.ramMb} MiB`}</strong></div><div><span>WORKLOAD</span><strong>${o.kind === 'gpu' ? 'CUDA / FP32' : 'CPU benchmark'}</strong></div></div><div class="card-bottom"><div class="price">${credits(o.rate)} <small>CU / hr</small></div><button class="button ${available ? 'primary' : 'secondary'}" data-rent="${o.id}" ${available ? '' : 'disabled'}>${own ? 'Your host' : o.busy ? 'In use' : !o.online ? 'Offline' : 'Use host &#8599;'}</button></div></article>`;
  }).join('') : state ? empty('No hosts match just yet.', 'Try resetting your filters, or invite a device and enable sharing on it. Available hosts will appear automatically.', 'network', 'Connect a host') : empty('Your hosts will appear here.', 'Join your private network once. Then browse available hardware without searching for individual people.', 'network', 'Connect to a network');
}
function renderJobs(state) {
  $('#jobs-list').innerHTML = state?.jobs.length ? state.jobs.map(job => {
    const active = ['queued', 'running'].includes(job.status);
    const own = job.renterId === state.account.id;
    return `<article class="job-card"><div class="list-row"><span class="stat-icon ${own ? 'purple' : 'green'}">${own ? '&#9655;' : '&#10022;'}</span><div class="detail"><h3>${escapeHtml(job.hardware)}</h3><p>${own ? 'Rented compute' : 'Providing compute'} &middot; ${date(job.createdAt)}</p></div><span class="job-status ${job.status}">${job.cancelRequested && active ? 'cancelling' : job.status}</span>${active && !job.cancelRequested ? `<button class="button secondary" data-cancel="${job.id}">Cancel</button>` : ''}</div><div class="job-meta"><span>${job.kind.toUpperCase()} / ${job.seconds}s requested</span><span>${credits(job.rate)} CU/hr</span><span>${active ? `Reserved: ${credits(job.reserved)}` : `Settled: ${credits(job.charge || 0)}`} CU</span><span>Job ${job.id.slice(0, 8)}</span></div>${job.result ? `<div class="job-result">${escapeHtml(job.result)}</div>` : ''}</article>`;
  }).join('') : empty('A clean slate. A world of possibilities.', 'Rent a machine from the marketplace. Track real execution and view the result here.', 'market', 'Find compute');
}
function renderWallet(state) {
  $('#wallet-balance').textContent = credits(state?.account.balance || 0);
  $('#wallet-reserved').textContent = credits(state?.totals.reserved || 0);
  $('#ledger-list').innerHTML = state?.ledger.length ? state.ledger.map(entry => `<div class="list-row"><span class="stat-icon ${entry.amount > 0 ? 'green' : 'purple'}">${entry.amount > 0 ? '&#8601;' : '&#8599;'}</span><div class="detail"><h3>${escapeHtml(entry.type)}</h3><p>${date(entry.at)}${entry.jobId ? ` &middot; Job ${entry.jobId.slice(0, 8)}` : ' &middot; Development allocation'}</p></div><strong class="amount ${entry.amount > 0 ? 'green-text' : ''}">${entry.amount > 0 ? '+' : ''}${credits(entry.amount)} <span class="muted">CU</span></strong></div>`).join('') : empty('Your compute units live here.', 'Connect a network and sign in to receive your one-time 10,000 CU development allowance.', 'network', 'Get started');
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    snapshot = await api('snapshot');
    const s = snapshot.remote;
    const profile = s?.account.profile;
    $('#google-button-text').textContent = profile ? profile.name : 'Sign in with Google';
    $('#profile-name').innerHTML = `${escapeHtml(profile?.name || 'Your workspace')}<small>${profile ? 'Google account' : 'Development preview'}</small>`;
    $('#sign-out').hidden = !profile;
    $('#account-heading').textContent = profile ? profile.name : 'Your account';
    $('#auth-message').textContent = profile ? `${profile.email} - your units are shared across signed-in devices on this network.` : !s ? 'First, join or create a network below. Google sign-in is required to rent or share.' : snapshot.googleReady ? 'Sign in with Google above to unlock renting, sharing, and 10,000 development units. Your name and email are shared with this coordinator.' : 'This preview is missing the app developer\'s Google configuration. Request a configured installer. Renting and sharing stay locked; you do not need to configure Google Cloud yourself.';
    $('#allowance-note').textContent = profile ? 'Your allowance is ready. Earn more by sharing, or pick a host below.' : 'Sign in with Google to unlock your one-time allowance and start computing.';
    $('#onboard-button').textContent = s ? 'Account & network' : 'Get started \u2192';
    $('#error-banner').hidden = !snapshot.error;
    $('#error-banner').textContent = snapshot.error;
    $('#header-balance').textContent = credits(s?.account.balance || 0);
    $('#network-status').textContent = s ? snapshot.hosting ? 'Coordinating network' : 'Network connected' : snapshot.connected ? 'Coordinator unreachable' : 'Not connected';
    $('#network-dot').classList.toggle('connected', !!s);
    $('#peer-count').textContent = s?.offers.filter(o => o.online && o.enabled && !o.busy && !o.own).length || 0;
    $('#stat-machines').textContent = $('#peer-count').textContent;
    $('#stat-earned').textContent = credits(s?.totals.earned || 0);
    $('#stat-jobs').textContent = s?.totals.active || 0;
    $('#sharing-state').textContent = snapshot.sharing ? snapshot.working ? 'WORKLOAD RUNNING' : 'READY FOR JOBS' : 'SHARING PAUSED';
    $('#share-button').textContent = snapshot.sharing ? 'Update sharing settings' : 'Start sharing \u2197';
    $('#local-name').textContent = snapshot.hardware.name;
    $('#local-cpu').textContent = snapshot.hardware.cpu;
    $('#local-cores').textContent = snapshot.hardware.cores;
    $('#local-ram').textContent = `${(snapshot.hardware.ramMb / 1024).toFixed(1)} GiB`;
    $('#setup-panels').hidden = snapshot.connected;
    $('#connected-panel').hidden = !snapshot.connected;
    $('#invite-panel').hidden = !snapshot.hosting;
    $('#disconnect').hidden = snapshot.hosting;
    $('#connection-heading').textContent = snapshot.hosting ? 'You coordinate this network' : 'Paired with your coordinator';
    $('#connection-url').textContent = snapshot.url || '';
    $('#members-list').innerHTML = (s?.peers || []).map(p => `<div class="list-row"><span class="avatar">${escapeHtml(p.name[0].toUpperCase())}</span><div class="detail"><h3>${escapeHtml(p.name)}${p.id === s.account.id ? ' (you)' : ''}</h3><p>Paired device &middot; ${p.id.slice(0, 8)}</p></div><span class="muted">${s.offers.some(o => o.providerId === p.id && o.online && o.enabled) ? 'Sharing' : 'Not sharing'}</span></div>`).join('');
    if (!initialized) {
      $('#hardware-name').value = snapshot.hardware.cpu.slice(0, 80);
      $('#host-name').value = snapshot.hardware.name.slice(0, 80);
      $('#join-name').value = snapshot.hardware.name.slice(0, 80);
      $('#cores').value = Math.max(1, Math.min(2, snapshot.hardware.cores));
      $('#cores').max = snapshot.hardware.cores;
      $('#ram').max = Math.min(32768, Math.floor(snapshot.hardware.ramMb / 2));
      $('#public-url').value = `https://${snapshot.hardware.addresses[0] || '127.0.0.1'}:48721`;
      initialized = true;
    }
    renderMarket(); renderJobs(s); renderWallet(s);
  } catch (error) {
    $('#error-banner').hidden = false;
    $('#error-banner').textContent = error.message;
  } finally { refreshing = false; }
}
document.addEventListener('click', event => {
  const nav = event.target.closest('[data-go], [data-page]');
  if (nav) go(nav.dataset.go || nav.dataset.page);
  const rent = event.target.closest('[data-rent]');
  if (rent) {
    if (!snapshot?.remote?.account.profile) { go('network'); toast('Sign in with Google before starting a job.', true); return; }
    selectedOffer = snapshot.remote.offers.find(o => o.id === rent.dataset.rent);
    $('#rent-title').textContent = selectedOffer.name;
    $('#rent-description').textContent = selectedOffer.kind === 'gpu' ? 'Run a real CUDA FP32 matrix benchmark on this device.' : 'Run a real PBKDF2-SHA256 CPU benchmark with allocated remote memory.';
    $('#rent-error').textContent = '';
    updateQuote();
    $('#rent-dialog').showModal();
  }
  const cancel = event.target.closest('[data-cancel]');
  if (cancel) act(cancel, async () => { await api('cancel', { jobId: cancel.dataset.cancel }); toast('Cancellation requested. The worker will stop on its next heartbeat.'); });
});
$$('[data-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  $$('[data-filter]').forEach(b => b.classList.toggle('selected', b === button));
  renderMarket();
}));
for (const selector of ['#gpu-filter', '#cpu-filter', '#ram-filter', '#available-only']) $(selector).addEventListener('change', renderMarket);
function setPrices(changed) {
  let min = Number($('#price-min-number').value), max = Number($('#price-max-number').value);
  if (changed === 'price-min') min = Number($('#price-min').value);
  if (changed === 'price-max') max = Number($('#price-max').value);
  min = Math.max(0, Math.min(100000, min));
  max = Math.max(0, Math.min(100000, max));
  if (min > max) { if (changed.startsWith('price-min')) max = min; else min = max; }
  $('#price-min-number').value = min; $('#price-max-number').value = max;
  $('#price-min').value = min; $('#price-max').value = max;
  $('#price-label').textContent = `${min.toLocaleString()} - ${max.toLocaleString()} CU`;
  renderMarket();
}
for (const control of ['price-min', 'price-max', 'price-min-number', 'price-max-number']) $(`#${control}`).addEventListener('input', () => setPrices(control));
$('#reset-filters').addEventListener('click', () => {
  filter = 'all';
  $$('[data-filter]').forEach(b => b.classList.toggle('selected', b.dataset.filter === 'all'));
  $('#gpu-filter').value = ''; $('#cpu-filter').value = ''; $('#ram-filter').value = '0';
  $('#available-only').checked = true; $('#sort').value = 'price';
  $('#price-min-number').value = 0; $('#price-max-number').value = 100000;
  setPrices('reset');
});
$('#sort').addEventListener('change', renderMarket);
$('.brand').addEventListener('click', event => { event.preventDefault(); go('market'); });
$('#host-form').addEventListener('submit', event => {
  event.preventDefault();
  act(event.submitter, async () => { await api('host', { name: $('#host-name').value }); toast('Private network created. Invite a second device to exchange compute.'); });
});
$('#join-form').addEventListener('submit', event => {
  event.preventDefault();
  act(event.submitter, async () => { await api('join', { name: $('#join-name').value, invitation: $('#invitation').value.trim() }); $('#invitation').value = ''; toast('Connected. Available hosts appear in Find compute.'); });
});
$('#create-invite').addEventListener('click', event => act(event.currentTarget, async () => {
  const result = await api('invite', { url: $('#public-url').value.trim() });
  $('#created-invite').hidden = false;
  $('#created-invite').value = result.invitation;
  toast('Invitation copied. Send it privately to one trusted peer within 10 minutes.');
}));
$('#disconnect').addEventListener('click', event => act(event.currentTarget, async () => { await api('disconnect'); toast('Disconnected. The network keeps your unit history.'); }));
$('#google-signin').addEventListener('click', event => {
  if (snapshot?.remote?.account.profile) { go('network'); return; }
  if (!snapshot?.googleReady) {
    go('network');
    $('#google-setup').open = true;
    toast(snapshot?.connected ? 'This preview needs a configured release from the developer. No user setup is required.' : 'Join or create a network first, then sign in.', true);
    return;
  }
  act(event.currentTarget, async () => {
    toast('Continue in your browser. Your verified profile will be shared with this network.');
    await api('googleSignIn');
    toast('Signed in. Your development wallet is ready.');
  });
});
$('#sign-out').addEventListener('click', event => act(event.currentTarget, async () => { await api('signOut'); toast('Signed out on this device. Your Google wallet is kept for your next sign-in.'); }));
$('#sharing-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!snapshot?.remote?.account.profile) { go('network'); toast('Sign in with Google before sharing hardware.', true); return; }
  act(event.submitter, async () => {
    await api('share', { name: $('#hardware-name').value, kind: $('#compute-kind').value, cores: Number($('#cores').value), ramMb: Number($('#ram').value), rate: Math.round(Number($('#rate').value) * 1000) });
    toast('Sharing enabled. Your approved resources are available to trusted peers.');
  });
});
$('#pause-button').addEventListener('click', event => act(event.currentTarget, async () => { await api('pause'); toast('New jobs paused. Any current workload will finish.'); }));
$('#gpu-probe').addEventListener('click', event => act(event.currentTarget, async () => {
  $('#gpu-result').textContent = 'Checking CUDA and PyTorch...';
  try {
    const gpu = await api('probeGpu');
    $('#gpu-result').textContent = `Ready: ${gpu.name}`;
    if ($('#compute-kind').value === 'gpu') $('#hardware-name').value = gpu.name;
  } catch (error) { $('#gpu-result').textContent = `Not ready: ${error.message}`; throw error; }
}));
function updateQuote() {
  $('#rent-quote').textContent = `${credits(Math.ceil(selectedOffer.rate * Number($('#rent-seconds').value) / 3600))} CU`;
}
$('#rent-seconds').addEventListener('input', updateQuote);
$('#close-dialog').addEventListener('click', () => $('#rent-dialog').close());
$('#rent-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api('rent', { offerId: selectedOffer.id, seconds: Number($('#rent-seconds').value) });
    $('#rent-dialog').close();
    go('jobs');
    toast('Workload reserved. Waiting for the provider to accept.');
    await refresh();
  } catch (error) { $('#rent-error').textContent = error.message; }
  finally { button.disabled = false; }
});
refresh();
setInterval(refresh, 3000);
