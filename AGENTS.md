# AGENTS.md — OldcordV3

## Environment
- OS: Windows 11 Home, shell: bash (Git Bash / WSL)
- Node.js >= 24.0.0 required (`node --version` to check)
- PostgreSQL required (local or Docker)
- Redis required for sharding (Docker: `docker compose up -d`)

## Build & Run

```bash
# Dev mode (no build needed, uses tsx)
npm run dev:server

# Production
npm start

# Run load balancer (sharding mode)
node --experimental-vm-modules server/loadbalancer.ts
# or with tsx:
npx tsx server/loadbalancer.ts
```

## Sharding Setup

1. Copy `config.example.json` to `config.json`, set `sharding.enabled: true`
2. Start Redis: `docker compose up -d`
3. Start shard 0: `SHARD_ID=0 npx tsx server/index.ts`
4. Start shard 1: `SHARD_ID=1 npx tsx server/index.ts`
5. Start load balancer: `npx tsx server/loadbalancer.ts`

Sharding config in `config.json`:
```json
"sharding": {
  "enabled": true,
  "num_shards": 2,
  "shard_id": 0,
  "redis_url": "redis://127.0.0.1:6379",
  "lb_port": 8080,
  "shard_urls": {
    "0": "ws://127.0.0.1:9000",
    "1": "ws://127.0.0.1:9001"
  }
}
```

## Tests

```bash
# Run functional tests
node --experimental-vm-modules tests/sharding.test.mjs

# Or with tsx
npx tsx tests/sharding.test.ts
```

## Key Architecture Files

- `server/gateway.ts` — WebSocket server
- `server/helpers/session.js` — Session class (per-connection state)
- `server/helpers/dispatcher.js` — Event broadcasting to sessions
- `server/handlers/gateway.js` — Gateway opcode handlers (IDENTIFY, RESUME, etc.)
- `server/sharding/redis.ts` — Redis client singleton
- `server/sharding/ShardManager.ts` — Shard assignment algorithm
- `server/sharding/InterShard.ts` — Cross-shard event delivery via Redis Pub/Sub
- `server/loadbalancer.ts` — WebSocket load balancer (routes by user_id)

## Coding Guidelines

- TypeScript for new files in `server/sharding/` and `server/loadbalancer.ts`
- JavaScript for modifications to existing `.js` files (don't convert them)
- Sharding code is behind `if (global.shardingEnabled)` guards — non-sharded mode must work unchanged
- Use BigInt for Snowflake operations: `BigInt(userId) >> 22n`
- Do NOT use `global.userSessions` directly in new sharding code — use `dispatcher` which handles cross-shard routing

## Linting

```bash
npm run lint        # check
npm run biome:fix   # auto-fix
```
