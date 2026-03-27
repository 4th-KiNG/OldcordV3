import { Redis } from 'ioredis';

import { logText } from '../helpers/utils/logger.ts';

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

export function initRedis(redisUrl: string): void {
  publisher = new Redis(redisUrl, { lazyConnect: false });
  subscriber = new Redis(redisUrl, { lazyConnect: false });

  publisher.on('error', (err) => logText(`[Redis publisher] ${err}`, 'error'));
  subscriber.on('error', (err) => logText(`[Redis subscriber] ${err}`, 'error'));

  publisher.on('connect', () => logText('Redis publisher connected', 'SHARD'));
  subscriber.on('connect', () => logText('Redis subscriber connected', 'SHARD'));
}

export function getPublisher(): Redis {
  if (!publisher) throw new Error('Redis not initialized');
  return publisher;
}

export function getSubscriber(): Redis {
  if (!subscriber) throw new Error('Redis not initialized');
  return subscriber;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const result = await getPublisher().ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}
