import 'dotenv/config';
import fastify from 'fastify';
import cors from '@fastify/cors';
import { publish, TOPICS, ensureMessaging } from '../../../shared/pubsub/index.js';
import {
  PROCESSING_TIMES_MS,
  decodePushBody,
} from '../../../shared/common/index.js';

const app = fastify({ logger: true });
const PORT = process.env.PORT || 3000;
const PUSH_ENDPOINT = process.env.PUSH_ENDPOINT;

await app.register(cors, { origin: '*' });

try {
  await ensureMessaging({
    topics: [TOPICS.ORDER_EVENTS, TOPICS.ANALYTICS_EVENTS],
    pushSubscriptions: [
      {
        name: 'fulfillment-sub',
        topic: TOPICS.ORDER_EVENTS,
        pushEndpoint: PUSH_ENDPOINT,
      },
    ],
  });
} catch (error) {
  console.warn('⚠️  Pub/Sub setup failed:', error.message);
}

async function fulfillOrder(order) {
  const { id, event, customer, quantity } = order;

  console.log(
    `🎫 Processing ticket order #${id}: ${quantity}x ${event} for ${customer}`,
  );

  // Simulate processing delay
  const processingTime = PROCESSING_TIMES_MS[event] || 2000;
  await new Promise((resolve) => setTimeout(resolve, processingTime));

  console.log(`✅ Fulfilled: ${quantity}x ${event} ticket(s) for ${customer}`);

  await publish(TOPICS.ANALYTICS_EVENTS, {
    ...order,
    fulfilledAt: new Date().toISOString(),
  });
}

// Pub/Sub push delivery handler. Returning 2xx acknowledges the message;
// any other status makes Pub/Sub redeliver.
async function handlePush(req, reply) {
  const order = decodePushBody(req.body);
  if (!order || order.id === undefined) {
    return reply.code(400).send({ error: 'Invalid Pub/Sub push payload' });
  }

  try {
    await fulfillOrder(order);
    reply.send({ ok: true });
  } catch (error) {
    console.error('❌ Error fulfilling order:', error);
    reply.code(500).send({ error: 'Fulfillment failed' });
  }
}

app.post('/', handlePush);
app.post('/push', handlePush);

app.get('/health', async (req, reply) => {
  return {
    status: 'healthy',
    service: 'fulfillment',
    timestamp: new Date().toISOString(),
  };
});

app.get('/ping', async (req, reply) => {
  return { pong: true, timestamp: new Date().toISOString() };
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`⚙️  Fulfillment service running on port ${PORT}`);
console.log(`📡 Consuming Pub/Sub topic: ${TOPICS.ORDER_EVENTS} (push)`);
console.log(`📡 Publishing to Pub/Sub topic: ${TOPICS.ANALYTICS_EVENTS}`);
