FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY services/api/package*.json ./services/api/
COPY shared/rabbit/package*.json ./shared/rabbit/

# Install dependencies for API
WORKDIR /app/services/api
RUN npm install

# Install dependencies for shared/rabbit
WORKDIR /app/shared/rabbit
RUN npm install

# Copy source code
WORKDIR /app
COPY services/api ./services/api
COPY shared ./shared

# Give node user ownership
RUN chown -R node:node /app

# Switch to node user
USER node

# Set working directory back to api
WORKDIR /app/services/api

EXPOSE 3000

CMD ["npm", "run", "dev"]