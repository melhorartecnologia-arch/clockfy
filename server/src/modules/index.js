// Registry of feature modules. Each module's index.js exports a default object:
//   { name, workspace(router) /* mounts routes under /api/v1/workspaces/:workspaceId */, api(router) /* mounts routes under /api/v1 */ }
import reports from './reports/index.js';
import approvals from './approvals/index.js';
import timeOff from './timeOff/index.js';
import holidays from './holidays/index.js';
import scheduling from './scheduling/index.js';
import expenses from './expenses/index.js';
import invoices from './invoices/index.js';
import webhooks from './webhooks/index.js';
import alerts from './alerts/index.js';
import kiosk from './kiosk/index.js';
import importer from './importer/index.js';
import audit from './audit/index.js';
import accounts from './accounts/index.js';

export const extraModules = [reports, approvals, timeOff, holidays, scheduling, expenses, invoices, webhooks, alerts, kiosk, importer, audit, accounts].filter(Boolean);
