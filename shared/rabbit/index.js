import amqp from 'amqplib';

const MAX_RETRIES = 10;
const RETRY_DELAY = 5000; // 5 seconds

async function connectWithRetry(retries = 0) {
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL not set');

  try {
    console.log(
      `Attempting to connect to RabbitMQ... (attempt ${retries + 1}/${MAX_RETRIES})`,
    );

    const connection = await amqp.connect(url);
    const channel = await connection.createChannel();

    // Assert queues for event ticketing
    await channel.assertQueue('ticket-order', { durable: true });
    await channel.assertQueue('analytics', { durable: true });

    console.log('✓ Connected to RabbitMQ successfully!');
    return { connection, channel };
  } catch (error) {
    if (retries < MAX_RETRIES) {
      console.log(
        `Failed to connect to RabbitMQ. Retrying in ${RETRY_DELAY / 1000}s...`,
      );
      console.log(`Error: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      return connectWithRetry(retries + 1);
    }
    throw new Error(
      `Failed to connect to RabbitMQ after ${MAX_RETRIES} attempts: ${error.message}`,
    );
  }
}

export async function connectRabbit() {
  return await connectWithRetry();
}
