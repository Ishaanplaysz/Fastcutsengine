# FastCompute

A Windows desktop private beta for exchanging compute between **trusted devices**. Share CPU and job memory, or an NVIDIA CUDA GPU, set an hourly credit rate, and spend earned credits on another device.

## Install and use

Configured releases are written to `release\FastCompute-Setup-0.2.0-x64.exe`. End users install, connect their network, and click **Sign in with Google**; they never configure OAuth. An explicitly unconfigured UI build is named `FastCompute-Preview-0.2.0-x64.exe` and cannot rent/share until a configured release replaces it. Windows x64 is the only release target currently built. Linux and macOS are planned; the Electron UI and coordinator are portable, but packaging, credential storage, and workers need platform validation. Apple Silicon GPU support will need a Metal/MPS worker.

1. On one PC, open **Account & network > Create network**. This PC is the coordinator; keep the app running.
2. Enter its reachable LAN or private VPN address, e.g. `https://192.168.1.10:48721`, then create an invitation. Allow inbound TCP 48721 on **private networks only** if Windows Firewall blocks peer connections. The app does not change your firewall.
3. Privately send the invitation to a trusted second PC. Install the app there and use **Join network** within ten minutes. Invitations are single-use.
4. Sign in with Google (compulsory; see setup below). On the provider, open **Earn units**, choose resource limits and an hourly CU rate, then start sharing.
5. On the renter, open **Find compute**. Ready hosts appear automatically. Filter by GPU model, CPU model, minimum job RAM, and the inclusive minimum/maximum CU-per-hour budget. Pick **Use host** to run a 5-300 second job. Results appear in **My jobs**, with settled charges in both wallets.

Two devices are needed to earn/spend against another member. Own-device rentals are intentionally blocked. Listings are real: no demo machines, simulated jobs, or fictional utilization statistics are displayed.

The default UI is white and lilac, with the host directory as the home screen. Ready-to-rent filtering hides offline, busy, and own-account hosts; uncheck it to inspect other listings. CPU and GPU models come from providers' hardware reports, not free-form listing names. Job RAM is the memory offered to the workload, not all RAM installed in the host.

**Important:** This installer is unsigned. It is not a production/public marketplace release. Obtain release binaries from a trusted source; do not disable operating-system security protections to install them.

## Supported work

- **CPU + RAM:** Actual PBKDF2-SHA256 batches on the selected number of worker threads, with a resident memory buffer allocated across the workers. Results include batch count and checksum.
- **NVIDIA GPU:** Actual 2048 x 2048 FP32 matrix multiplications using CUDA-enabled PyTorch on the first CUDA device. Results include multiplication count, device, and a result sample.
- **Memory is local to the remote workload.** It is not pooled into the renter's operating system. CPU memory settings describe allocated buffers, not a hard OS-enforced process-memory ceiling. Runtime/library overhead is additional.
- GPU utilization and VRAM are **not** capped by CPU/RAM controls. A GPU workload may fully occupy the GPU for the requested period. The UI states this before sharing.
- The beta does **not** execute user-uploaded code, containers, shell commands, AI training scripts, or arbitrary applications.

For GPU sharing, install Python and a CUDA-enabled PyTorch build compatible with the provider's GPU and NVIDIA driver, following the official PyTorch installation instructions. `python` must be on PATH. Use **Check NVIDIA GPU readiness** before sharing. No GPU dependencies are installed automatically. Blackwell hardware needs a PyTorch/CUDA build that supports that specific GPU.

## Google sign-in: one-time app-owner setup

Google sign-in uses the system browser, OAuth authorization code flow with PKCE S256, a random state, a single-use coordinator nonce, and a loopback-only callback. Both the desktop and coordinator verify the ID token's RS256 signature against Google's keys, audience, issuer, expiration, verified email and nonce. Google access/refresh tokens are not persisted. Your verified name/email and Google subject identifier are stored in your trusted coordinator's ledger.

