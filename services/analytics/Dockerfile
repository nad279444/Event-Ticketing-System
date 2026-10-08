FROM node:20-slim

WORKDIR /app

# Copy package files
COPY services/analytics/package*.json ./services/analytics/
COPY shared/db/package*.json ./shared/db/
COPY shared/pubsub/package*.json ./shared/pubsub/

# Install dependencies
WORKDIR /app/services/analytics
RUN npm install

WORKDIR /app/shared/db
RUN npm install

WORKDIR /app/shared/pubsub
RUN npm install

# Copy source code
WORKDIR /app
COPY services/analytics ./services/analytics
COPY shared ./shared

# Give node user ownership
RUN chown -R node:node /app

USER node

WORKDIR /app/services/analytics

EXPOSE 4000

CMD ["npm", "start"]
