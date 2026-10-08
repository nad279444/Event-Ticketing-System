import 'dotenv/config';
import fastify from 'fastify';
import cors from '@fastify/cors';
import { publish, TOPICS, ensureMessaging } from '../../../shared/pubsub/index.js';
import { pool, initSchema } from '../../../shared/db/index.js';
import {
  VALID_EVENTS,
  PRICES,
  EVENT_DESCRIPTIONS,
} from '../../../shared/common/index.js';

const app = fastify({ logger: true });
const PORT = process.env.PORT || 3000;

await app.register(cors, { origin: '*' });
await initSchema();

try {
  await ensureMessaging({ topics: [TOPICS.ORDER_EVENTS] });
} catch (error) {
  console.warn('⚠️  Pub/Sub setup failed:', error.message);
  console.warn('Orders will 502 on publish until Pub/Sub is reachable');
}

app.post('/order', async (req, reply) => {
  const { event, customer, quantity = 1 } = req.body || {};

  if (!VALID_EVENTS.includes(event)) {
    return reply.code(400).send({
      error: 'Invalid event type',
      validEvents: VALID_EVENTS,
    });
  }

  if (!customer || typeof customer !== 'string' || !customer.trim()) {
    return reply.code(400).send({ error: 'Customer name is required' });
  }

  const qty = Number.parseInt(quantity, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
    return reply
      .code(400)
      .send({ error: 'Quantity must be an integer between 1 and 10' });
  }

  const unitPrice = PRICES[event];

  const { rows } = await pool.query(
    `INSERT INTO orders (event_type, customer, quantity, unit_price, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id, event_type, customer, quantity, unit_price, status, created_at`,
    [event, customer.trim(), qty, unitPrice],
  );

  const order = rows[0];
  const message = {
    id: order.id,
    event: order.event_type,
    customer: order.customer,
    quantity: order.quantity,
    unitPrice: Number(order.unit_price),
    createdAt: new Date(order.created_at).toISOString(),
  };

  try {
    await publish(TOPICS.ORDER_EVENTS, message);
  } catch (error) {
    console.error('Failed to publish order event:', error.message);
    return reply.code(502).send({
      error: 'Order saved but could not be queued for processing',
      orderId: order.id,
    });
  }

  console.log(`📋 Ticket order received: ${qty}x ${event} for ${customer}`);
  reply.send({
    orderId: order.id,
    status: 'processing',
    message: `Your ${event} ticket order is being processed!`,
  });
});

app.get('/orders', async (req, reply) => {
  const [countResult, ordersResult] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS total FROM orders'),
    pool.query(
      `SELECT id, event_type AS event, customer, quantity, unit_price AS "unitPrice",
              status, created_at AS "createdAt", fulfilled_at AS "fulfilledAt"
       FROM orders ORDER BY id DESC LIMIT 50`,
    ),
  ]);
  return { total: countResult.rows[0].total, orders: ordersResult.rows };
});

app.get('/orders/:id', async (req, reply) => {
  const { rows } = await pool.query(
    `SELECT id, event_type AS event, customer, quantity, unit_price AS "unitPrice",
            status, created_at AS "createdAt", fulfilled_at AS "fulfilledAt"
     FROM orders WHERE id = $1`,
    [req.params.id],
  );
  if (!rows.length) {
    return reply.code(404).send({ error: 'Order not found' });
  }
  return rows[0];
});

app.get('/orders/customer/:name', async (req, reply) => {
  const { rows } = await pool.query(
    `SELECT id, event_type AS event, customer, quantity, unit_price AS "unitPrice",
            status, created_at AS "createdAt", fulfilled_at AS "fulfilledAt"
     FROM orders WHERE lower(customer) = lower($1)
     ORDER BY id DESC LIMIT 100`,
    [req.params.name],
  );
  return {
    customer: req.params.name,
    totalOrders: rows.length,
    orders: rows,
  };
});

app.get('/events', async (req, reply) => {
  return {
    events: VALID_EVENTS,
    description: EVENT_DESCRIPTIONS,
    prices: PRICES,
  };
});

app.get('/health', async (req, reply) => {
  return { status: 'healthy', service: 'ticket-api' };
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`🎟️  Ticket Ordering API running on port ${PORT}`);
console.log(`📡 Publishing order events to Pub/Sub topic: ${TOPICS.ORDER_EVENTS}`);
