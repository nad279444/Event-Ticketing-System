FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY services/fulfillment/package*.json ./services/fulfillment/
COPY shared/rabbit/package*.json ./shared/rabbit/

# Install dependencies for fulfillment
WORKDIR /app/services/fulfillment
RUN npm install

# Install dependencies for shared/rabbit
WORKDIR /app/shared/rabbit
RUN npm install

# Copy source code
WORKDIR /app
COPY services/fulfillment ./services/fulfillment
COPY shared ./shared

# Give node user ownership
RUN chown -R node:node /app

# Switch to node user
USER node

# Set working directory back to fulfillment
WORKDIR /app/services/fulfillment

EXPOSE 3000

CMD ["npm", "run", "dev"]