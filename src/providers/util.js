/**
 * 各家 API 对可选参数的支持不一致——比如 OpenAI 的推理型号会拒绝自定义
 * temperature，Claude 的小模型不认 output_config.effort。与其把型号名硬编码成
 * 白名单（型号一更新就过期），不如先带上参数试一次，被 400 打回来再去掉重试。
 */
export async function callWithOptionalParams(base, optional, invoke) {
  try {
    return await invoke({ ...base, ...optional });
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    const optionalKeys = Object.keys(optional);
    if (status !== 400 || optionalKeys.length === 0) throw err;

    const text = String(err?.message ?? '');
    const blamesOptional = optionalKeys.some((k) => text.includes(k));
    if (!blamesOptional) throw err;

    return invoke(base);
  }
}

export class ProviderError extends Error {
  constructor(provider, cause) {
    const status = cause?.status ?? cause?.response?.status;
    super(`[${provider}] ${status ? `HTTP ${status}: ` : ''}${cause?.message ?? cause}`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.cause = cause;
  }

  /** 额度耗尽或被限流——这种情况值得自动切到备用供应商。 */
  get isQuota() {
    return this.status === 429 || this.status === 402;
  }
}
