// fulfillment-service/index.js
import { connectRabbit } from '../../../shared/rabbit/index.js';
import fastify from 'fastify';

// Add HTTP server for Render's port requirement
const app = fastify({ logger: true });
const PORT = process.env.PORT || 10000;

// Health check endpoint (required for Render)
app.get('/', async (req, reply) => {
  return {
    status: 'healthy',
    service: 'fulfillment',
    message: 'Fulfillment service is running and processing orders',
  };
});

app.get('/health', async (req, reply) => {
  return { status: 'healthy' };
});

// Start HTTP server FIRST
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`🚀 Fulfillment HTTP server running on port ${PORT}`);

// Then start RabbitMQ consumer
const { channel } = await connectRabbit();

// Simulated processing times (in ms)
const processingTimes = {
  movie: 2000,
  game: 3000,
  concert: 4000,
  sports: 3500,
};

channel.consume('ticket-order', async (msg) => {
  if (!msg) return;

  const { id, event, customer, quantity } = JSON.parse(msg.content.toString());

  console.log(
    `🎫 Processing ticket order #${id}: ${quantity}x ${event} for ${customer}`,
  );

  // Simulate processing delay
  const processingTime = processingTimes[event] || 2000;
  await new Promise((resolve) => setTimeout(resolve, processingTime));

  console.log(`✅ Fulfilled: ${quantity}x ${event} ticket(s) for ${customer}`);

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
});

console.log('🎫 Ticket Fulfillment Service started - Ready to process orders!');
