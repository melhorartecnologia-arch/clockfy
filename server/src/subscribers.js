// Side-effect imports registering domain event subscribers (webhook dispatch, notifications, alerts, audit).
// Modules append their subscriber imports here.
import './modules/webhooks/subscribers.js';
import './modules/alerts/subscribers.js';
