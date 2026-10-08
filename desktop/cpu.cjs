const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { pbkdf2Sync, createHash } = require('node:crypto');

if (!isMainThread) {
  const memory = Buffer.alloc(workerData.ramMb * 1024 * 1024, 0x5a);
  const start = performance.now();
  let iterations = 0;
  let digest;
  while (performance.now() - start < workerData.seconds * 1000) {
    digest = pbkdf2Sync(`fastcompute-${iterations}`, 'fixed-benchmark-input', 10000, 32, 'sha256');
    memory[(iterations * 4096) % memory.length] = digest[0];
    iterations++;
  }
  parentPort.postMessage({ iterations, checksum: createHash('sha256').update(digest).update(memory.subarray(0, 64)).digest('hex') });
} else {
  const job = JSON.parse(process.argv[2]);
  const start = performance.now();
  const tasks = Array.from({ length: job.cores }, () => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { seconds: job.seconds, ramMb: Math.floor(job.ramMb / job.cores) } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`CPU thread exited with ${code}`)); });
  }));
  Promise.all(tasks).then(results => {
    process.stdout.write(JSON.stringify({ elapsedMs: Math.round(performance.now() - start), result: `PBKDF2-SHA256: ${results.reduce((n, r) => n + r.iterations, 0)} batches of 10,000 iterations on ${job.cores} threads. ${job.ramMb} MiB requested. Checksum: ${results[0].checksum}` }));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
