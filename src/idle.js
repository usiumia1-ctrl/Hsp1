import { getSetting } from './settings.js';
import { lastIdleAt, humanMessagesSince } from './db.js';
import { idleBudgetLeft, dailyBudgetLeft } from './quota.js';

function hourIn(timezone) {
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(new Date());
    return Number.parseInt(formatted, 10);
  } catch {
    return new Date().getHours();
  }
}

function inQuietHours(ctx) {
  const quiet = getSetting('idle.quietHours', ctx);
  if (!quiet?.enabled) return false;

  const { start, end } = quiet;
  if (start === end) return false;

  const hour = hourIn(quiet.timezone || 'Asia/Shanghai');
  // start > end 表示跨过午夜，例如 22 点到次日 6 点。
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * 判断这条消息要不要引发一次主动插话。
 * 便宜的检查放前面，掷骰子放最后——这样 probability 的含义是
 *「在所有本来就够格插话的时机里，有多大比例真的开口」。
 * 返回 { ok: true } 或 { ok: false, reason }。
 */
export function shouldIdleReply({ channelId, ctx }) {
  if (!getSetting('idle.enabled', ctx)) return { ok: false, reason: '主动插话已关闭' };

  const allowed = getSetting('idle.channels', ctx) || [];
  if (allowed.length > 0 && !allowed.includes(channelId)) {
    return { ok: false, reason: '该频道不在插话白名单里' };
  }

  if (inQuietHours(ctx)) return { ok: false, reason: '当前处于静默时段' };

  const cooldownMs = (getSetting('idle.cooldownSeconds', ctx) ?? 300) * 1000;
  const since = Date.now() - lastIdleAt(channelId);
  if (since < cooldownMs) {
    return { ok: false, reason: `冷却中，还剩 ${Math.ceil((cooldownMs - since) / 1000)} 秒` };
  }

  const windowMinutes = getSetting('idle.activityWindowMinutes', ctx) ?? 5;
  const minMessages = getSetting('idle.activityMinMessages', ctx) ?? 3;
  const recent = humanMessagesSince(channelId, Date.now() - windowMinutes * 60_000);
  if (recent < minMessages) {
    return { ok: false, reason: `最近 ${windowMinutes} 分钟只有 ${recent} 条消息，没到活跃门槛` };
  }

  if (idleBudgetLeft(ctx) <= 0) return { ok: false, reason: '今日主动插话次数已用完' };
  if (dailyBudgetLeft(ctx) <= 0) return { ok: false, reason: '今日 AI 调用总额度已用完' };

  const probability = getSetting('idle.probability', ctx) ?? 0.5;
  if (Math.random() >= probability) return { ok: false, reason: '这次没掷中' };

  return { ok: true };
}