**A real Google OAuth client must be supplied before live sign-in works.** Keep it out of source control; generated build resources and configured installers contain the Desktop client configuration. This is a one-time developer/app-owner responsibility, never an installation step for users:

1. In Google Cloud, select/create the project that owns FastCompute. Configure Google Auth Platform branding, support email and audience.
2. While the app is in testing, add the Google accounts that will test it. Use only `openid`, `email`, and `profile` scopes.
3. Create an OAuth client of type **Desktop app**, then download its JSON. A web client is not interchangeable.
4. Store that file privately outside this repository and build the release:

```powershell
$env:FASTCOMPUTE_GOOGLE_CLIENT_FILE = "C:\private\fastcompute-desktop-oauth.json"
npm run dist
```

The build embeds the Desktop client configuration in the installer. All users receive the same app-owned client automatically. The release build **fails** if configuration is missing; `npm run dist:preview` is the explicitly unconfigured exception. The generated `.build` directory is Git-ignored and credentials are never logged. Google's consent-screen/testing restrictions still apply; a public rollout may require changing the audience/publication status and completing Google's requirements.

For local source development, you may instead launch with:

```powershell
$env:FASTCOMPUTE_GOOGLE_CLIENT_ID = "<your-desktop-client-id>.apps.googleusercontent.com"
$env:FASTCOMPUTE_GOOGLE_CLIENT_SECRET = "<your-desktop-client-secret>"
npm start
```

Installed users need no environment variables. Developer environment overrides take precedence over the bundled configuration. Keep real configuration files out of Git. A bundled desktop client is inherently extractable and cannot be treated as a confidential server secret; PKCE protects this installed-app flow. Never bundle credentials for a confidential web client. Configure clients/test users at <https://console.cloud.google.com/auth/clients>. Reference: <https://developers.google.com/identity/protocols/oauth2/native-app>.

The environment must allow Google's browser sign-in, token endpoint and public signing-key endpoint. If corporate policy blocks them, ask your administrator; do not disable protections. Sign-in requires an existing network connection. The app explicitly explains missing configuration rather than displaying a fake signed-in account.

**Allowance:** each verified Google account gets **10,000 compute units (CU)** once per coordinator network during development. Multiple devices signed into that Google account share the same wallet; repeated logins do not reset the balance. Own-account rentals across devices are blocked. Pause sharing and finish/cancel active jobs before signing in/out. Signing out on one device preserves the wallet and other devices' sessions.

**Google sign-in is compulsory:** unsigned devices receive zero units and cannot rent or share, even if Google is not configured. There is no guest bypass or device allowance. You can connect a network and browse hosts before signing in. Missing OAuth configuration blocks compute actions until the developer supplies it.

Allowances and identities are scoped to a coordinator, not a global service. Deleting coordinator data or starting another network resets that test economy. Production identity/revocation and a centralized or federated global directory are not implemented.

## Compute-unit model

- Compute units (CU, previously called credits) are a **closed test economy with no cash value**, not cryptocurrency.
- The coordinator maintains the authoritative balance. It is trusted, not decentralized or tamper-proof.
- Amounts are integer millicredits (1 credit = 1,000 millicredits). Rates support 0.001-credit precision, starting at 0.1 credit/hour.
- Starting a job reserves its maximum duration cost. A completed job charges measured runtime, capped at the reservation and rounded up to a millicredit.
- Earnings are transferred to the provider; unused reservations are returned to the renter. The settlement operation is idempotent.
- Failed, cancelled, or expired jobs are completely refunded. This trusted-beta policy is deliberately not abuse-resistant.
- A worker heartbeats every two seconds. A 20-second lease timeout fails a disconnected job and refunds the reservation.
- Restarting a coordinator refunds all unfinished jobs and marks providers offline until they reconnect. Sharing never starts automatically after the desktop app restarts.
- Version 0.1 device balances/history are preserved in the migrated ledger but are not transferred or granted to Google wallets. The old ledger is backed up as `ledger.json.v1-backup` before schema migration. Migration never identifies a legacy device as a Google user. A first verified Google sign-in creates the new 10,000 CU person-level wallet.
- Do not invite untrusted users: there is no Sybil resistance, dispute handling, independent usage verification, or cash-out.

