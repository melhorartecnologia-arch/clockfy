import { EventEmitter } from 'node:events';
import { onCommit, outsideTransaction } from './db.js';

// Domain event bus. Modules emit events like 'time_entry.created'; the webhook,
// audit-log, notification and alert subsystems subscribe to them.
class DomainEvents extends EventEmitter {
  emitAsync(name, payload) {
    // Listeners run after the surrounding transaction committed (or on the next tick when there is none),
    // outside of any transaction context, so that external consumers always see committed data.
    onCommit(() => outsideTransaction(() => {
      try { this.emit(name, payload); this.emit('*', { name, ...payload }); } catch (err) { console.error('[events]', name, err); }
    }));
  }
}

export const events = new DomainEvents();
events.setMaxListeners(100);
export default events;
