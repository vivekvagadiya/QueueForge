import { EventEmitter } from 'node:events';
import pg from 'pg';
import { retryDelayMs } from '../utils/backoff.js';

export const EVENTS_CHANNEL = 'queueforge_events';

/**
 * Holds one dedicated PostgreSQL connection that LISTENs on the events
 * channel (a pooled connection can't: LISTEN is per session). Notifications
 * arrive only after the sending transaction commits.
 *
 * Emits:
 * - 'event' (payload object) for each notification;
 * - 'resync' after reconnecting, because notifications sent while the
 *   connection was down are lost and clients must reload from the API.
 *
 * Reconnects with backoff until stop() is called.
 */
export class PgEventListener extends EventEmitter {
  constructor({ connectionString, logger }) {
    super();
    this.connectionString = connectionString;
    this.logger = logger;
    this.client = null;
    this.stopped = false;
    this.failures = 0;
    this.connectedOnce = false;
    this.retryTimer = null;
  }

  /** True while the LISTEN connection is up (used by the API readiness report). */
  get connected() {
    return this.client !== null;
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  async connect() {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('notification', (msg) => {
      if (msg.channel !== EVENTS_CHANNEL || !msg.payload) return;
      try {
        this.emit('event', JSON.parse(msg.payload));
      } catch (err) {
        this.logger.warn({ err, payload: msg.payload }, 'Ignoring malformed notification');
      }
    });
    client.on('error', (err) => this.handleDisconnect(client, err));
    client.on('end', () => this.handleDisconnect(client, null));

    try {
      await client.connect();
      await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    } catch (err) {
      client.removeAllListeners('end');
      client.end().catch(() => {});
      this.scheduleReconnect(err);
      return;
    }

    this.client = client;
    this.failures = 0;
    if (this.connectedOnce) {
      this.logger.info('Realtime listener reconnected; asking clients to resync');
      this.emit('resync');
    } else {
      this.logger.info('Realtime listener connected');
    }
    this.connectedOnce = true;
  }

  handleDisconnect(client, err) {
    if (client !== this.client) return; // an old or never-established connection
    this.client = null;
    client.removeAllListeners();
    client.end().catch(() => {});
    if (!this.stopped) this.scheduleReconnect(err);
  }

  scheduleReconnect(err) {
    if (this.stopped || this.retryTimer) return;
    this.failures += 1;
    const wait = retryDelayMs(this.failures, { baseMs: 500, maxMs: 15_000 });
    if (this.failures === 1 || this.failures % 10 === 0) {
      this.logger.warn({ err, retryInMs: wait }, 'Realtime listener disconnected; retrying');
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, wait);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const client = this.client;
    this.client = null;
    if (client) {
      client.removeAllListeners();
      await client.end().catch(() => {});
    }
  }
}