## Connectivity and data

The coordinator listens on TCP 48721. Requests use TLS and a pinned coordinator certificate carried in the invitation; no bearer token is sent before the certificate is verified. Google is contacted only for configured sign-in/identity verification. No public discovery, NAT traversal, relay, telemetry, or blockchain is used. This is **coordinator-mediated networking**, not a public decentralized P2P protocol. The available-host list is the connected network's directory, not a worldwide marketplace.

Only fixed workload parameters and small results travel over the network. Work executes on the provider's CPU/GPU. Keep the coordinator and both peers on a trusted LAN or private VPN. The coordinator can see and modify the ledger and all network records. A provider can lie about benchmark results or usage; pair only with people you trust.

Desktop connection credentials are encrypted with Electron `safeStorage` (Windows DPAPI). The coordinator certificate key and JSON ledger are stored in Electron's per-user application data directory (`%APPDATA%\FastCompute` or `%APPDATA%\fastcompute`, depending on packaging). Protect this folder with OS account permissions and disk encryption; administrators and software running as your user can access it. Back it up with the app closed. The JSON ledger uses atomic replacement; it is not a high-scale database or a power-loss-hardened financial ledger.

Disconnecting removes local pairing, not the coordinator ledger. Rejoin and sign into the same Google account to recover that wallet on the same network. Closing the coordinator stops the network but retains data. Avoid reinstalling/deleting its data to reset balances.

## Development

Node.js 22+ and npm are required:

```powershell
npm install
npm start
npm test
npm run check
npm run test:ui
# Configured release: requires the app owner's Desktop OAuth JSON.
npm run dist
# UI preview only, with mandatory sign-in still blocking compute:
npm run dist:preview
```

The build creates an NSIS Windows x64 installer and an unpacked application. No administrator privileges are needed for the default per-user installation. Electron Builder downloads its runtime and NSIS tooling when building.

The UI smoke test launches the desktop with a temporary isolated profile, mocks Google responses with a test-only RSA key, signs in through the OAuth flow, pairs a test peer, runs real CPU jobs in both directions, and checks credit settlement and filters. It does not contact Google or use real Google credentials. Set `FASTCOMPUTE_TEST_EXE` to an unpacked executable path to exercise a packaged build. `FASTCOMPUTE_DATA_DIR` optionally overrides the desktop data directory (absolute paths only); never point tests at your real profile. Mock OAuth code lives in `scripts\oauth-fixture.cjs` and is excluded from the release package.

## Layout

- `desktop\main.cjs`: Electron lifecycle, encrypted settings, restricted IPC.
- `desktop\network.cjs`: certificate-pinned transport, coordinator, durable credit ledger.
- `desktop\google.cjs`: browser OAuth, PKCE and ID-token verification using Node built-ins.
- `desktop\worker.cjs`: opt-in worker, resource validation, process lifecycle.
- `desktop\cpu.cjs`, `desktop\gpu.py`: fixed CPU and CUDA workloads.
- `ui\`: offline desktop UI with no external fonts or assets.
- `tests\exchange.test.cjs`: local multi-client TLS integration tests including real CPU execution and accounting.
- `tests\identity-market.test.cjs`: OAuth protocol tests with mocked Google responses, signature/claim rejection, per-person grants, migration and combined host filters. These do not substitute for a live Google consent-flow check with your registered client.
- `tests\release.test.cjs`: isolated release checks for missing configuration, rejected web clients, required Desktop fields, credential-free logs, and clearing stale configuration in preview builds.

Before a public release: add signed installers, supported-platform CI, real workload sandboxing and hard resource quotas, independently verifiable metering, robust identity/revocation/recovery, coordinator backup/recovery and migration, abuse prevention, audit retention, and a production-grade transactional database. Public P2P and arbitrary GPU rentals are separate future milestones, not implemented features.
