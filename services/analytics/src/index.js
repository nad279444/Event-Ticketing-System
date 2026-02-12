// analytics-service/index.js
import { connectRabbit } from '../../../shared/rabbit/index.js';
import fastify from 'fastify';
import cors from '@fastify/cors';

const app = fastify({ logger: true });
const { channel } = await connectRabbit();

// Enable CORS for frontend access
await app.register(cors, {
  origin: '*',
});
const PORT = process.env.PORT || 4000;
const eventStats = {
  movie: 0,
  game: 0,
  concert: 0,
  sports: 0,
};

const recentOrders = [];
let totalTickets = 0;
let totalRevenue = 0;
const startTime = new Date();

// Ticket prices (for revenue calculation)
const ticketPrices = {
  movie: 15,
  game: 50,
  concert: 75,
  sports: 60,
};

channel.consume('analytics', (msg) => {
  if (!msg) return;

  const { id, event, customer, quantity, fulfilledAt } = JSON.parse(
    msg.content.toString(),
  );

  if (eventStats[event] !== undefined) {
    eventStats[event] += quantity;
  }

  totalTickets += quantity;
  totalRevenue += (ticketPrices[event] || 0) * quantity;

  recentOrders.push({
    id,
    event,
    customer,
    quantity,
    timestamp: fulfilledAt || new Date().toISOString(),
  });

  // Keep only last 100 orders
  if (recentOrders.length > 100) {
    recentOrders.shift();
  }

  console.log(`📊 Analytics: ${quantity}x ${event} ticket(s) for ${customer}`);
  channel.ack(msg);
});

// API Endpoints
app.get('/stats', async (req, reply) => {
  const total = Object.values(eventStats).reduce((a, b) => a + b, 0);
  const uptimeSeconds = Math.floor((new Date() - startTime) / 1000);

  return {
    summary: {
      totalOrders: total,
      totalTickets,
      totalRevenue: `$${totalRevenue.toLocaleString()}`,
      ordersPerMinute:
        total > 0 ? ((total / uptimeSeconds) * 60).toFixed(2) : 0,
      uptime: `${Math.floor(uptimeSeconds / 60)}m ${uptimeSeconds % 60}s`,
    },
    events: Object.entries(eventStats)
      .map(([event, count]) => ({
        event,
        count,
        percentage: total ? Math.round((count / total) * 100) : 0,
        revenue: `$${(ticketPrices[event] * count).toLocaleString()}`,
      }))
      .sort((a, b) => b.count - a.count), // Sort by popularity
    recentOrders: recentOrders.slice(-20).reverse(),
  };
});

app.get('/events/:eventType', async (req, reply) => {
  const eventType = req.params.eventType.toLowerCase();
  if (!eventStats.hasOwnProperty(eventType)) {
    return reply.code(404).send({ error: 'Event type not found' });
  }

  const orders = recentOrders.filter((o) => o.event === eventType);

  return {
    event: eventType,
    totalTickets: eventStats[eventType],
    totalRevenue: `$${(ticketPrices[eventType] * eventStats[eventType]).toLocaleString()}`,
    recentOrders: orders.slice(-10).reverse(),
  };
});

app.get('/health', async (req, reply) => {
  return { status: 'healthy', service: 'analytics' };
});

// Start API server
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`📈 Analytics API running on port ${PORT}`);

// Console logging
setInterval(() => {
  const total = Object.values(eventStats).reduce((a, b) => a + b, 0);
  console.log('╔════════════════════════════════════╗');
  console.log('║     EVENT TICKET ANALYTICS         ║');
  console.log('╚════════════════════════════════════╝');

  Object.entries(eventStats)
    .sort(([, a], [, b]) => b - a)
    .forEach(([event, count]) => {
      const percentage = total ? Math.floor((count / total) * 100) : 0;
      const icon = { movie: '🎬', game: '🎮', concert: '🎵', sports: '🏆' }[
        event
      ];
      console.log(
        `${icon} ${event.padEnd(10)}: ${percentage}% (${count} tickets)`,
      );
    });

  console.log('────────────────────────────────────');
  console.log(`💰 Total Revenue: $${totalRevenue.toLocaleString()}`);
  console.log(`🎟️  Total Tickets: ${totalTickets}`);
  console.log('════════════════════════════════════\n');
}, 10000);
