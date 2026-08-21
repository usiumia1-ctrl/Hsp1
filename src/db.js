import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ROOT } from './config.js';
import { log } from './logger.js';

const dataDir = path.join(ROOT, 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'bot.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  TEXT    NOT NULL UNIQUE,
    guild_id    TEXT,
    channel_id  TEXT    NOT NULL,
    author_id   TEXT    NOT NULL,
    author_name TEXT    NOT NULL,
    is_bot      INTEGER NOT NULL DEFAULT 0,
    content     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);

  CREATE TABLE IF NOT EXISTS settings (
    scope TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (scope, key)
  );

  CREATE TABLE IF NOT EXISTS counters (
    day   TEXT    NOT NULL,
    key   TEXT    NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key)
  );

  CREATE TABLE IF NOT EXISTS idle_state (
    channel_id   TEXT PRIMARY KEY,
    last_idle_at INTEGER NOT NULL
  );
`);

// ---------------------------------------------------------------- 消息历史

const insertMessage = db.prepare(`
  INSERT OR IGNORE INTO messages
    (message_id, guild_id, channel_id, author_id, author_name, is_bot, content, created_at)
  VALUES (@message_id, @guild_id, @channel_id, @author_id, @author_name, @is_bot, @content, @created_at)
`);

export function recordMessage(row) {
  insertMessage.run(row);
}

const selectRecent = db.prepare(`
  SELECT author_id, author_name, is_bot, content, created_at
  FROM messages WHERE channel_id = ?
  ORDER BY created_at DESC, id DESC LIMIT ?
`);

/** 返回该频道最近 limit 条消息，按时间正序（最老的在前）。 */
export function recentMessages(channelId, limit) {
  return selectRecent.all(channelId, limit).reverse();
}

const countSince = db.prepare(
  'SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND created_at >= ? AND is_bot = 0'
);

export function humanMessagesSince(channelId, sinceMs) {
  return countSince.get(channelId, sinceMs).n;
}

const deleteChannel = db.prepare('DELETE FROM messages WHERE channel_id = ?');
export function clearChannel(channelId) {
  return deleteChannel.run(channelId).changes;
}

const deleteOlder = db.prepare('DELETE FROM messages WHERE created_at < ?');
export function purgeOlderThan(days) {
  const cutoff = Date.now() - days * 86400_000;
  const removed = deleteOlder.run(cutoff).changes;
  if (removed > 0) log.info(`清理了 ${removed} 条超过 ${days} 天的历史消息`);
  return removed;
}

// ---------------------------------------------------------------- 设置覆盖

const selectSetting = db.prepare('SELECT value FROM settings WHERE scope = ? AND key = ?');
const upsertSetting = db.prepare(`
  INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)
  ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value
`);
const deleteSetting = db.prepare('DELETE FROM settings WHERE scope = ? AND key = ?');

export function readOverride(scope, key) {
  const row = selectSetting.get(scope, key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

export function writeOverride(scope, key, value) {
  upsertSetting.run(scope, key, JSON.stringify(value));
}

export function dropOverride(scope, key) {
  return deleteSetting.run(scope, key).changes;
}

// ---------------------------------------------------------------- 计数器

/** 用本地日期做 key，这样"每日额度"跟着你所在时区的自然日走。 */
export function today() {
  return new Date().toLocaleDateString('sv-SE');
}

const selectCounter = db.prepare('SELECT count FROM counters WHERE day = ? AND key = ?');
const bumpCounter = db.prepare(`
  INSERT INTO counters (day, key, count) VALUES (?, ?, 1)
  ON CONFLICT (day, key) DO UPDATE SET count = count + 1
`);
const deleteOldCounters = db.prepare('DELETE FROM counters WHERE day < ?');

export function counterValue(key, day = today()) {
  return selectCounter.get(day, key)?.count ?? 0;
}

export function bump(key, day = today()) {
  bumpCounter.run(day, key);
}

export function purgeCounters(days = 30) {
  const cutoff = new Date(Date.now() - days * 86400_000).toLocaleDateString('sv-SE');
  deleteOldCounters.run(cutoff);
}

// ---------------------------------------------------------------- 插话冷却

const selectIdle = db.prepare('SELECT last_idle_at FROM idle_state WHERE channel_id = ?');
const upsertIdle = db.prepare(`
  INSERT INTO idle_state (channel_id, last_idle_at) VALUES (?, ?)
  ON CONFLICT (channel_id) DO UPDATE SET last_idle_at = excluded.last_idle_at
`);

export function lastIdleAt(channelId) {
  return selectIdle.get(channelId)?.last_idle_at ?? 0;
}

export function markIdle(channelId, at = Date.now()) {
  upsertIdle.run(channelId, at);
}
