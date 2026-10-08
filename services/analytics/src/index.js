import 'dotenv/config';
import fastify from 'fastify';
import cors from '@fastify/cors';
import { pool, initSchema } from '../../../shared/db/index.js';
import { TOPICS, ensureMessaging } from '../../../shared/pubsub/index.js';
import {
  VALID_EVENTS,
  PRICES,
  decodePushBody,
} from '../../../shared/common/index.js';

const app = fastify({ logger: true });
const PORT = process.env.PORT || 4000;
const PUSH_ENDPOINT = process.env.PUSH_ENDPOINT;
const startTime = new Date();

await app.register(cors, { origin: '*' });
await initSchema();

try {
  await ensureMessaging({
    topics: [TOPICS.ANALYTICS_EVENTS],
    pushSubscriptions: [
      {
        name: 'analytics-sub',
        topic: TOPICS.ANALYTICS_EVENTS,
        pushEndpoint: PUSH_ENDPOINT,
      },
    ],
  });
} catch (error) {
  console.warn('⚠️  Pub/Sub setup failed:', error.message);
}

// Records a fulfilled order. Idempotent: redelivered messages just
// re-mark the same row as fulfilled.
async function recordFulfillment(order) {
  const { id, event, customer, quantity, unitPrice, fulfilledAt } = order;

  await pool.query(
    `INSERT INTO orders (id, event_type, customer, quantity, unit_price, status, fulfilled_at)
     VALUES ($1, $2, $3, $4, $5, 'fulfilled', $6)
     ON CONFLICT (id) DO UPDATE
       SET status = 'fulfilled', fulfilled_at = EXCLUDED.fulfilled_at`,
    [
      id,
      event,
      customer,
      quantity,
      unitPrice ?? PRICES[event] ?? 0,
      fulfilledAt || new Date().toISOString(),
    ],
  );

  console.log(`📊 Analytics: ${quantity}x ${event} ticket(s) for ${customer}`);
}

// Pub/Sub push delivery handler. Returning 2xx acknowledges the message.
async function handlePush(req, reply) {
  const order = decodePushBody(req.body);
  if (!order || order.id === undefined) {
    return reply.code(400).send({ error: 'Invalid Pub/Sub push payload' });
  }

  try {
    await recordFulfillment(order);
    reply.send({ ok: true });
    broadcastStats().catch((error) =>
      console.error('SSE broadcast failed:', error.message),
    );
  } catch (error) {
    console.error('❌ Error recording fulfillment:', error);
    reply.code(500).send({ error: 'Recording failed' });
  }
}

app.post('/', handlePush);
app.post('/push', handlePush);

