import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getSetting, setSetting, resetSetting, reloadConfig, isAdmin, adminIds } from '../settings.js';
import { listPersonas, personaExists, activePersonaName, extraPrompt } from '../persona.js';
import { providers, providerNames, configuredProviders, modelFor } from '../providers/index.js';
import { generateReply, splitReply } from '../chat.js';
import { usageSnapshot, hitUserRateLimit, dailyBudgetExhausted } from '../quota.js';
import { clearChannel, recordMessage } from '../db.js';
import { log } from '../logger.js';

/** 私人服务器里按服务器隔离设置就够了；私聊没有服务器，退回按频道隔离。 */
function scopeFor(interaction) {
  return interaction.guildId ?? interaction.channelId;
}

function ctxFor(interaction) {
  return { channelId: interaction.channelId, guildId: interaction.guildId };
}

const ephemeral = { flags: MessageFlags.Ephemeral };

const providerChoices = providerNames.map((n) => ({ name: providers[n].label, value: n }));

// ---------------------------------------------------------------- /ping

const ping = {
  data: new SlashCommandBuilder().setName('ping').setDescription('看看机器人还活着没，顺便报个延迟'),
  async execute(interaction) {
    const configured = configuredProviders();
    const lines = [
      `延迟 ${Math.round(interaction.client.ws.ping)}ms`,
      `已配置的供应商：${configured.length ? configured.map((n) => providers[n].label).join('、') : '一个都没有'}`,
      `当前人设：${activePersonaName(ctxFor(interaction)) ?? '无'}`,
    ];
    if (adminIds().length === 0) {
      lines.push('⚠️ 没有设置 ADMIN_USER_IDS，所有管理命令都用不了');
    }
    await interaction.reply({ content: lines.join('\n'), ...ephemeral });
  },
};

// ---------------------------------------------------------------- /ask

const ask = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('直接提问，不用先 @ 机器人')
    .addStringOption((o) => o.setName('question').setDescription('你想问什么').setRequired(true))
    .addStringOption((o) =>
      o.setName('provider').setDescription('这一次临时用哪家（不填就用默认的）').addChoices(...providerChoices)
    ),

  async execute(interaction) {
    const ctx = ctxFor(interaction);
    const question = interaction.options.getString('question');

    if (hitUserRateLimit(interaction.user.id, ctx)) {
      return interaction.reply({ content: '你问得太快了，缓一分钟再来。', ...ephemeral });
    }
    if (dailyBudgetExhausted(ctx)) {
      return interaction.reply({ content: '今天的调用额度已经用完了，明天再来吧。', ...ephemeral });
    }

    await interaction.deferReply();

    // 把提问写进历史，模型才能在后续对话里看到它。
    recordMessage({
      message_id: `slash-${interaction.id}`,
      guild_id: interaction.guildId,
      channel_id: interaction.channelId,
      author_id: interaction.user.id,
      author_name: interaction.member?.displayName || interaction.user.username,
      is_bot: 0,
      content: question,
      created_at: Date.now(),
    });

    try {
      const result = await generateReply({
        channelId: interaction.channelId,
        botId: interaction.client.user.id,
        botName: interaction.client.user.username,
        channelName: interaction.channel?.name,
        ctx,
        preferred: interaction.options.getString('provider') ?? undefined,
      });

      if (!result.text) {
        return interaction.editReply('这次没生成出内容，再试一次？');
      }

      recordMessage({
        message_id: `slash-reply-${interaction.id}`,
        guild_id: interaction.guildId,
        channel_id: interaction.channelId,
        author_id: interaction.client.user.id,
        author_name: interaction.client.user.username,
        is_bot: 1,
        content: result.text,
        created_at: Date.now(),
      });

      const chunks = splitReply(result.text, getSetting('limits.replyMaxChars', ctx) ?? 1900);
      await interaction.editReply(chunks[0]);
      for (const chunk of chunks.slice(1)) {
        await interaction.followUp(chunk);
      }
    } catch (err) {
      log.error('/ask 失败：', err);
      await interaction.editReply(`出错了：${err.message}`.slice(0, 1900));
    }
  },
};

