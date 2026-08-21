// 冒烟测试：不连 Discord、不调 AI API，只验证内部逻辑能跑通。
process.env.ADMIN_USER_IDS = '111,222';
process.env.LOG_LEVEL = 'warn';

const { config } = await import('../src/config.js');
const { getSetting, setSetting, resetSetting, isAdmin } = await import('../src/settings.js');
const { listPersonas, buildSystemPrompt, activePersonaName } = await import('../src/persona.js');
const { splitReply, buildHistory } = await import('../src/chat.js');
const { recordMessage, clearChannel, humanMessagesSince, bump, counterValue } = await import('../src/db.js');
const { shouldIdleReply } = await import('../src/idle.js');
const { commands, commandMap, requiresAdmin } = await import('../src/commands/index.js');
const { configuredProviders, providerNames } = await import('../src/providers/index.js');

let failures = 0;
function check(label, cond, extra = '') {
  if (cond) console.log(`  ok   ${label}`);
  else { console.log(`  FAIL ${label} ${extra}`); failures++; }
}

console.log('\n[配置]');
check('config.json 解析成功', typeof config === 'object');
check('注释键 _说明 已被剔除', !('_说明' in config));
check('provider.default = gemini', getSetting('provider.default') === 'gemini');
check('idle.probability = 0.5', getSetting('idle.probability') === 0.5);
check('点号路径能取到嵌套值', getSetting('idle.quietHours.timezone') === 'Asia/Shanghai');

console.log('\n[设置覆盖优先级]');
setSetting('provider.default', 'claude', 'guild-1');
check('服务器级覆盖生效', getSetting('provider.default', { guildId: 'guild-1' }) === 'claude');
setSetting('provider.default', 'openai', 'chan-1');
check('频道级优先于服务器级', getSetting('provider.default', { guildId: 'guild-1', channelId: 'chan-1' }) === 'openai');
check('无关作用域不受影响', getSetting('provider.default', { guildId: 'guild-9' }) === 'gemini');
resetSetting('provider.default', 'guild-1');
resetSetting('provider.default', 'chan-1');
check('reset 后回落到文件值', getSetting('provider.default', { guildId: 'guild-1' }) === 'gemini');

console.log('\n[管理员]');
check('列表内的是管理员', isAdmin('111'));
check('列表外的不是', !isAdmin('333'));

console.log('\n[人设]');
const personas = listPersonas();
check('扫描到 3 套人设', personas.length === 3, JSON.stringify(personas));
check('默认人设是「网友」', activePersonaName({}) === '网友');
const sys = buildSystemPrompt({}, { botName: '小助手', channelName: '闲聊', mode: 'reply' });
check('system prompt 含人设内容', sys.includes('普通网友'));
check('system prompt 含全局风格', sys.includes('不要用 Markdown 排版'));
check('system prompt 含机器人名字', sys.includes('小助手'));
check('reply 模式不含 SKIP 说明', !sys.includes('SKIP'));
const idleSys = buildSystemPrompt({}, { botName: '小助手', channelName: '闲聊', mode: 'idle' });
check('idle 模式含 SKIP 说明', idleSys.includes('SKIP'));

console.log('\n[追加提示词]');
setSetting('persona.extra', '多用颜文字', 'guild-2');
const extraSys = buildSystemPrompt({ guildId: 'guild-2' }, { botName: 'b', mode: 'reply' });
check('额外提示词被拼进去', extraSys.includes('多用颜文字'));
resetSetting('persona.extra', 'guild-2');

console.log('\n[长文分片]');
const long = '这是一段测试。'.repeat(400);
const parts = splitReply(long, 1900);
check('长文被切成多段', parts.length > 1, `段数=${parts.length}`);
check('每段都不超上限', parts.every((p) => p.length <= 1900), JSON.stringify(parts.map((p) => p.length)));
check('切分后内容无丢失', parts.join('').replace(/\s/g, '') === long.replace(/\s/g, ''));
check('短文本只有一段', splitReply('短短一句', 1900).length === 1);
check('切在句号边界上', parts[0].endsWith('。'));

