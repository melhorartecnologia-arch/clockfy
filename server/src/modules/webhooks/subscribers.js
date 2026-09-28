// Registers webhook dispatch on domain events and the retry job for failed deliveries.
import { events } from '../../lib/events.js';
import { registerJob } from '../../scheduler.js';
import { DOMAIN_EVENTS, handleDomainEvent, processPendingDeliveries } from './service.js';

for (const name of Object.keys(DOMAIN_EVENTS)) {
  events.on(name, (payload) => {
    handleDomainEvent(name, payload || {}).catch((err) => console.error('[webhooks]', name, err.message));
  });
}

// Failed deliveries are retried with exponential backoff (1min, 5min, 30min, 2h, 6h)
registerJob('webhook-retries', 60_000, () => processPendingDeliveries());
