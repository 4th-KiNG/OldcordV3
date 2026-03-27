/**
 * InterShard — cross-shard event delivery via Redis Pub/Sub.
 *
 * Each shard subscribes to its own channel: `shard:events:{shardId}`
 * To send an event to a user on another shard, publish to their shard's channel.
 *
 * Message format:
 *   { kind: 'DISPATCH_USER',  userId,  eventType, payload }
 *   { kind: 'DISPATCH_GUILD', guildId, eventType, payload }
 *   { kind: 'SYNC_PRESENCE',  userId,  status }
 */

import { logText } from '../helpers/utils/logger.ts';
import { getPublisher, getSubscriber } from './redis.ts';
import { getShardForUser } from './ShardManager.ts';

export type InterShardMessage =
  | { kind: 'DISPATCH_USER'; userId: string; eventType: string; payload: unknown }
  | { kind: 'DISPATCH_GUILD'; guildId: string; eventType: string; payload: unknown }
  | { kind: 'SYNC_PRESENCE'; userId: string; status: string; gameId: unknown };

const CHANNEL_PREFIX = 'shard:events:';

export function shardChannel(shardId: number): string {
  return `${CHANNEL_PREFIX}${shardId}`;
}

export async function publishToShard(shardId: number, message: InterShardMessage): Promise<void> {
  try {
    await getPublisher().publish(shardChannel(shardId), JSON.stringify(message));
  } catch (err) {
    logText(`[InterShard] publish error: ${err}`, 'error');
  }
}

export async function publishToUserShard(
  userId: string,
  numShards: number,
  message: InterShardMessage,
): Promise<void> {
  const targetShard = getShardForUser(userId, numShards);
  await publishToShard(targetShard, message);
}

/**
 * Start listening on this shard's Redis channel.
 * When a message arrives, dispatch it to local sessions.
 */
export async function startInterShardListener(shardId: number): Promise<void> {
  const sub = getSubscriber();
  const channel = shardChannel(shardId);

  await sub.subscribe(channel);

  sub.on('message', (ch: string, raw: string) => {
    if (ch !== channel) return;

    let msg: InterShardMessage;
    try {
      msg = JSON.parse(raw) as InterShardMessage;
    } catch {
      logText(`[InterShard] bad message on ${ch}: ${raw}`, 'error');
      return;
    }

    handleIncomingMessage(msg);
  });

  logText(`[InterShard] Subscribed to ${channel}`, 'SHARD');
}

function handleIncomingMessage(msg: InterShardMessage): void {
  switch (msg.kind) {
    case 'DISPATCH_USER': {
      const sessions = global.userSessions?.get(msg.userId);
      if (sessions) {
        for (const s of sessions) {
          s.dispatch(msg.eventType, msg.payload);
        }
      }
      break;
    }

    case 'DISPATCH_GUILD': {
      // Dispatch to every local session that is in this guild
      global.userSessions?.forEach((sessions: unknown[]) => {
        for (const s of sessions as { guilds?: { id: string }[]; dispatch: (t: string, p: unknown) => void }[]) {
          if (s.guilds?.some((g) => g.id === msg.guildId)) {
            s.dispatch(msg.eventType, msg.payload);
          }
        }
      });
      break;
    }

    case 'SYNC_PRESENCE': {
      // Update presence in local sessions for this user
      const sessions = global.userSessions?.get(msg.userId);
      if (sessions) {
        for (const s of sessions as { presence: { status: string; game_id: unknown } }[]) {
          s.presence.status = msg.status;
          s.presence.game_id = msg.gameId;
        }
      }
      break;
    }
  }
}