async function computeStats() {
  const [summaryResult, eventsResult, recentResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total_orders,
              COALESCE(SUM(quantity), 0)::int AS total_tickets,
              COALESCE(SUM(quantity * unit_price), 0)::int AS total_revenue,
              MIN(created_at) AS first_order_at
       FROM orders`,
    ),
    pool.query(
      `SELECT event_type,
              COUNT(*)::int AS orders,
              COALESCE(SUM(quantity), 0)::int AS tickets,
              COALESCE(SUM(quantity * unit_price), 0)::int AS revenue
       FROM orders GROUP BY event_type`,
    ),
    pool.query(
      `SELECT id, event_type AS event, customer, quantity,
              fulfilled_at AS timestamp
       FROM orders ORDER BY id DESC LIMIT 20`,
    ),
  ]);

  const summary = summaryResult.rows[0];
  const totalTickets = summary.total_tickets;
  const firstOrderAt = summary.first_order_at
    ? new Date(summary.first_order_at)
    : null;

  const uptimeSeconds = Math.floor((new Date() - startTime) / 1000);
  const ordersPerMinute = (() => {
    if (!firstOrderAt || summary.total_orders === 0) return 0;
    const elapsedMinutes = Math.max(
      (Date.now() - firstOrderAt.getTime()) / 60000,
      1 / 60, // avoid dividing by ~0 for very fresh data
    );
    return (summary.total_orders / elapsedMinutes).toFixed(2);
  })();

  const byEvent = Object.fromEntries(
    eventsResult.rows.map((row) => [row.event_type, row]),
  );

  return {
    summary: {
      totalOrders: summary.total_orders,
      totalTickets,
      totalRevenue: `$${Number(summary.total_revenue).toLocaleString()}`,
      ordersPerMinute,
      uptime: `${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`,
    },
    events: VALID_EVENTS.map((event) => {
      const row = byEvent[event];
      const tickets = row?.tickets ?? 0;
      return {
        event,
        count: tickets,
        percentage: totalTickets
          ? Math.round((tickets / totalTickets) * 100)
          : 0,
        revenue: `$${(row?.revenue ?? 0).toLocaleString()}`,
      };
    }).sort((a, b) => b.count - a.count),
    recentOrders: recentResult.rows,
  };
}

app.get('/stats', async (req, reply) => {
  return computeStats();
});

// ====== SSE: live stats stream ======
// Connected dashboards get a snapshot on connect and an update pushed
// every time an order is fulfilled.
const sseClients = new Set();
const HEARTBEAT_MS = 15000;

function sendEvent(res, name, data) {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  return true;
}

async function broadcastStats() {
  if (sseClients.size === 0) return;
  const stats = await computeStats();
  for (const res of [...sseClients]) {
    if (!sendEvent(res, 'stats', stats)) {
      sseClients.delete(res);
    }
  }
}

app.get('/stats/stream', async (req, reply) => {
  reply.hijack();
  const res = reply.raw;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'X-Accel-Buffering': 'no',
  });

  try {
    sendEvent(res, 'stats', await computeStats());
  } catch (error) {
    console.error('SSE initial snapshot failed:', error.message);
    res.end();
    return;
  }

  sseClients.add(res);
  console.log(`🔊 SSE client connected (${sseClients.size} total)`);

  const heartbeat = setInterval(() => {
    if (res.destroyed || res.writableEnded) return;
    res.write(': keepalive\n\n');
  }, HEARTBEAT_MS);

  req.raw.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log(`🔇 SSE client disconnected (${sseClients.size} total)`);
  });
});

app.get('/events/:eventType', async (req, reply) => {
  const eventType = req.params.eventType.toLowerCase();
  if (!VALID_EVENTS.includes(eventType)) {
    return reply.code(404).send({ error: 'Event type not found' });
  }

  const [statsResult, recentResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS orders,
              COALESCE(SUM(quantity), 0)::int AS tickets,
              COALESCE(SUM(quantity * unit_price), 0)::int AS revenue
       FROM orders WHERE event_type = $1`,
      [eventType],
    ),
    pool.query(
      `SELECT id, event_type AS event, customer, quantity,
              fulfilled_at AS timestamp
       FROM orders WHERE event_type = $1 ORDER BY id DESC LIMIT 10`,
      [eventType],
    ),
  ]);

  const stats = statsResult.rows[0];

  return {
    event: eventType,
    totalOrders: stats.orders,
    totalTickets: stats.tickets,
    totalRevenue: `$${Number(stats.revenue).toLocaleString()}`,
    price: PRICES[eventType],
    recentOrders: recentResult.rows,
  };
});

app.get('/health', async (req, reply) => {
  return { status: 'healthy', service: 'analytics' };
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`📈 Analytics API running on port ${PORT}`);
console.log(`📡 Consuming Pub/Sub topic: analytics-events (push)`);

// Console reporting
setInterval(async () => {
  try {
    const { rows } = await pool.query(
      `SELECT event_type, COALESCE(SUM(quantity), 0)::int AS tickets,
              COALESCE(SUM(quantity * unit_price), 0)::int AS revenue
       FROM orders GROUP BY event_type ORDER BY tickets DESC`,
    );
    const totalTickets = rows.reduce((sum, r) => sum + r.tickets, 0);
    const totalRevenue = rows.reduce((sum, r) => sum + r.revenue, 0);

    console.log('╔════════════════════════════════════╗');
    console.log('║     EVENT TICKET ANALYTICS         ║');
    console.log('╚════════════════════════════════════╝');

    rows.forEach(({ event_type, tickets }) => {
      const percentage = totalTickets
        ? Math.floor((tickets / totalTickets) * 100)
        : 0;
      const icon = { movie: '🎬', game: '🎮', concert: '🎵', sports: '🏆' }[
        event_type
      ];
      console.log(
        `${icon} ${event_type.padEnd(10)}: ${percentage}% (${tickets} tickets)`,
      );
    });

    console.log('────────────────────────────────────');
    console.log(`💰 Total Revenue: $${totalRevenue.toLocaleString()}`);
    console.log(`🎟️  Total Tickets: ${totalTickets}`);
    console.log('════════════════════════════════════\n');
  } catch (error) {
    console.error('Analytics report failed:', error.message);
  }
}, 10000);
