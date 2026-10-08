const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { request } = require('./network.cjs');

function pythonFile() { return path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'gpu.py'); }
function runProcess(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, shell: false, ...options });
  let stdout = '';
  let stderr = '';
  const promise = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 64000) { child.kill(); reject(new Error('Worker output exceeded limit.')); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(stderr.trim() || `Worker stopped (exit ${code}).`));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error('Worker returned an invalid result.')); }
      }
    });
  });
  return { child, promise };
}
async function probeGpu() {
  const run = runProcess('python', [pythonFile(), 'probe']);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; run.child.kill(); }, 45000);
  try { return await run.promise; }
  catch (error) {
    if (timedOut) throw new Error('GPU readiness check timed out after 45 seconds. Verify that python starts and CUDA-enabled PyTorch imports successfully.');
    throw error;
  }
  finally { clearTimeout(timer); }
}

class ComputeWorker {
  constructor(connection, onError = () => {}) {
    this.connection = connection;
    this.onError = onError;
    this.enabled = false;
    this.running = null;
    this.polling = false;
    this.timer = null;
    this.limits = null;
  }
  async start(offer) {
    if (this.running) throw new Error('Wait for the current job to finish before changing sharing settings.');
    if (offer.cores > Math.min(os.availableParallelism(), 32)) throw new Error('CPU thread limit exceeds this machine.');
    if (offer.ramMb > Math.floor(os.totalmem() / 1024 / 1024 / 2)) throw new Error('Share at most half of system RAM.');
    const gpu = offer.kind === 'gpu' ? await probeGpu() : null;
    offer = { ...offer, cpuModel: os.cpus()[0]?.model || 'Unknown CPU', gpuModel: gpu?.name || '' };
    await request(this.connection, '/offer', { ...offer, enabled: true });
    this.limits = { ...offer };
    this.enabled = true;
    if (!this.timer) this.timer = setInterval(() => this.poll(), 2000);
    await this.poll();
  }
  async stop() {
    this.enabled = false;
    if (this.limits) await request(this.connection, '/offer', { ...this.limits, enabled: false });
    if (!this.running) { clearInterval(this.timer); this.timer = null; }
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const reply = await request(this.connection, '/poll', {});
      if (this.running && (reply.cancel || reply.activeJob !== this.running.job.id)) this.running.child.kill();
      if (reply.activeJob && !this.running) {
        await request(this.connection, '/finish', { jobId: reply.activeJob, success: false, elapsedMs: 0, result: 'Worker no longer has this process; reservation refunded.' });
      }
      if (reply.job) {
        if (!this.enabled || this.running) {
          await request(this.connection, '/finish', { jobId: reply.job.id, success: false, elapsedMs: 0, result: 'Worker was unavailable when the job was assigned.' });
        } else this.execute(reply.job);
      }
    } catch (error) {
      if (this.running) this.running.child.kill();
      this.onError(error.message);
    } finally { this.polling = false; }
  }
  execute(job) {
    const limits = this.limits;
    if (!['cpu', 'gpu'].includes(job.kind) || job.kind !== limits.kind ||
        !Number.isInteger(job.seconds) || job.seconds < 5 || job.seconds > 300 ||
        !Number.isInteger(job.cores) || job.cores < 1 || job.cores > limits.cores ||
        !Number.isInteger(job.ramMb) || job.ramMb < 64 || job.ramMb > limits.ramMb) {
      request(this.connection, '/finish', { jobId: job.id, success: false, elapsedMs: 0, result: 'Rejected job outside locally approved resource limits.' }).catch(error => this.onError(error.message));
      return;
    }
    const command = job.kind === 'gpu' ? 'python' : process.execPath;
    const args = job.kind === 'gpu' ? [pythonFile(), String(job.seconds)] : [path.join(__dirname, 'cpu.cjs'), JSON.stringify({ seconds: job.seconds, cores: job.cores, ramMb: job.ramMb })];
    const run = runProcess(command, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const timer = setTimeout(() => run.child.kill(), (job.seconds + 25) * 1000);
    this.running = { child: run.child, job };
    this.completion = (async () => {
      let body;
      try {
        const result = await run.promise;
        body = { jobId: job.id, success: true, ...result };
      } catch (error) {
        body = { jobId: job.id, success: false, elapsedMs: 0, result: error.message.slice(0, 4000) };
      }
      clearTimeout(timer);
      try { await request(this.connection, '/finish', body); }
      catch (error) { this.onError(`Result settlement failed: ${error.message}. The coordinator will refund an expired lease.`); }
      this.running = null;
      if (!this.enabled) { clearInterval(this.timer); this.timer = null; }
    })();
  }
  async close() {
    clearInterval(this.timer);
    this.timer = null;
    this.enabled = false;
    if (this.running) {
      this.running.child.kill();
      await this.completion;
    }
    if (this.limits) {
      try { await request(this.connection, '/offer', { ...this.limits, enabled: false }); }
      catch (error) { this.onError(`Could not withdraw listing: ${error.message}`); }
    }
  }
}
module.exports = { ComputeWorker, probeGpu };
