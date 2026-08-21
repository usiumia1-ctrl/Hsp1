import { counterValue, bump } from './db.js';
import { getSetting } from './settings.js';
import { log } from './logger.js';

/** 单用户限流放内存里就够了，重启清零也无所谓。 */
const recentByUser = new Map();

export function hitUserRateLimit(userId, ctx) {
  const perMinute = getSetting('limits.userPerMinute', ctx) ?? 5;
  if (perMinute <= 0) return false;

  const now = Date.now();
  const hits = (recentByUser.get(userId) || []).filter((t) => now - t < 60_000);
  if (hits.length >= perMinute) {
    recentByUser.set(userId, hits);
    return true;
  }
  hits.push(now);
  recentByUser.set(userId, hits);
  return false;
}

/** 每天全局总闸，防止哪天被刷爆把付费额度烧穿。 */
export function dailyBudgetLeft(ctx) {
  const max = getSetting('limits.dailyRequestMax', ctx) ?? 240;
  return Math.max(0, max - counterValue('calls:total'));
}

export function dailyBudgetExhausted(ctx) {
  const exhausted = dailyBudgetLeft(ctx) <= 0;
  if (exhausted) log.warn('今日 AI 调用总额度已用完，暂停调用直到明天');
  return exhausted;
}

/** 主动插话有独立的每日上限，免得它把额度吃光、你自己反而没得用。 */
export function idleBudgetLeft(ctx) {
  const max = getSetting('idle.dailyMax', ctx) ?? 120;
  return Math.max(0, max - counterValue('idle:sent'));
}

export function recordIdleReply() {
  bump('idle:sent');
}

export function usageSnapshot(ctx) {
  return {
    total: counterValue('calls:total'),
    totalMax: getSetting('limits.dailyRequestMax', ctx) ?? 240,
    idle: counterValue('idle:sent'),
    idleMax: getSetting('idle.dailyMax', ctx) ?? 120,
    perProvider: {
      gemini: counterValue('calls:gemini'),
      openai: counterValue('calls:openai'),
      claude: counterValue('calls:claude'),
    },
    errors: {
      gemini: counterValue('errors:gemini'),
      openai: counterValue('errors:openai'),
      claude: counterValue('errors:claude'),
    },
  };
}

/** 清空内存里的限流记录，避免长期运行时 Map 无限增长。 */
export function sweepRateLimiter() {
  const now = Date.now();
  for (const [userId, hits] of recentByUser) {
    const fresh = hits.filter((t) => now - t < 60_000);
    if (fresh.length === 0) recentByUser.delete(userId);
    else recentByUser.set(userId, fresh);
  }
}
