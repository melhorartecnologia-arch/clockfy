import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './lib/migrate.js';
import { startScheduler } from './scheduler.js';
import './subscribers.js';

async function main() {
  await migrate();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[clockfy] listening on http://localhost:${config.port} (${config.env})`);
  });
  if (config.schedulerEnabled) startScheduler();
}

main().catch((err) => { console.error(err); process.exit(1); });
