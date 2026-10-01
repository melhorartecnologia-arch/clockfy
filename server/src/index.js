import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './lib/migrate.js';
import { startScheduler } from './scheduler.js';
import { recoverInterruptedJobs } from './modules/importer/service.js';
import './subscribers.js';

async function main() {
  await migrate();
  // imports left "running" by a previous process (restart/crash) are marked as interrupted
  await recoverInterruptedJobs().then((n) => { if (n) console.log(`[clockfy] ${n} importação(ões) interrompida(s) marcada(s) como FAILED`); }).catch((err) => console.error('[clockfy] import job recovery failed', err.message));
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[clockfy] listening on http://localhost:${config.port} (${config.env})`);
  });
  if (config.schedulerEnabled) startScheduler();
}

main().catch((err) => { console.error(err); process.exit(1); });
