import { migrate } from '../lib/migrate.js';
import { close } from '../lib/db.js';

migrate().then(async () => { console.log('[migrate] done'); await close(); }).catch(async (e) => { console.error(e); await close(); process.exit(1); });