console.log('\n[历史记录与角色合并]');
const CH = 'smoke-channel';
const BOT = 'bot-id';
clearChannel(CH);
const base = Date.now() - 60_000;
const rows = [
  ['m1', 'u1', '阿强', 0, '今天好热'],
  ['m2', 'u2', '小美', 0, '是啊'],
  ['m3', BOT, '机器人', 1, '开空调吧'],
  ['m4', 'u1', '阿强', 0, '空调坏了'],
];
rows.forEach(([id, author, name, isBot, content], i) =>
  recordMessage({
    message_id: id, guild_id: 'g', channel_id: CH, author_id: author,
    author_name: name, is_bot: isBot, content, created_at: base + i * 1000,
  })
);
const history = buildHistory(CH, BOT, {});
check('相邻同角色被合并', history.length === 3, JSON.stringify(history.map((m) => m.role)));
check('第一条是 user', history[0].role === 'user');
check('最后一条是 user', history.at(-1).role === 'user');
check('角色严格交替', history.every((m, i) => i === 0 || m.role !== history[i - 1].role));
check('用户发言带名字前缀', history[0].content.includes('阿强：'));
check('机器人发言不带前缀', history[1].content === '开空调吧');
check('重复 message_id 不会写入两次', (() => {
  recordMessage({ message_id: 'm1', guild_id: 'g', channel_id: CH, author_id: 'u1', author_name: '阿强', is_bot: 0, content: '重复', created_at: base });
  return buildHistory(CH, BOT, {}).length === 3;
})());
check('只统计真人消息', humanMessagesSince(CH, base - 1000) === 3);

console.log('\n[主动插话判定]');
setSetting('idle.enabled', true, 'global');
setSetting('idle.probability', 1, 'global');
setSetting('idle.activityMinMessages', 3, 'global');
setSetting('idle.quietHours', { enabled: false, start: 0, end: 0, timezone: 'UTC' }, 'global');
const v1 = shouldIdleReply({ channelId: CH, ctx: {} });
check('活跃度达标 + 概率 1 → 允许', v1.ok, v1.reason);
setSetting('idle.activityMinMessages', 99, 'global');
const v2 = shouldIdleReply({ channelId: CH, ctx: {} });
check('活跃度不达标 → 拒绝', !v2.ok && v2.reason.includes('活跃门槛'), v2.reason);
setSetting('idle.activityMinMessages', 3, 'global');
setSetting('idle.probability', 0, 'global');
const v3 = shouldIdleReply({ channelId: CH, ctx: {} });
check('概率 0 → 拒绝', !v3.ok && v3.reason.includes('没掷中'), v3.reason);
setSetting('idle.quietHours', { enabled: true, start: 0, end: 24, timezone: 'UTC' }, 'global');
const v4 = shouldIdleReply({ channelId: CH, ctx: {} });
check('静默时段 → 拒绝', !v4.ok && v4.reason.includes('静默'), v4.reason);
setSetting('idle.enabled', false, 'global');
check('总开关关闭 → 拒绝', !shouldIdleReply({ channelId: CH, ctx: {} }).ok);
for (const k of ['idle.enabled', 'idle.probability', 'idle.activityMinMessages', 'idle.quietHours']) resetSetting(k, 'global');

console.log('\n[额度计数]');
const before = counterValue('smoke:test');
bump('smoke:test');
check('计数器自增', counterValue('smoke:test') === before + 1);

console.log('\n[斜杠命令]');
check('注册了 9 条命令', commands.length === 9, `实际 ${commands.length}`);
const names = commands.map((c) => c.data.name).sort();
check('命令名齐全', names.join(',') === 'ask,clear,idle,model,persona,ping,prompt,reload,stats', names.join(','));
check('每条命令都能序列化成 Discord 载荷', commands.every((c) => {
  const json = c.data.toJSON();
  return json.name && json.description;
}));
check('命令名都是合法的 ASCII 小写', names.every((n) => /^[a-z0-9_-]{1,32}$/.test(n)));
check('/clear 整条需要管理员', commandMap.get('clear').adminOnly === true);
check('/persona use 需要管理员', requiresAdmin(commandMap.get('persona'), { options: { getSubcommand: () => 'use' } }));
check('/persona list 不需要管理员', !requiresAdmin(commandMap.get('persona'), { options: { getSubcommand: () => 'list' } }));
check('/ping 不需要管理员', !requiresAdmin(commandMap.get('ping'), { options: { getSubcommand: () => null } }));

console.log('\n[供应商]');
check('三家都注册了', providerNames.join(',') === 'gemini,openai,claude', providerNames.join(','));
check('没填 key 时可用列表为空', configuredProviders().length === 0, JSON.stringify(configuredProviders()));
process.env.GEMINI_API_KEY = 'fake';
check('填了 key 后能被识别', configuredProviders().includes('gemini'));
delete process.env.GEMINI_API_KEY;

clearChannel(CH);
console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`);
process.exit(failures === 0 ? 0 : 1);
