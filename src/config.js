import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** config.json 里以 _ 开头的键是写给人看的注释，运行时要剔除掉。 */
function stripNotes(value) {
  if (Array.isArray(value)) return value.map(stripNotes);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_')) continue;
      out[k] = stripNotes(v);
    }
    return out;
  }
  return value;
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return stripNotes(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    throw new Error(`配置文件 ${path.relative(ROOT, file)} 不是合法的 JSON：${err.message}`);
  }
}

let cached = null;

/** 读取 config/config.json，若存在 config/config.local.json 则叠加在上面。 */
export function loadConfig({ force = false } = {}) {
  if (cached && !force) return cached;
  const base = readJson(path.join(ROOT, 'config', 'config.json'));
  if (!base) throw new Error('找不到 config/config.json');
  const local = readJson(path.join(ROOT, 'config', 'config.local.json'));
  if (local) log.info('已加载 config/config.local.json 覆盖项');
  cached = local ? deepMerge(base, local) : base;
  return cached;
}

/** 按 'idle.probability' 这样的点号路径取值。 */
export function fromPath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export const config = loadConfig();
