# Session Notes — Gateway Sharding Implementation

## Задание
Реализация системы шардирования Gateway для горизонтального масштабирования OldcordV3.

## Что было сделано

### Новые файлы

| Файл | Назначение |
|---|---|
| `server/sharding/redis.ts` | Синглтон Redis-клиентов (publisher + subscriber через ioredis) |
| `server/sharding/ShardManager.ts` | Алгоритм хеширования, регистрация сессий в Redis, health-метрики шардов |
| `server/sharding/InterShard.ts` | Pub/Sub: публикация событий на другие шарды, подписка на свой канал |
| `server/loadbalancer.ts` | WS-балансировщик: читает IDENTIFY, вычисляет шард, проксирует соединение |
| `docker-compose.yml` | Redis 7 + PostgreSQL 16 (user/password/oldcord_v3) |
| `AGENTS.md` | Документация проекта для AI-агентов |
| `tests/sharding.test.mjs` | Функциональные тесты алгоритма шардирования |
| `config.json` | Создан из config.example.json с настройками для Docker БД |

### Изменённые файлы

| Файл | Что изменено |
|---|---|
| `server/helpers/session.js` | `start()` и `terminate()` регистрируют/удаляют сессию в Redis; `updatePresence()` синхронизирует статус |
| `server/helpers/dispatcher.js` | `dispatchEventTo` — Redis fallback если пользователь не локальный; `dispatchEventInGuild` — рассылка на все шарды |
| `server/handlers/gateway.js` | `handleResume` проверяет Redis и возвращает `INVALID_SESSION` если сессия на другом шарде |
| `server/index.ts` | Инициализация Redis и InterShard при старте; periodic heartbeat каждые 10 сек |
| `server/api/index.js` | `/gateway` расширен данными о шардах; добавлен `/gateway/status` |
| `config.example.json` | Добавлена секция `sharding` |
| `package.json` | Добавлены скрипты `dev:shard0`, `dev:shard1`, `dev:lb`; добавлена зависимость `ioredis` |

## Архитектура

```
Client
  │
  ▼
Load Balancer :8080  (server/loadbalancer.ts)
  │  читает IDENTIFY → token → user_id → shard_id = (user_id >> 22) % num_shards
  │
  ├──► Shard 0 :9000  (SHARD_ID=0 npm run dev:shard0)
  │         │
  └──► Shard 1 :9001  (SHARD_ID=1 npm run dev:shard1)
            │
            └──► Redis :6379
                   Pub/Sub каналы: shard:events:0, shard:events:1
                   Ключи: session:{id}, user:sessions:{userId}, presence:{userId}
```

## Запуск

```bash
# Поднять Redis + PostgreSQL
docker compose up -d

# Обычный режим (без шардирования)
npm run dev:server

# Режим шардирования (3 терминала)
npm run dev:shard0   # SHARD_ID=0
npm run dev:shard1   # SHARD_ID=1
npm run dev:lb       # балансировщик на порту 8080

# Тесты
node tests/sharding.test.mjs
```

## Конфиг шардирования (config.json)

```json
"sharding": {
  "enabled": true,
  "num_shards": 2,
  "shard_id": 0,
  "redis_url": "redis://127.0.0.1:6379",
  "lb_port": 8080,
  "lb_url": "ws://127.0.0.1:8080",
  "shard_urls": {
    "0": "ws://127.0.0.1:9000",
    "1": "ws://127.0.0.1:9001"
  }
}
```

## Ключевые алгоритмы

### Назначение шарда
```js
shard_id = Number(BigInt(user_id) >> 22n) % num_shards
```
Discord Snowflake ID содержит timestamp в старших битах — сдвиг даёт равномерное распределение.

### Межсерверная доставка событий
1. `dispatchEventTo(userId, type, payload)` — если пользователь не в локальном `userSessions` → publish в Redis канал нужного шарда
2. `dispatchEventInGuild(guild, type, payload)` — рассылает на ВСЕ шарды, каждый доставляет своим локальным сессиям
3. `InterShard` подписан на `shard:events:{shardId}` и при получении сообщения диспатчит локально

### Resume на другом шарде
При `handleResume`: если `global.sessions.get(sessionId)` пуст → проверить Redis → если сессия на другом шарде → отправить `INVALID_SESSION (d: false)` → клиент делает полный IDENTIFY заново.

## Вопросы для защиты

**Почему Redis, а не TCP между шардами?**
Redis даёт готовый Pub/Sub без написания своего транспортного протокола. При падении шарда остальные продолжают работать независимо.

**Почему `>> 22`?**
Snowflake ID = 41 бит timestamp + 10 бит worker + 12 бит sequence. Сдвиг убирает worker и sequence, оставляя только временну́ю составляющую — она равномерно распределена.

**Что происходит при падении шарда?**
`/gateway/status` покажет `healthy: false` (heartbeat перестаёт обновляться через 25 сек). Клиенты на упавшем шарде переподключатся через балансировщик и получат новую сессию.

**Что хранится в Redis?**
- `session:{id}` → hash: userId, shardId (TTL 24ч)
- `user:sessions:{userId}` → set sessionId:shardId (TTL 24ч)
- `presence:{userId}` → статус online/offline/idle (TTL 24ч)
- `shard:status:{id}` → hash: sessions count, timestamp (TTL 30 сек)
