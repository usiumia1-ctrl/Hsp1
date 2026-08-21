import Anthropic from '@anthropic-ai/sdk';
import { callWithOptionalParams, ProviderError } from './util.js';

export const name = 'claude';
export const label = 'Anthropic Claude';
export const envKey = 'ANTHROPIC_API_KEY';

let client = null;
function getClient() {
  client ??= new Anthropic({ apiKey: process.env[envKey] });
  return client;
}

export function isConfigured() {
  return Boolean(process.env[envKey]);
}

export async function complete({ system, messages, model, maxOutputTokens, signal, timeoutMs, effort = 'low' }) {
  try {
    const message = await callWithOptionalParams(
      {
        model,
        max_tokens: maxOutputTokens,
        system,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      },
      // 闲聊不需要深度推理，低 effort 更快也更省钱。老一些的型号不认这个参数，
      // 被 400 打回来会自动去掉重试。
      { output_config: { effort } },
      (body) => getClient().messages.create(body, { signal, timeout: timeoutMs })
    );

    if (message.stop_reason === 'refusal') {
      throw new Error('模型拒绝了这次请求');
    }

    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!text) throw new Error('没有返回内容');
    return text;
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
