# ============================================
# Dockerfile for Bilibili History Server
# Multi-platform video watching history manager
# ============================================

FROM node:18-alpine

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first for better caching
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --omit=dev && npm cache clean --force

# Remove build dependencies to reduce image size
RUN apk del python3 make g++

# Copy application source
COPY src/ ./src/
COPY public/ ./public/

# Create data directory
RUN mkdir -p data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Start the server
CMD ["node", "src/index.js"]
