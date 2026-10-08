import { PubSub } from '@google-cloud/pubsub';

const projectId = process.env.PROJECT_ID;

export const pubsub = new PubSub(projectId ? { projectId } : {});

export const TOPICS = {
  ORDER_EVENTS: 'order-events',
  FULFILLMENT_EVENTS: 'fulfillment-events',
  ANALYTICS_EVENTS: 'analytics-events',
};

export async function publish(topicName, payload) {
  await pubsub.topic(topicName).publishMessage({ json: payload });
}

function isAlreadyExists(error) {
  return error?.code === 6 || error?.code === 409;
}

function isPermissionDenied(error) {
  return error?.code === 7 || error?.code === 403 || error?.code === '403';
}

async function ensureTopic(name) {
  let exists;
  try {
    [exists] = await pubsub.topic(name).exists();
  } catch (error) {
    if (isPermissionDenied(error)) {
      console.log(`⚠️  Cannot check topic ${name} (permission denied) - assuming it exists`);
      return;
    }
    throw error;
  }
  if (!exists) {
    try {
      await pubsub.createTopic(name);
      console.log(`✓ Pub/Sub topic created: ${name}`);
    } catch (error) {
      if (isAlreadyExists(error)) return;
      if (isPermissionDenied(error)) {
        console.log(`⚠️  Cannot create topic ${name} (permission denied) - assuming it is pre-provisioned`);
        return;
      }
      throw error;
    }
  }
}

async function ensurePushSubscription({ name, topic, pushEndpoint }) {
  const subscription = pubsub.subscription(name);
  let exists;
  try {
    [exists] = await subscription.exists();
  } catch (error) {
    if (isPermissionDenied(error)) {
      console.log(`⚠️  Cannot check subscription ${name} (permission denied) - assuming it exists`);
      return;
    }
    throw error;
  }
  if (!exists) {
    try {
      await pubsub.createSubscription(pubsub.topic(topic), name, {
        pushConfig: { pushEndpoint },
      });
      console.log(`✓ Pub/Sub subscription created: ${name} -> ${pushEndpoint}`);
    } catch (error) {
      if (isAlreadyExists(error)) {
        await subscription.modifyPushConfig({ pushEndpoint });
        return;
      }
      if (isPermissionDenied(error)) {
        console.log(`⚠️  Cannot create subscription ${name} (permission denied) - assuming it is pre-provisioned`);
        return;
      }
      throw error;
    }
  } else {
    await subscription.modifyPushConfig({ pushEndpoint });
  }
}

async function withRetry(fn, { retries = 10, delayMs = 3000, label }) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) throw error;
      console.log(
        `${label} failed (${error.message}); retrying in ${delayMs / 1000}s... [${attempt}/${retries}]`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// Idempotently creates topics and (optionally) push subscriptions.
// pushEndpoint is typically only set locally; in Cloud Run the
// subscriptions are managed by scripts/gcp-subscriptions.sh.
export async function ensureMessaging({ topics = [], pushSubscriptions = [] } = {}) {
  await withRetry(
    async () => {
      for (const topic of topics) {
        await ensureTopic(topic);
      }
      for (const subscription of pushSubscriptions) {
        if (subscription.pushEndpoint) {
          await ensurePushSubscription(subscription);
        }
      }
    },
    { label: 'Pub/Sub setup' },
  );
}