// ---------------------------------------------------------------- /model

const model = {
  adminOnly: ['set'],
  data: new SlashCommandBuilder()
    .setName('model')
    .setDescription('查看或切换 AI 供应商和型号')
    .addSubcommand((s) => s.setName('show').setDescription('看当前用的是哪家哪个型号'))
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('列出某家账号下实际可用的型号')
        .addStringOption((o) =>
          o.setName('provider').setDescription('哪一家').setRequired(true).addChoices(...providerChoices)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('切换默认供应商，也可以顺便指定型号（管理员）')
        .addStringOption((o) =>
          o.setName('provider').setDescription('哪一家').setRequired(true).addChoices(...providerChoices)
        )
        .addStringOption((o) => o.setName('model').setDescription('型号名，不填就沿用现在的'))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const ctx = ctxFor(interaction);

    if (sub === 'show') {
      const active = getSetting('provider.default', ctx);
      const lines = providerNames.map((n) => {
        const mark = n === active ? '▶' : '  ';
        const ready = providers[n].isConfigured() ? '' : '（没填 API key）';
        return `${mark} ${providers[n].label}：${modelFor(n, ctx)} ${ready}`;
      });
      lines.push('', `降级顺序：${(getSetting('provider.fallbackOrder', ctx) || []).join(' → ')}`);
      return interaction.reply({ content: lines.join('\n'), ...ephemeral });
    }

    if (sub === 'list') {
      const name = interaction.options.getString('provider');
      if (!providers[name].isConfigured()) {
        return interaction.reply({ content: `${providers[name].label} 还没填 API key。`, ...ephemeral });
      }
      await interaction.deferReply(ephemeral);
      try {
        const models = await providers[name].listModels();
        const body = models.join('\n');
        return interaction.editReply(
          `${providers[name].label} 可用型号（${models.length} 个）：\n\`\`\`\n${body.slice(0, 1700)}\n\`\`\``
        );
      } catch (err) {
        return interaction.editReply(`查询失败：${err.message}`.slice(0, 1900));
      }
    }

    // set
    const name = interaction.options.getString('provider');
    const modelName = interaction.options.getString('model');
    const scope = scopeFor(interaction);

    setSetting('provider.default', name, scope);
    if (modelName) setSetting(`provider.models.${name}`, modelName, scope);

    const warning = providers[name].isConfigured() ? '' : `\n⚠️ 但是 ${providers[name].envKey} 还没填，实际会自动降级到别家。`;
    return interaction.reply({
      content: `默认供应商已切到 ${providers[name].label}，型号 ${modelFor(name, ctx)}。${warning}`,
      ...ephemeral,
    });
  },
};

// ---------------------------------------------------------------- /persona

const persona = {
  adminOnly: ['use'],
  data: new SlashCommandBuilder()
    .setName('persona')
    .setDescription('查看或切换人设')
    .addSubcommand((s) => s.setName('list').setDescription('列出 personas/ 目录里所有人设'))
    .addSubcommand((s) => s.setName('show').setDescription('看当前生效的人设'))
    .addSubcommand((s) =>
      s
        .setName('use')
        .setDescription('换一套人设（管理员）')
        .addStringOption((o) => o.setName('name').setDescription('人设名字').setRequired(true).setAutocomplete(true))
    ),

  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().toLowerCase();
    const matches = listPersonas()
      .filter((n) => n.toLowerCase().includes(typed))
      .slice(0, 25);
    await interaction.respond(matches.map((n) => ({ name: n, value: n })));
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const ctx = ctxFor(interaction);

    if (sub === 'list') {
      const all = listPersonas();
      const active = activePersonaName(ctx);
      const body = all.length
        ? all.map((n) => `${n === active ? '▶' : '  '} ${n}`).join('\n')
        : 'personas/ 目录是空的，往里面丢 .md 文件就行。';
      return interaction.reply({ content: body, ...ephemeral });
    }

    if (sub === 'show') {
      const extra = extraPrompt(ctx);
      const lines = [`当前人设：${activePersonaName(ctx) ?? '无'}`];
      lines.push(extra ? `额外提示词：\n${extra}` : '额外提示词：（空）');
      return interaction.reply({ content: lines.join('\n').slice(0, 1900), ...ephemeral });
    }

    // use
    const name = interaction.options.getString('name');
    if (!personaExists(name)) {
      return interaction.reply({
        content: `没有叫「${name}」的人设。现有的：${listPersonas().join('、') || '（一个都没有）'}`,
        ...ephemeral,
      });
    }
    setSetting('persona.default', name, scopeFor(interaction));
    return interaction.reply({ content: `人设已切换成「${name}」。`, ...ephemeral });
  },
};

