FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json .
RUN npm install --production

# Copy application files
COPY src/ ./src/
COPY public/ ./public/

# Create data directory for SQLite
RUN mkdir -p /data

# Expose port
EXPOSE 3000

# Environment variables (can be overridden at runtime)
ENV PORT=3000
ENV DB_PATH=/data/quiz.db
ENV ADMIN_SECRET=admin1234

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://localhost:3000/api/quiz/validate?token=health || exit 1

CMD ["node", "src/server.js"]
