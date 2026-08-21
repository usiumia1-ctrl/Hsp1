import * as gemini from './gemini.js';
import * as openai from './openai.js';
import * as claude from './claude.js';
import { getSetting } from '../settings.js';
import { bump } from '../db.js';
import { log } from './../logger.js';

export const providers = { gemini, openai, claude };
export const providerNames = Object.keys(providers);

export function configuredProviders() {
  return providerNames.filter((n) => providers[n].isConfigured());
}

export function modelFor(providerName, ctx) {
  return getSetting(`provider.models.${providerName}`, ctx);
}

/** 主供应商排在最前，后面接上配置里的降级顺序，去重且只保留填了 key 的。 */
function attemptOrder(preferred, ctx) {
  const fallback = getSetting('provider.fallbackOrder', ctx) || providerNames;
  const seen = new Set();
  return [preferred, ...fallback]
    .filter((n) => n && providers[n] && providers[n].isConfigured() && !seen.has(n) && seen.add(n));
}

/**
 * 依次尝试供应商直到有一家返回结果。
 * 返回 { text, provider, model }，全挂了就抛出带上所有失败原因的错误。
 */
export async function generate({ system, messages, ctx, preferred }) {
  const chosen = preferred || getSetting('provider.default', ctx);
  const order = attemptOrder(chosen, ctx);

  if (order.length === 0) {
    throw new Error('没有可用的 AI 供应商——检查一下 .env 里是否至少填了一个 API key');
  }

  const timeoutMs = getSetting('provider.timeoutMs', ctx) ?? 60000;
  const failures = [];

  for (const providerName of order) {
    const model = modelFor(providerName, ctx);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const text = await providers[providerName].complete({
        system,
        messages,
        model,
        maxOutputTokens: getSetting('provider.maxOutputTokens', ctx) ?? 800,
        temperature: getSetting('provider.temperature', ctx),
        signal: controller.signal,
        timeoutMs,
      });

      bump(`calls:${providerName}`);
      bump('calls:total');
      if (failures.length > 0) {
        log.warn(`${providerName} 接管成功，之前失败的是：${failures.map((f) => f.provider).join(', ')}`);
      }
      return { text, provider: providerName, model };
    } catch (err) {
      bump(`errors:${providerName}`);
      failures.push({ provider: providerName, message: err.message });
      log.warn(`${providerName} 调用失败，尝试下一家：${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const detail = failures.map((f) => `  · ${f.message}`).join('\n');
  throw new Error(`所有供应商都失败了：\n${detail}`);
}
