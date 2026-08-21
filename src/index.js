import 'dotenv/config';
import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { log } from './logger.js';
import { getSetting, isAdmin, adminIds } from './settings.js';
import { commandMap, requiresAdmin } from './commands/index.js';
import { recordMessage, purgeOlderThan, purgeCounters, markIdle } from './db.js';
import { generateReply, splitReply } from './chat.js';
import { shouldIdleReply } from './idle.js';
import { hitUserRateLimit, dailyBudgetExhausted, recordIdleReply, sweepRateLimiter } from './quota.js';
import { configuredProviders } from './providers/index.js';

if (!process.env.DISCORD_TOKEN) {
  console.error('缺少 DISCORD_TOKEN。先 cp .env.example .env 然后把值填进去。');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// ---------------------------------------------------------------- 工具

/**
 * Discord 的「正在输入」大约 10 秒就消失，而 AI 经常要跑更久，
 * 所以整个生成过程里要按时续上。
 */
async function withTyping(channel, task) {
  let timer = null;
  try {
    await channel.sendTyping().catch(() => {});
    timer = setInterval(() => channel.sendTyping().catch(() => {}), 8000);
    return await task();
  } finally {
    if (timer) clearInterval(timer);
  }
}

function storeMessage(message, { isBot = false } = {}) {
  recordMessage({
    message_id: message.id,
    guild_id: message.guildId ?? null,
    channel_id: message.channelId,
    author_id: message.author.id,
    author_name: message.member?.displayName || message.author.username,
    is_bot: isBot ? 1 : 0,
    content: message.cleanContent || message.content || '',
    created_at: message.createdTimestamp,
  });
}

/** 判断这条消息是不是在回复机器人。优先查缓存，查不到才发一次请求。 */
async function isReplyToBot(message, botId) {
  const ref = message.reference?.messageId;
  if (!ref) return false;
  const cached = message.channel.messages.cache.get(ref);
  if (cached) return cached.author.id === botId;
  try {
    const fetched = await message.channel.messages.fetch(ref);
    return fetched.author.id === botId;
  } catch {
    return false;
  }
}

async function sendReply({ message, channel, text, ctx, asReply }) {
  const chunks = splitReply(text, getSetting('limits.replyMaxChars', ctx) ?? 1900);
  let first = true;
  for (const chunk of chunks) {
    const sent = first && asReply ? await message.reply(chunk) : await channel.send(chunk);
    storeMessage(sent, { isBot: true });
    first = false;
  }
}

// ---------------------------------------------------------------- 事件

client.once(Events.ClientReady, (c) => {
  log.info(`已登录：${c.user.tag}`);
  log.info(`可用供应商：${configuredProviders().join('、') || '（一个都没有，检查 .env）'}`);
  if (adminIds().length === 0) {
    log.warn('没有配置 ADMIN_USER_IDS，所有管理命令都会被拒绝。');
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const command = commandMap.get(interaction.commandName);
    if (command?.autocomplete) {
      await command.autocomplete(interaction).catch((err) => log.warn('自动补全失败：', err));
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commandMap.get(interaction.commandName);
  if (!command) return;

  if (requiresAdmin(command, interaction) && !isAdmin(interaction.user.id)) {
    await interaction
      .reply({ content: '这条命令只有管理员能用。', flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    log.error(`/${interaction.commandName} 执行出错：`, err);
    const content = `出错了：${err.message}`.slice(0, 1900);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content).catch(() => {});
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  // 任何机器人的消息都不进历史，也不触发回复——否则两个 bot 能互相刷到天亮。
  if (message.author.bot) return;
  if (!message.content?.trim()) return;

  storeMessage(message);

  const ctx = { channelId: message.channelId, guildId: message.guildId };
  const isDM = !message.guildId;
  const mentioned = message.mentions.has(client.user);
  const replyingToBot = mentioned ? false : await isReplyToBot(message, client.user.id);
  const directed = isDM || mentioned || replyingToBot;

  if (directed) {
    if (hitUserRateLimit(message.author.id, ctx)) {
      log.debug(`${message.author.username} 触发限流，忽略`);
      return;
    }
    if (dailyBudgetExhausted(ctx)) {
      await message.reply('今天的调用额度用完了，明天再聊。').catch(() => {});
      return;
    }

    try {
      const result = await withTyping(message.channel, () =>
        generateReply({
          channelId: message.channelId,
          botId: client.user.id,
          botName: client.user.username,
          channelName: message.channel?.name,
          ctx,
        })
      );
      if (result.text) {
        await sendReply({ message, channel: message.channel, text: result.text, ctx, asReply: true });
      }
    } catch (err) {
      log.error('回复失败：', err);
      await message.reply('刚才卡了一下，再说一遍？').catch(() => {});
    }
    return;
  }

  // 没人叫它——掷骰子决定要不要主动插一句。
  const verdict = shouldIdleReply({ channelId: message.channelId, ctx });
  if (!verdict.ok) {
    log.debug(`不插话：${verdict.reason}`);
    return;
  }

  // 先占住冷却，免得同时来几条消息各自触发一次。
  markIdle(message.channelId);

  try {
    const result = await withTyping(message.channel, () =>
      generateReply({
        channelId: message.channelId,
        botId: client.user.id,
        botName: client.user.username,
        channelName: message.channel?.name,
        ctx,
        mode: 'idle',
      })
    );

    if (result.skipped) {
      log.debug(`插话被跳过：${result.reason}`);
      return;
    }

    await sendReply({ message, channel: message.channel, text: result.text, ctx, asReply: false });
    recordIdleReply();
    log.info(`在 #${message.channel?.name ?? message.channelId} 主动插了一句`);
  } catch (err) {
    log.error('主动插话失败：', err);
  }
});

// ---------------------------------------------------------------- 维护与收尾

const maintenance = setInterval(() => {
  try {
    purgeOlderThan(getSetting('memory.retentionDays') ?? 14);
    purgeCounters();
    sweepRateLimiter();
  } catch (err) {
    log.warn('定期清理出错：', err);
  }
}, 3600_000);

process.on('unhandledRejection', (err) => log.error('未处理的 Promise 异常：', err));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info(`收到 ${signal}，正在退出`);
    clearInterval(maintenance);
    client.destroy();
    process.exit(0);
  });
}

client.login(process.env.DISCORD_TOKEN);
