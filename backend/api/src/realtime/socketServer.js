import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { authService } from '../services/auth.service.js';

// Events are coalesced per room for this long, so a burst (e.g. recovery
// releasing hundreds of jobs) becomes one message per client.
const FLUSH_MS = 250;
const WORKERS_ROOM = 'workers';
const userRoom = (userId) => `user:${userId}`;

/**
 * Socket.IO relay for committed-state notifications (see PgEventListener).
 * Socket.IO is an enhancement: events are invalidation hints
 * `{ type, id, queueId?, status, activeJobs? }`, and clients reload the data
 * from the API, which applies the usual ownership checks.
 *
 * - Handshake: `auth.token` must be a valid access token. The socket is
 *   disconnected when that token expires.
 * - Routing: job and queue events go only to the owning user's room; worker
 *   events (shared infrastructure) go to every authenticated client.
 * - 'events' carries a batch; 'resync' tells clients to reload everything
 *   (notifications may have been missed).
 */
export function createSocketServer(httpServer, { listener, corsOrigin, logger }) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: corsOrigin, credentials: corsOrigin !== '*' },
    serveClient: false,
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || !token) return next(new Error('UNAUTHORIZED'));
    try {
      const user = await authService.authenticate(token);
      socket.data.userId = user.id;
      socket.data.expiresAt = (jwt.decode(token)?.exp ?? 0) * 1000;
      return next();
    } catch {
      return next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    socket.join([userRoom(socket.data.userId), WORKERS_ROOM]);
    const msLeft = socket.data.expiresAt - Date.now();
    // Node timers overflow above ~24.8 days; tokens are much shorter-lived.
    const expiryTimer = setTimeout(() => {
      socket.emit('session-expired');
      socket.disconnect(true);
    }, Math.max(0, Math.min(msLeft, 2 ** 31 - 1)));
    socket.on('disconnect', () => clearTimeout(expiryTimer));
  });

  // --- coalescing ---------------------------------------------------------
  const pending = new Map(); // room -> Map(eventKey -> event)
  let flushTimer = null;

  const flush = () => {
    flushTimer = null;
    for (const [room, events] of pending) {
      io.to(room).emit('events', [...events.values()]);
    }
    pending.clear();
  };

  const enqueue = (room, event) => {
    if (!pending.has(room)) pending.set(room, new Map());
    pending.get(room).set(`${event.type}:${event.id}`, event); // latest state wins
    flushTimer ??= setTimeout(flush, FLUSH_MS);
  };

  const onEvent = (raw) => {
    const { userId, ...event } = raw; // never forward the owner's ID
    if (event.type === 'worker') enqueue(WORKERS_ROOM, event);
    else if ((event.type === 'job' || event.type === 'queue') && userId) enqueue(userRoom(userId), event);
  };
  const onResync = () => io.emit('resync');

  listener.on('event', onEvent);
  listener.on('resync', onResync);
  logger.info('Socket.IO realtime server attached');

  return {
    io,
    /**
     * Disconnects every socket and closes the HTTP server too (Socket.IO's
     * close() does both), so the caller must not call server.close() again.
     */
    async close() {
      listener.off('event', onEvent);
      listener.off('resync', onResync);
      clearTimeout(flushTimer);
      await new Promise((resolve, reject) => io.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
