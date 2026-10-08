export const VALID_EVENTS = ['movie', 'game', 'concert', 'sports'];

export const PRICES = {
  movie: 15,
  game: 50,
  concert: 75,
  sports: 60,
};

export const EVENT_DESCRIPTIONS = {
  movie: 'Movie tickets',
  game: 'Gaming event tickets',
  concert: 'Concert tickets',
  sports: 'Sports event tickets',
};

export const PROCESSING_TIMES_MS = {
  movie: 2000,
  game: 3000,
  concert: 4000,
  sports: 3500,
};

// Decodes the JSON body of a Pub/Sub push delivery into a JS object.
// Returns null if the body is not a valid push envelope.
export function decodePushBody(body) {
  if (!body || !body.message || typeof body.message.data !== 'string') {
    return null;
  }
  try {
    return JSON.parse(
      Buffer.from(body.message.data, 'base64').toString('utf8'),
    );
  } catch {
    return null;
  }
}
