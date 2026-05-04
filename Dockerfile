# Use a lightweight Node.js image
FROM node:20-alpine

# Install ffmpeg
RUN apk add --no-cache ffmpeg

# Create app directory
WORKDIR /app

# Copy package files and source code
COPY package.json server.js ./

# Ensure the cache directory exists and is writable by the 'node' user
RUN mkdir -p /cache && chown node:node /cache

# Default environment variables
ENV PORT=8081
ENV JRIVER_BASE=http://host.docker.internal:52199
ENV CACHE_DIR=/cache
ENV BUFFER=disk

# Run as a non-root user for security
USER node

EXPOSE 8081

CMD ["node", "server.js"]
