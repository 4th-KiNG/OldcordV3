/**
 * Gateway Load Balancer
 *
 * Accepts WebSocket connections and proxies them to the correct shard
 * based on the user ID extracted from the IDENTIFY payload.
 *
 * Formula: shard_id = (user_id >> 22) % num_shards
 *
 * Also exposes:
 *   GET /gateway/assign?token=<token>  → { shard_id, ws_url }
 *   GET /gateway/status                → shard health info
 *
 * Run: npx tsx server/loadbalancer.ts
 */

import fs from 'fs';
import { createServer } from 'http';

import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';

import { logText } from './helpers/utils/logger.ts';
import { initRedis, pingRedis } from './sharding/redis.ts';
import { getShardForUser, getShardStatuses } from './sharding/ShardManager.ts';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ShardingConfig {
  enabled: boolean;
  num_shards: number;
  redis_url: string;
  lb_port: number;
  shard_urls: Record<string, string>;
}

interface Config {
  sharding: ShardingConfig;
  db_config?: unknown;
}

const configPath = new URL('../config.json', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const config: Config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const { sharding } = config;

if (!sharding?.enabled) {
  logText('Sharding is not enabled in config.json. Exiting.', 'error');
  process.exit(1);
}

const NUM_SHARDS = sharding.num_shards;
const SHARD_URLS: Record<string, string> = sharding.shard_urls;
const LB_PORT = sharding.lb_port ?? 8080;

logText(`Load balancer starting on port ${LB_PORT}`, 'LB');
logText(`Shards: ${JSON.stringify(SHARD_URLS)}`, 'LB');

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

initRedis(sharding.redis_url);

// ---------------------------------------------------------------------------
// HTTP Express app (for /gateway/assign and /gateway/status)
// ---------------------------------------------------------------------------

const app = express();

app.get('/gateway/assign', async (req, res) => {
  const token = req.query.token as string;

  if (!token) {
    return res.status(400).json({ error: 'token required' });
  }

  // Decode user ID from token (token format: userId.rest)
  const userId = extractUserIdFromToken(token);

  if (!userId) {
    return res.status(401).json({ error: 'invalid token' });
  }

  const shardId = getShardForUser(userId, NUM_SHARDS);
  const wsUrl = SHARD_URLS[String(shardId)];

  return res.status(200).json({
    shard_id: shardId,
    ws_url: wsUrl ?? null,
    num_shards: NUM_SHARDS,
  });
});

app.get('/gateway/status', async (_req, res) => {
  const redisOk = await pingRedis();
  const shards = await getShardStatuses(NUM_SHARDS).catch(() => []);

  return res.status(200).json({
    load_balancer: 'up',
    redis: redisOk ? 'connected' : 'error',
    num_shards: NUM_SHARDS,
    shards,
  });
});

app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// ---------------------------------------------------------------------------
// WebSocket proxy
// ---------------------------------------------------------------------------

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (clientSocket, req) => {
  logText(`[LB] New WS connection from ${req.socket.remoteAddress}`, 'LB');

  // We buffer all messages until we receive IDENTIFY (op 2)
  // to learn the user ID and pick the right shard.
  const buffer: (Buffer | string)[] = [];
  let identified = false;

  clientSocket.on('message', async (data: Buffer | string) => {
    if (identified) return; // proxy takes over after identification

    buffer.push(data);

    // Try to parse as JSON to detect IDENTIFY opcode
    try {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      const packet = JSON.parse(text);

      if (packet.op === 2 && packet.d?.token) {
        identified = true;
        const token: string = packet.d.token;
        const userId = extractUserIdFromToken(token);

        if (!userId) {
          clientSocket.close(4004, 'Authentication failed');
          return;
        }

        const shardId = getShardForUser(userId, NUM_SHARDS);
        const shardUrl = SHARD_URLS[String(shardId)];

        if (!shardUrl) {
          clientSocket.close(1011, `No shard URL configured for shard ${shardId}`);
          return;
        }

        logText(`[LB] User ${userId} → shard ${shardId} (${shardUrl})`, 'LB');

        // Append original WS query params to shard URL
        const url = req.url ?? '/';
        const qIndex = url.indexOf('?');
        const query = qIndex >= 0 ? url.slice(qIndex) : '';
        const targetUrl = shardUrl.replace(/\/$/, '') + query;

        // Connect to target shard
        const shardSocket = new WebSocket(targetUrl, {
          headers: { 'x-forwarded-for': req.socket.remoteAddress ?? '', cookie: req.headers.cookie ?? '' },
        });

        shardSocket.on('open', () => {
          logText(`[LB] Connected to shard ${shardId}`, 'LB');

          // Replay buffered messages (including the IDENTIFY we just parsed)
          for (const msg of buffer) {
            shardSocket.send(msg);
          }

          // Pipe: client → shard
          clientSocket.on('message', (msg: Buffer | string) => {
            if (shardSocket.readyState === WebSocket.OPEN) {
              shardSocket.send(msg);
            }
          });

          // Pipe: shard → client
          shardSocket.on('message', (msg: Buffer | string) => {
            if (clientSocket.readyState === WebSocket.OPEN) {
              clientSocket.send(msg);
            }
          });
        });

        shardSocket.on('close', (code, reason) => {
          clientSocket.close(code, reason);
        });

        shardSocket.on('error', (err) => {
          logText(`[LB] Shard ${shardId} socket error: ${err}`, 'error');
          clientSocket.close(1011, 'Upstream error');
        });

        clientSocket.on('close', () => {
          shardSocket.close();
        });

        clientSocket.on('error', () => {
          shardSocket.close();
        });
      }
    } catch {
      // Not JSON or not IDENTIFY yet — just buffer
    }
  });

  clientSocket.on('close', () => {
    if (!identified) {
      logText('[LB] Client disconnected before IDENTIFY', 'LB');
    }
  });

  clientSocket.on('error', (err) => {
    logText(`[LB] Client socket error: ${err}`, 'error');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract user ID from a Discord-style token.
 * Token format: base64(userId).timestamp.hmac
 * The userId part is base64-encoded.
 */
function extractUserIdFromToken(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const decoded = Buffer.from(parts[0], 'base64').toString('utf8');
    if (/^\d+$/.test(decoded)) {
      return decoded;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(LB_PORT, () => {
  logText(`Load balancer ready on port ${LB_PORT}`, 'LB');
  logText(`  /gateway/assign?token=<token>  → shard assignment`, 'LB');
  logText(`  /gateway/status                → shard health`, 'LB');
  logText(`  ws://localhost:${LB_PORT}      → WebSocket proxy`, 'LB');
});
