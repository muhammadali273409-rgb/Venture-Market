# ── Base ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

# ── Dependencies ─────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci

# ── Development ──────────────────────────────────────────────────────────
FROM base AS development
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# ── Build ────────────────────────────────────────────────────────────────
FROM base AS build
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build && npm prune --omit=dev

# ── Production ───────────────────────────────────────────────────────────
FROM base AS production
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
USER node
EXPOSE 3000
# Apply pending migrations on every start (Render free plan has no pre-deploy
# step). migrate deploy only runs unapplied migrations and never resets data;
# if it fails, the app does not start, so the old instance keeps serving.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/main.js"]
