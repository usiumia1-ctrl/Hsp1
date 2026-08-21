import { GoogleGenAI } from '@google/genai';
import { callWithOptionalParams, ProviderError } from './util.js';

export const name = 'gemini';
export const label = 'Google Gemini';
export const envKey = 'GEMINI_API_KEY';

let client = null;
function getClient() {
  client ??= new GoogleGenAI({ apiKey: process.env[envKey] });
  return client;
}

export function isConfigured() {
  return Boolean(process.env[envKey]);
}

export async function complete({ system, messages, model, maxOutputTokens, temperature, signal }) {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  try {
    const response = await callWithOptionalParams(
      { systemInstruction: system, maxOutputTokens, abortSignal: signal },
      { temperature },
      (config) => getClient().models.generateContent({ model, contents, config })
    );

    const text = response.text;
    if (!text) {
      // 内容被安全过滤器拦下时 text 是空的，理由藏在 candidate 里。
      const reason = response.candidates?.[0]?.finishReason;
      throw new Error(reason ? `没有返回内容（finishReason: ${reason}）` : '没有返回内容');
    }
    return text.trim();
  } catch (err) {
    throw new ProviderError(name, err);
  }
}

export async function listModels() {
  const pager = await getClient().models.list();
  const out = [];
  for await (const model of pager) {
    const id = (model.name || '').replace(/^models\//, '');
    if (id) out.push(id);
  }
  return out.sort();
}
