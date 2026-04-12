FROM node:22-bookworm

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

COPY fixture-app/ /app/

RUN npm ci

RUN git init \
  && git config user.name "Harness Two" \
  && git config user.email "h2@example.com" \
  && git add . \
  && git commit -m "fixture snapshot"
