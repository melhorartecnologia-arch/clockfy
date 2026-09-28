import { EventEmitter } from 'node:events';

// Domain event bus. Modules emit events like 'time_entry.created'; the webhook,
// audit-log, notification and alert subsystems subscribe to them.
class DomainEvents extends EventEmitter {
  emitAsync(name, payload) {
    // Listeners run after the current transaction finished (next tick) so that
    // external consumers see committed data.
    setImmediate(() => {
      try { this.emit(name, payload); this.emit('*', { name, ...payload }); } catch (err) { console.error('[events]', name, err); }
    });
  }
}

export const events = new DomainEvents();
events.setMaxListeners(100);
export default events;
