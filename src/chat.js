import { recentMessages } from './db.js';
import { getSetting } from './settings.js';
import { buildSystemPrompt } from './persona.js';
import { generate } from './providers/index.js';

/**
 * 三家 API 都要求 user / assistant 交替出现，而且第一条必须是 user。
 * Discord 频道里连续好几个人发言是常态，所以把同一角色的相邻消息并成一条。
 */
function normalize(rows) {
  const merged = [];
  for (const row of rows) {
    const last = merged[merged.length - 1];
    if (last && last.role === row.role) last.content += `\n${row.content}`;
    else merged.push({ ...row });
  }
  while (merged.length > 0 && merged[0].role !== 'user') merged.shift();
  while (merged.length > 0 && merged[merged.length - 1].role !== 'user') merged.pop();
  return merged;
}

/** 把频道历史转成对话消息数组。别人的发言前面带上名字，好让模型分得清谁是谁。 */
export function buildHistory(channelId, botId, ctx) {
  const limit = getSetting('memory.contextMessages', ctx) ?? 30;
  const maxChars = getSetting('memory.maxMessageChars', ctx) ?? 1000;

  const rows = recentMessages(channelId, limit).map((row) => {
    const content = row.content.length > maxChars ? `${row.content.slice(0, maxChars)}…` : row.content;
    return row.author_id === botId
      ? { role: 'assistant', content }
      : { role: 'user', content: `${row.author_name}：${content}` };
  });

  return normalize(rows);
}

/** Discord 单条消息上限 2000 字符，超了要切。尽量切在段落或句子边界上。 */
export function splitReply(text, max) {
  const chunks = [];
  let rest = text.trim();

  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    for (const sep of ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', ' ']) {
      const idx = window.lastIndexOf(sep);
      // 太靠前就切会切出一堆碎片，至少要过半才认这个断点。
      if (idx > max * 0.5) {
        cut = idx + sep.length;
        break;
      }
    }
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * 生成一次回复。mode 为 'idle' 时是主动插话，模型可以回 SKIP 表示这次不想说话。
 * 返回 { text, provider, model, skipped }。
 */
export async function generateReply({ channelId, botId, botName, channelName, ctx, mode = 'reply', preferred }) {
  const messages = buildHistory(channelId, botId, ctx);
  if (messages.length === 0) {
    return { text: null, skipped: true, reason: '没有可用的上下文' };
  }

  const system = buildSystemPrompt(ctx, { botName, channelName, mode });
  const { text, provider, model } = await generate({ system, messages, ctx, preferred });

  if (mode === 'idle' && /^\s*SKIP\b/i.test(text)) {
    return { text: null, provider, model, skipped: true, reason: '模型选择了不插话' };
  }

  return { text, provider, model, skipped: false };
}
