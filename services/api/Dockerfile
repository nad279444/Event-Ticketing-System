FROM node:20-slim

WORKDIR /app

# Copy package files
COPY services/api/package*.json ./services/api/
COPY shared/pubsub/package*.json ./shared/pubsub/
COPY shared/db/package*.json ./shared/db/

# Install dependencies
WORKDIR /app/services/api
RUN npm install

WORKDIR /app/shared/pubsub
RUN npm install

WORKDIR /app/shared/db
RUN npm install

# Copy source code
WORKDIR /app
COPY services/api ./services/api
COPY shared ./shared

# Give node user ownership
RUN chown -R node:node /app

USER node

WORKDIR /app/services/api

EXPOSE 3000

CMD ["npm", "start"]