// ---------------------------------------------------------------- /prompt

const prompt = {
  adminOnly: ['set', 'clear'],
  data: new SlashCommandBuilder()
    .setName('prompt')
    .setDescription('在人设之上追加临时提示词')
    .addSubcommand((s) => s.setName('show').setDescription('看当前追加了什么'))
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('设置追加的提示词，会覆盖之前的（管理员）')
        .addStringOption((o) => o.setName('text').setDescription('想让它额外遵守什么').setRequired(true))
    )
    .addSubcommand((s) => s.setName('clear').setDescription('清掉追加的提示词（管理员）')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const ctx = ctxFor(interaction);
    const scope = scopeFor(interaction);

    if (sub === 'show') {
      const extra = extraPrompt(ctx);
      return interaction.reply({
        content: extra ? `当前追加的提示词：\n${extra}`.slice(0, 1900) : '现在没有追加任何提示词。',
        ...ephemeral,
      });
    }

    if (sub === 'clear') {
      resetSetting('persona.extra', scope);
      return interaction.reply({ content: '追加的提示词已清空。', ...ephemeral });
    }

    const text = interaction.options.getString('text');
    setSetting('persona.extra', text, scope);
    return interaction.reply({ content: `已追加：\n${text}`.slice(0, 1900), ...ephemeral });
  },
};

// ---------------------------------------------------------------- /idle

const idle = {
  adminOnly: ['on', 'off', 'set'],
  data: new SlashCommandBuilder()
    .setName('idle')
    .setDescription('主动插话的开关和参数')
    .addSubcommand((s) => s.setName('status').setDescription('看当前的插话设置'))
    .addSubcommand((s) => s.setName('on').setDescription('打开主动插话（管理员）'))
    .addSubcommand((s) => s.setName('off').setDescription('关掉主动插话（管理员）'))
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('调整插话参数（管理员）')
        .addNumberOption((o) =>
          o.setName('probability').setDescription('触发概率 0~1').setMinValue(0).setMaxValue(1)
        )
        .addIntegerOption((o) =>
          o.setName('cooldown').setDescription('冷却秒数，这个才是真正的额度闸门').setMinValue(0)
        )
        .addIntegerOption((o) => o.setName('daily_max').setDescription('每天最多主动插话几次').setMinValue(0))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const ctx = ctxFor(interaction);
    const scope = scopeFor(interaction);

    if (sub === 'on' || sub === 'off') {
      setSetting('idle.enabled', sub === 'on', scope);
      return interaction.reply({ content: `主动插话已${sub === 'on' ? '打开' : '关闭'}。`, ...ephemeral });
    }

    if (sub === 'set') {
      const changed = [];
      const probability = interaction.options.getNumber('probability');
      const cooldown = interaction.options.getInteger('cooldown');
      const dailyMax = interaction.options.getInteger('daily_max');

      if (probability !== null) {
        setSetting('idle.probability', probability, scope);
        changed.push(`概率 → ${probability}`);
      }
      if (cooldown !== null) {
        setSetting('idle.cooldownSeconds', cooldown, scope);
        const perDay = cooldown > 0 ? Math.floor(86400 / cooldown) : '无限';
        changed.push(`冷却 → ${cooldown} 秒（每频道每天最多 ${perDay} 次）`);
      }
      if (dailyMax !== null) {
        setSetting('idle.dailyMax', dailyMax, scope);
        changed.push(`每日上限 → ${dailyMax}`);
      }

      return interaction.reply({
        content: changed.length ? changed.join('\n') : '一个参数都没填，什么也没改。',
        ...ephemeral,
      });
    }

    // status
    const quiet = getSetting('idle.quietHours', ctx);
    const cooldown = getSetting('idle.cooldownSeconds', ctx);
    const usage = usageSnapshot(ctx);
    const lines = [
      `状态：${getSetting('idle.enabled', ctx) ? '开启' : '关闭'}`,
      `概率：${getSetting('idle.probability', ctx)}`,
      `冷却：${cooldown} 秒（每频道每天上限约 ${cooldown > 0 ? Math.floor(86400 / cooldown) : '∞'} 次）`,
      `活跃门槛：最近 ${getSetting('idle.activityWindowMinutes', ctx)} 分钟内至少 ${getSetting('idle.activityMinMessages', ctx)} 条消息`,
      `今日已插话：${usage.idle} / ${usage.idleMax}`,
      `静默时段：${quiet?.enabled ? `${quiet.start}:00 – ${quiet.end}:00 (${quiet.timezone})` : '未启用'}`,
    ];
    const channels = getSetting('idle.channels', ctx) || [];
    lines.push(`频道白名单：${channels.length ? channels.join(', ') : '（全部频道）'}`);
    return interaction.reply({ content: lines.join('\n'), ...ephemeral });
  },
};

