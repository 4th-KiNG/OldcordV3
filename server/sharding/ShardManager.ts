import { logText } from '../helpers/utils/logger.ts';
import { getPublisher } from './redis.ts';

export interface ShardConfig {
  enabled: boolean;
  num_shards: number;
  shard_id: number;
  redis_url: string;
  lb_port?: number;
  shard_urls: Record<string, string>;
}

// Shard assignment: Discord-compatible formula using Snowflake timestamp bits
export function getShardForUser(userId: string, numShards: number): number {
  try {
    return Number(BigInt(userId) >> 22n) % numShards;
  } catch {
    return 0;
  }
}

// Session metadata in Redis
const SESSION_TTL = 86400; // 24 hours

export async function registerSession(
  sessionId: string,
  userId: string,
  shardId: number,
  status: string,
): Promise<void> {
  const pub = getPublisher();
  const pipeline = pub.pipeline();

  pipeline.hset(`session:${sessionId}`, 'userId', userId, 'shardId', String(shardId));
  pipeline.expire(`session:${sessionId}`, SESSION_TTL);

  pipeline.sadd(`user:sessions:${userId}`, `${sessionId}:${shardId}`);
  pipeline.expire(`user:sessions:${userId}`, SESSION_TTL);

  pipeline.set(`presence:${userId}`, status, 'EX', SESSION_TTL);

  // Shard heartbeat so health endpoint knows this shard is alive
  pipeline.set(`shard:alive:${shardId}`, Date.now().toString(), 'EX', 30);

  await pipeline.exec();
}

export async function unregisterSession(
  sessionId: string,
  userId: string,
  shardId: number,
): Promise<void> {
  const pub = getPublisher();
  const pipeline = pub.pipeline();

  pipeline.del(`session:${sessionId}`);
  pipeline.srem(`user:sessions:${userId}`, `${sessionId}:${shardId}`);

  await pipeline.exec();

  // Check if user has any remaining sessions
  const remaining = await pub.scard(`user:sessions:${userId}`);
  if (remaining === 0) {
    await pub.del(`presence:${userId}`);
  }
}

export async function updatePresenceInRedis(userId: string, status: string): Promise<void> {
  await getPublisher().set(`presence:${userId}`, status, 'EX', SESSION_TTL);
}

export async function getPresenceFromRedis(userId: string): Promise<string | null> {
  return getPublisher().get(`presence:${userId}`);
}

export async function isUserOnline(userId: string): Promise<boolean> {
  const count = await getPublisher().scard(`user:sessions:${userId}`);
  return count > 0;
}

export async function getUserShards(userId: string): Promise<number[]> {
  const entries = await getPublisher().smembers(`user:sessions:${userId}`);
  const shards = new Set<number>();
  for (const entry of entries) {
    const parts = entry.split(':');
    if (parts.length >= 2) {
      shards.add(Number(parts[parts.length - 1]));
    }
  }
  return Array.from(shards);
}

export async function getSessionShard(sessionId: string): Promise<number | null> {
  const data = await getPublisher().hgetall(`session:${sessionId}`);
  if (!data || !data.shardId) return null;
  return Number(data.shardId);
}

// Shard heartbeat for health checks
export async function heartbeatShard(shardId: number, sessionCount: number): Promise<void> {
  const pub = getPublisher();
  await pub.hset(
    `shard:status:${shardId}`,
    'alive', '1',
    'sessions', String(sessionCount),
    'ts', String(Date.now()),
  );
  await pub.expire(`shard:status:${shardId}`, 30);
}

export async function getShardStatuses(numShards: number): Promise<Record<string, unknown>[]> {
  const pub = getPublisher();
  const statuses: Record<string, unknown>[] = [];

  for (let i = 0; i < numShards; i++) {
    const data = await pub.hgetall(`shard:status:${i}`);
    const ts = data?.ts ? Number(data.ts) : 0;
    statuses.push({
      shard_id: i,
      healthy: data?.alive === '1' && Date.now() - ts < 25000,
      sessions: data?.sessions ? Number(data.sessions) : 0,
      last_seen: ts,
    });
  }

  return statuses;
}

logText('ShardManager loaded', 'SHARD');
