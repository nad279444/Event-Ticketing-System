FROM node:20-slim

WORKDIR /app

# Copy package files
COPY services/fulfillment/package*.json ./services/fulfillment/
COPY shared/pubsub/package*.json ./shared/pubsub/

# Install dependencies
WORKDIR /app/services/fulfillment
RUN npm install

WORKDIR /app/shared/pubsub
RUN npm install

# Copy source code
WORKDIR /app
COPY services/fulfillment ./services/fulfillment
COPY shared ./shared

# Give node user ownership
RUN chown -R node:node /app

USER node

WORKDIR /app/services/fulfillment

EXPOSE 8081

CMD ["npm", "start"]
