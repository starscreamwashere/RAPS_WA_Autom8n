# Build context is the repo root (see docker-compose.yml) so the image can
# carry db/migrations, which run on every start before the API listens.
FROM node:22-alpine
WORKDIR /app/api
COPY api/package*.json ./
RUN npm ci --omit=dev
COPY api/src ./src
COPY db/migrations /app/db/migrations
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
