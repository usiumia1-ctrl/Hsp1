import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands/index.js';
import { log } from './logger.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('缺少 DISCORD_TOKEN 或 DISCORD_CLIENT_ID，先把 .env 填好。');
  process.exit(1);
}

const body = commands.map((c) => c.data.toJSON());
const rest = new REST().setToken(DISCORD_TOKEN);

const route = DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  : Routes.applicationCommands(DISCORD_CLIENT_ID);

try {
  await rest.put(route, { body });
  log.info(
    DISCORD_GUILD_ID
      ? `已在服务器 ${DISCORD_GUILD_ID} 注册 ${body.length} 条命令，马上就能用。`
      : `已注册 ${body.length} 条全局命令。全局命令最多要等 1 小时才会出现在客户端里——想立刻生效就在 .env 里填 DISCORD_GUILD_ID。`
  );
} catch (err) {
  log.error('注册命令失败：', err);
  process.exit(1);
}
