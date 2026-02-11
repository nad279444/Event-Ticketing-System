FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY services/analytics/package*.json ./services/analytics/
COPY shared/rabbit/package*.json ./shared/rabbit/

# Install dependencies for analytics
WORKDIR /app/services/analytics
RUN npm install

# Install dependencies for shared/rabbit
WORKDIR /app/shared/rabbit
RUN npm install

# Copy source code
WORKDIR /app
COPY services/analytics ./services/analytics
COPY shared ./shared

# Give node user ownership
RUN chown -R node:node /app

# Switch to node user
USER node

# Set working directory back to analytics
WORKDIR /app/services/analytics

EXPOSE 3000

CMD ["npm", "run", "dev"]