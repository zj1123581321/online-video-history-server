# ============================================
# Dockerfile for Online Video History Server
# Multi-platform video watching history manager
# Using multi-stage build to reduce image size
# ============================================

# Stage 1: Build stage (compile native modules)
FROM node:18-alpine AS builder

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install all dependencies (including dev for build)
RUN npm install --omit=dev && npm cache clean --force

# Stage 2: Production stage (minimal runtime)
FROM node:18-alpine

WORKDIR /app

# Copy only the compiled node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy package.json for reference
COPY package.json ./

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
