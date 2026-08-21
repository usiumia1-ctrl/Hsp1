import OpenAI from 'openai';
import { callWithOptionalParams, ProviderError } from './util.js';

export const name = 'openai';
export const label = 'OpenAI';
export const envKey = 'OPENAI_API_KEY';

let client = null;
function getClient() {
  client ??= new OpenAI({ apiKey: process.env[envKey] });
  return client;
}

export function isConfigured() {
  return Boolean(process.env[envKey]);
}

export async function complete({ system, messages, model, maxOutputTokens, temperature, signal, timeoutMs }) {
  const payload = [
    { role: 'developer', content: system },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  try {
    const completion = await callWithOptionalParams(
      { model, messages: payload, max_completion_tokens: maxOutputTokens },
      { temperature },
      (body) => getClient().chat.completions.create(body, { signal, timeout: timeoutMs })
    );

    const text = completion.choices?.[0]?.message?.content;
    if (!text) throw new Error('没有返回内容');
    return text.trim();
  } catch (err) {
    throw new ProviderError(name, err);
  }
}

export async function listModels() {
  const page = await getClient().models.list();
  const out = [];
  for await (const model of page) {
    if (model.id) out.push(model.id);
  }
  return out.sort();
}
