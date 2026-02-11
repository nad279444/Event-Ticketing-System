// ticket-api/index.js
import fastify from 'fastify';
import cors from '@fastify/cors';
import { connectRabbit } from '../../../shared/rabbit/index.js';

const app = fastify({ logger: true });
const PORT = 3000;

await app.register(cors, { origin: '*' });

let channel = null;
let connectionReady = false;

// Connect to RabbitMQ in the background without blocking server startup
connectRabbit()
  .then(({ channel: rabbitChannel }) => {
    channel = rabbitChannel;
    connectionReady = true;
    console.log('✓ RabbitMQ connection established');
  })
  .catch((error) => {
    console.error('⚠️  RabbitMQ connection failed:', error.message);
    console.log(
      'Server will continue running - messages queued when connection is restored',
    );
  });

// In-memory storage (replace with database later)
const orders = [];
let orderIdCounter = 1;

// Valid event types
const VALID_EVENTS = ['movie', 'game', 'concert', 'sports'];

app.post('/order', async (req, reply) => {
  const { event, customer, quantity = 1 } = req.body;

  // Validate event type
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

  // Send to RabbitMQ only if connection is ready
  if (channel && connectionReady) {
    try {
      channel.sendToQueue(
        'ticket-order',
        Buffer.from(JSON.stringify({ ...order })),
        { persistent: true },
      );
    } catch (error) {
      console.error('Failed to send message to RabbitMQ:', error.message);
    }
  } else {
    console.warn(
      '⚠️  RabbitMQ not connected - order created but not queued for processing',
    );
  }

  console.log(
    `📋 Ticket order received: ${quantity}x ${event} for ${customer}`,
  );
  reply.send({
    orderId: order.id,
    status: 'processing',
    message: `Your ${event} ticket order is being processed!`,
  });
});

// Get all orders
app.get('/orders', async (req, reply) => {
  return {
    total: orders.length,
    orders: orders.slice(-50).reverse(),
  };
});

// Get order by ID
app.get('/orders/:id', async (req, reply) => {
  const order = orders.find((o) => o.id === parseInt(req.params.id));
  if (!order) {
    return reply.code(404).send({ error: 'Order not found' });
  }
  return order;
});

// Get orders by customer
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

// Get valid event types
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
  return { status: 'healthy', service: 'ticket-api' };
});

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`🎟️  Ticket Ordering API running on port ${PORT}`);