// ---------------------------------------------------------------- /stats

const stats = {
  data: new SlashCommandBuilder().setName('stats').setDescription('今天用了多少次调用'),
  async execute(interaction) {
    const u = usageSnapshot(ctxFor(interaction));
    const lines = [
      `今日调用：${u.total} / ${u.totalMax}`,
      `其中主动插话：${u.idle} / ${u.idleMax}`,
      '',
      '按供应商：',
      ...providerNames.map((n) => `  ${providers[n].label}：${u.perProvider[n]} 次成功，${u.errors[n]} 次失败`),
    ];
    await interaction.reply({ content: lines.join('\n'), ...ephemeral });
  },
};

// ---------------------------------------------------------------- /clear

const clear = {
  adminOnly: true,
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('清空本频道的对话记忆（管理员）'),
  async execute(interaction) {
    const removed = clearChannel(interaction.channelId);
    await interaction.reply({ content: `已清掉本频道 ${removed} 条历史记忆。`, ...ephemeral });
  },
};

// ---------------------------------------------------------------- /reload

const reload = {
  adminOnly: true,
  data: new SlashCommandBuilder()
    .setName('reload')
    .setDescription('重新读取 config.json、人设和风格文件（管理员）'),
  async execute(interaction) {
    try {
      reloadConfig();
      const ctx = ctxFor(interaction);
      await interaction.reply({
        content: [
          '已重新加载。',
          `人设：${activePersonaName(ctx) ?? '无'}（共 ${listPersonas().length} 套）`,
          `供应商：${getSetting('provider.default', ctx)}`,
        ].join('\n'),
        ...ephemeral,
      });
    } catch (err) {
      await interaction.reply({ content: `重载失败：${err.message}`.slice(0, 1900), ...ephemeral });
    }
  },
};

// ----------------------------------------------------------------

export const commands = [ping, ask, model, persona, prompt, idle, stats, clear, reload];

export const commandMap = new Map(commands.map((c) => [c.data.name, c]));

/** adminOnly 可以是 true（整条命令都要管理员）或子命令名字的数组。 */
export function requiresAdmin(command, interaction) {
  if (command.adminOnly === true) return true;
  if (!Array.isArray(command.adminOnly)) return false;
  const sub = interaction.options.getSubcommand(false);
  return sub !== null && command.adminOnly.includes(sub);
}

export { isAdmin };
