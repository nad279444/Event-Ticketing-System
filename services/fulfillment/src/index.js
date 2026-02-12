// ticket-api/index.js
import fastify from 'fastify';
import cors from '@fastify/cors';
import { connectRabbit } from '../../../shared/rabbit/index.js';

const app = fastify({ logger: true });
const PORT = process.env.PORT || 3000;

await app.register(cors, { origin: '*' });

const { channel } = await connectRabbit();

// In-memory storage
const orders = [];
let orderIdCounter = 1;

// Valid event types
const VALID_EVENTS = ['movie', 'game', 'concert', 'sports'];

// Processing times
const processingTimes = {
  movie: 2000,
  game: 3000,
  concert: 4000,
  sports: 3500,
};

// Track if consumer is running
let consumerRunning = false;
let consumerTag = null;

// Function to start/restart the consumer
async function ensureConsumerRunning() {
  if (consumerRunning) {
    console.log('✅ Consumer already running');
    return;
  }

  try {
    console.log('🔄 Starting fulfillment consumer...');

    const consumer = await channel.consume(
      'ticket-order',
      async (msg) => {
        if (!msg) return;

        try {
          const { id, event, customer, quantity } = JSON.parse(
            msg.content.toString(),
          );

          console.log(
            `🎫 Processing ticket order #${id}: ${quantity}x ${event} for ${customer}`,
          );

          // Simulate processing delay
          const processingTime = processingTimes[event] || 2000;
          await new Promise((resolve) => setTimeout(resolve, processingTime));

          console.log(
            `✅ Fulfilled: ${quantity}x ${event} ticket(s) for ${customer}`,
          );

          // Send to analytics
          channel.sendToQueue(
            'analytics',
            Buffer.from(
              JSON.stringify({
                id,
                event,
                customer,
                quantity,
                fulfilledAt: new Date().toISOString(),
              }),
            ),
            { persistent: true },
          );

          channel.ack(msg);
        } catch (error) {
          console.error('❌ Error processing order:', error);
          channel.nack(msg, false, true);
        }
      },
      { noAck: false },
    );

    consumerTag = consumer.consumerTag;
    consumerRunning = true;
    console.log('✅ Fulfillment consumer started successfully!');
  } catch (error) {
    console.error('❌ Failed to start consumer:', error);
    consumerRunning = false;
  }
}

// Start consumer on startup
await ensureConsumerRunning();

// Keep-alive: Restart consumer every 5 minutes
setInterval(
  async () => {
    console.log('🔄 Keep-alive check...');
    await ensureConsumerRunning();
  },
  5 * 60 * 1000,
); // Every 5 minutes

// ====== API ENDPOINTS ======

app.post('/order', async (req, reply) => {
  // Ensure consumer is running when new order comes in
  await ensureConsumerRunning();

  const { event, customer, quantity = 1 } = req.body;

  if (!VALID_EVENTS.includes(event)) {
    return reply.code(400).send({
      error: 'Invalid event type',
      validEvents: VALID_EVENTS,
    });
  }

  const order = {
    id: orderIdCounter++,
    event,
    customer,
    quantity,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  orders.push(order);

  channel.sendToQueue(
    'ticket-order',
    Buffer.from(JSON.stringify({ ...order })),
    { persistent: true },
  );

  console.log(
    `📋 Ticket order received: ${quantity}x ${event} for ${customer}`,
  );
  reply.send({
    orderId: order.id,
    status: 'processing',
    message: `Your ${event} ticket order is being processed!`,
  });
});

app.get('/orders', async (req, reply) => {
  await ensureConsumerRunning();
  return { total: orders.length, orders: orders.slice(-50).reverse() };
});

app.get('/orders/:id', async (req, reply) => {
  const order = orders.find((o) => o.id === parseInt(req.params.id));
  if (!order) {
    return reply.code(404).send({ error: 'Order not found' });
  }
  return order;
});

app.get('/orders/customer/:name', async (req, reply) => {
  const customerOrders = orders.filter(
    (o) => o.customer.toLowerCase() === req.params.name.toLowerCase(),
  );
  return {
    customer: req.params.name,
    totalOrders: customerOrders.length,
    orders: customerOrders,
  };
});

app.get('/events', async (req, reply) => {
  return {
    events: VALID_EVENTS,
    description: {
      movie: 'Movie tickets',
      game: 'Gaming event tickets',
      concert: 'Concert tickets',
      sports: 'Sports event tickets',
    },
  };
});

app.get('/health', async (req, reply) => {
  return {
    status: 'healthy',
    service: 'ticket-api',
    fulfillmentConsumer: consumerRunning ? 'running' : 'stopped',
    timestamp: new Date().toISOString(),
  };
});

// Ping endpoint to keep service alive
app.get('/ping', async (req, reply) => {
  await ensureConsumerRunning();
  return {
    pong: true,
    consumer: consumerRunning,
    timestamp: new Date().toISOString(),
  };
});

// ====== START SERVER ======

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`🎟️  Ticket API + Fulfillment running on port ${PORT}`);
console.log(`📡 Listening for orders on RabbitMQ queue: ticket-order`);
