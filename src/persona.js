import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { getSetting } from './settings.js';
import { log } from './logger.js';

const personaDir = path.join(ROOT, 'personas');

/** personas/ 目录下所有 .md 文件的名字（不含扩展名）。 */
export function listPersonas() {
  if (!fs.existsSync(personaDir)) return [];
  return fs
    .readdirSync(personaDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort();
}

export function personaExists(name) {
  return listPersonas().includes(name);
}

function readPersona(name) {
  const file = path.join(personaDir, `${name}.md`);
  // 防止 ../ 之类的路径穿越读到仓库外的文件。
  if (path.dirname(path.resolve(file)) !== path.resolve(personaDir)) return null;
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').trim();
}

function readStyle() {
  const rel = getSetting('persona.styleFile');
  if (!rel) return '';
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    log.warn(`风格文件不存在：${rel}`);
    return '';
  }
  return fs.readFileSync(file, 'utf8').trim();
}

/** 当前频道生效的人设名。 */
export function activePersonaName(ctx) {
  const name = getSetting('persona.default', ctx);
  return personaExists(name) ? name : (listPersonas()[0] ?? null);
}

/** 用户通过 /prompt 追加的临时提示词。 */
export function extraPrompt(ctx) {
  return getSetting('persona.extra', ctx) || '';
}

/**
 * 拼出最终的 system prompt，四层叠加：
 *   人设 → 全局聊天风格 → 用户追加的提示词 → 运行时身份信息
 */
export function buildSystemPrompt(ctx, { botName, channelName, mode }) {
  const name = activePersonaName(ctx);
  const parts = [];

  const persona = name ? readPersona(name) : null;
  if (persona) parts.push(persona);

  const style = readStyle();
  if (style) parts.push(style);

  const extra = extraPrompt(ctx);
  if (extra) parts.push(`额外要求：\n${extra}`);

  const facts = [`你在 Discord 上的名字是「${botName}」，别人会用 @${botName} 叫你。`];
  if (channelName) facts.push(`当前频道是 #${channelName}。`);
  facts.push(`现在时间是 ${new Date().toLocaleString('zh-CN', { timeZone: getSetting('idle.quietHours.timezone') || 'Asia/Shanghai' })}。`);
  if (mode === 'idle') {
    facts.push(
      '注意：这次没有人叫你，是你自己主动插话。说一句自然承接当前话题的短消息就好，别太长，也别显得突兀。如果你觉得这时候插话不合适，就只回复 SKIP 这四个字母，系统会帮你咽回去。'
    );
  }
  parts.push(facts.join('\n'));

  return parts.join('\n\n---\n\n');
}
