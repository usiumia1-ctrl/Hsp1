import { config, fromPath, loadConfig } from './config.js';
import { readOverride, writeOverride, dropOverride } from './db.js';

let active = config;

/** /reload 时重新读盘，让改过的 config.json 立刻生效。 */
export function reloadConfig() {
  active = loadConfig({ force: true });
  return active;
}

export function currentConfig() {
  return active;
}

/**
 * 取一项设置。优先级从高到低：
 *   频道级覆盖 → 服务器级覆盖 → 全局覆盖 → config.json
 * key 用点号路径，例如 'idle.probability'。
 */
export function getSetting(key, { channelId, guildId } = {}) {
  for (const scope of [channelId, guildId, 'global']) {
    if (!scope) continue;
    const value = readOverride(scope, key);
    if (value !== undefined) return value;
  }
  return fromPath(active, key);
}

export function setSetting(key, value, scope = 'global') {
  writeOverride(scope, key, value);
}

export function resetSetting(key, scope = 'global') {
  return dropOverride(scope, key);
}

export function adminIds() {
  return (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAdmin(userId) {
  const ids = adminIds();
  // 没配置管理员就谁都不给改，免得公开服务器里人人都能重写人设。
  return ids.length > 0 && ids.includes(userId);
}
