# Discord AI 聊天机器人

一个跑在自己服务器上的 Discord 机器人：@ 它就聊天，能读频道上下文，会按概率主动插话，人设写在 Markdown 文件里随时热改。后端 AI 可以在 **Google Gemini / OpenAI / Anthropic Claude** 三家之间随时切换，默认走 Gemini 的免费额度。

配上谷歌云的 Always Free 机器，整套东西可以**长期零成本运行**。

---

## 目录

- [它能做什么](#它能做什么)
- [第一步：开一台免费的谷歌云机器](#第一步开一台免费的谷歌云机器)
- [第二步：拿到几把钥匙](#第二步拿到几把钥匙)
- [第三步：部署](#第三步部署)
- [日常使用](#日常使用)
- [调参数](#调参数)
- [写自己的人设](#写自己的人设)
- [排错](#排错)
- [花多少钱](#花多少钱)

---

## 它能做什么

| 功能 | 说明 |
|---|---|
| @ 提及对话 | 艾特它就回话，直接回复它的消息也算 |
| 私聊 | DM 里也能聊 |
| 读上下文 | 记住频道里最近的对话，包括没在跟它说话的部分 |
| 主动插话 | 按概率自己开口，有冷却、活跃度门槛和静默时段兜底 |
| 多套人设 | `personas/` 目录里一个 `.md` 一套，`/persona use` 随时换 |
| 追加提示词 | 在人设之上再叠一层临时要求，Discord 里直接改 |
| 三家 AI | Gemini / OpenAI / Claude，`/model` 切换，某家挂了自动降级到下一家 |
| 记忆持久化 | 存 SQLite，重启不丢，过期自动清理 |
| 额度保护 | 每日调用总闸 + 主动插话独立上限 + 单用户限流 |
| 崩溃自愈 | systemd 托管，挂了自动拉起，开机自启 |

---

## 第一步：开一台免费的谷歌云机器

> 已经有服务器了？跳到[第二步](#第二步拿到几把钥匙)。

### 1.1 必须踩准的四个参数

谷歌云的 Always Free 条件很死，**错一个就开始计费**：

| 项目 | 必须是 |
|---|---|
| 机器类型 | **e2-micro** |
| 区域 | **us-central1**（爱荷华）/ **us-west1**（俄勒冈）/ **us-east1**（南卡）三选一 |
| 启动磁盘 | **标准永久性磁盘**，≤ 30GB —— 别选 SSD 或平衡型，选了就收费 |
| 数量 | 全账号只能有 **1 台** |

系统选 **Debian 12** 或 **Ubuntu 22.04/24.04**，部署脚本这两个都支持。

防火墙那两个 HTTP/HTTPS 的勾**不用勾**——机器人是主动连出去的，不需要任何入站端口。

### 1.2 ⚠️ 90 天后不做这一步，机器会被删

你注册时拿到的那笔赠金（$300 / €263 之类）是**试用额度，会过期**。90 天到期或赠金烧完，试用就结束，工作负载停机，**再过 30 天宽限期，机器直接删除**。

保住机器的正确操作是：**在试用结束前，主动把账号升级成付费账号（Paid）**。

升级本身不会立刻扣钱。升级之后，只要你的用量卡在 Always Free 额度内，账单就是 $0；没用完的赠金也还能继续用到 90 天期满。

**建议现在就去账单页面设个预算提醒**（比如超过 $1 就发邮件），万一哪天配置手滑了能第一时间知道。

### 1.3 连上去

创建完成后，在实例列表点 **SSH** 就能在浏览器里开终端——手机上也能用，不用装任何 App，也不用管密钥。

---

## 第二步：拿到几把钥匙

一共四样东西，都能在手机浏览器里搞定。

### 2.1 Discord 机器人

打开 [Discord 开发者后台](https://discord.com/developers/applications)：

1. 右上角 **New Application**，起个名
2. 左边 **Bot** → **Reset Token** → 复制。这是 `DISCORD_TOKEN`
   > 这个 token 等于机器人的密码，泄露了别人就能操控它。只往 `.env` 里放，别发给任何人，别提交到 GitHub
3. 同一页往下拉，**Privileged Gateway Intents** 里把 **MESSAGE CONTENT INTENT** 打开
   > **这一步不做，机器人收不到任何消息内容。** 你的 bot 在 100 个服务器以内可以自助开启，不用申请审核
4. 左边 **General Information** → 复制 **Application ID**。这是 `DISCORD_CLIENT_ID`
5. 左边 **OAuth2** → **URL Generator**：
   - SCOPES 勾 `bot` 和 `applications.commands`
   - BOT PERMISSIONS 勾 `View Channels`、`Send Messages`、`Read Message History`
   - 复制最下面生成的链接，浏览器打开，把它邀请进你的服务器

### 2.2 你自己的 Discord ID

在 Discord 客户端里：**设置 → 高级设置 → 打开「开发者模式」**。

然后：

- 长按（手机）或右键（电脑）**你自己的头像** → 复制用户 ID → 这是 `ADMIN_USER_IDS`
- 长按**服务器图标** → 复制服务器 ID → 这是 `DISCORD_GUILD_ID`

> `DISCORD_GUILD_ID` 填了的话，斜杠命令注册后**立刻生效**；留空会注册成全局命令，Discord 那边最多要等 1 小时才推送到客户端。私人服务器建议填上。

### 2.3 Gemini API Key（免费的那个）

打开 [Google AI Studio](https://aistudio.google.com/apikey)，登录谷歌账号，点 **Get API key** / **创建 API 密钥**。

不用绑卡，不用付款。这是 `GEMINI_API_KEY`。

免费额度大致是 Flash 系列 250 次/天、Flash-Lite 1000 次/天。注意免费额度的对话内容会被 Google 用于改进产品，别拿它处理敏感信息。

### 2.4 OpenAI / Claude（可选）

这两家都**没有免费额度**，需要先充值：

- OpenAI：<https://platform.openai.com/api-keys>
- Claude：<https://console.anthropic.com/settings/keys>

不填也完全能用，bot 会只走 Gemini。

---

## 第三步：部署

> ### ⚠️ 手机上操作先看这两条
>
> **1. 命令一条一条敲，不要一次粘贴多行。**
> 一次粘贴多行的话，`apt`、`git`、`nano` 这类会读取输入的命令会把你后面几行当成自己的输入吞掉——那几行只是显示在屏幕上，实际从来没执行。典型症状是后面报 `No such file or directory`，因为中间的 `git clone` 或 `cd` 根本没跑。
>
> **2. 先装 `tmux`，不然断线就前功尽弃。**
> 浏览器版 SSH 在手机上很容易断，**一断线正在跑的命令就被直接杀掉**。装依赖要跑好几分钟，中途断了就得重来。`tmux` 能让命令在服务器上继续跑，重连后原样接回现场。

### 3.1 装 git 和 tmux

```bash
sudo apt update
```

```bash
sudo apt install -y git tmux
```

### 3.2 拉代码

下面这条是单行，可以整条粘贴：

```bash
cd ~ && git clone https://github.com/usiumia1-ctrl/Hsp1.git hsp1 && cd hsp1 && git checkout claude/mobile-discord-bot-dev-6nnto8 && ls
```

看到 `README.md`、`src`、`scripts` 等文件名就说明成功了。

> 如果提示目录已存在，先 `rm -rf ~/hsp1` 再重来。

### 3.3 开一个 tmux 会话

```bash
tmux new -s bot
```

屏幕闪一下、底部出现绿色状态栏，就说明进去了。**接下来所有命令都在这里面跑。**

万一断线了，重新连上 SSH 后敲这条就能回到现场：

```bash
tmux attach -t bot
```

### 3.4 跑部署脚本

```bash
cd ~/hsp1 && bash scripts/deploy.sh
```

脚本会生成一个空的 `.env` 然后停住。把钥匙填进去：

```bash
nano .env
```

> `nano` 的操作：方向键移动，直接打字。填完按 `Ctrl+O` 再按回车保存，然后 `Ctrl+X` 退出。
> 手机上没有 Ctrl 键的话，浏览器 SSH 窗口顶部有虚拟按键栏。

至少要填 `DISCORD_TOKEN`、`DISCORD_CLIENT_ID`、`ADMIN_USER_IDS`、`GEMINI_API_KEY` 这四项。

填完再跑一次同样的脚本，这次它会注册斜杠命令并把 bot 启动起来：

```bash
bash scripts/deploy.sh
```

看到「启动成功」就成了。去 Discord 里 @ 它试试。

### 之后怎么更新

```bash
cd ~/hsp1 && git pull && bash scripts/deploy.sh
```

### 日常运维命令

```bash
sudo journalctl -u aibot -f        # 看实时日志（排错先看这个）
sudo systemctl restart aibot       # 重启
sudo systemctl stop aibot          # 停止
sudo systemctl status aibot        # 看状态
```

---

## 日常使用

平时直接 **@机器人** 说话就行，或者**回复**它的消息接着聊。

斜杠命令：

| 命令 | 作用 | 权限 |
|---|---|---|
| `/ask <问题>` | 直接提问，不用 @ | 所有人 |
| `/ping` | 看它活着没、延迟多少 | 所有人 |
| `/stats` | 今天用了多少次调用 | 所有人 |
| `/persona list` | 列出所有人设 | 所有人 |
| `/persona show` | 看当前人设和追加的提示词 | 所有人 |
| `/persona use <名字>` | 换人设（带自动补全） | 管理员 |
| `/prompt show` | 看追加了什么提示词 | 所有人 |
| `/prompt set <内容>` | 追加临时提示词 | 管理员 |
| `/prompt clear` | 清掉追加的提示词 | 管理员 |
| `/model show` | 看当前用哪家哪个型号 | 所有人 |
| `/model list <家>` | 列出你账号下**实际可用**的型号 | 所有人 |
| `/model set <家> [型号]` | 切换供应商 | 管理员 |
| `/idle status` | 看主动插话的设置和今日用量 | 所有人 |
| `/idle on` / `/idle off` | 开关主动插话 | 管理员 |
| `/idle set` | 调概率、冷却、每日上限 | 管理员 |
| `/clear` | 清空本频道的对话记忆 | 管理员 |
| `/reload` | 重读配置和人设文件，不用重启 | 管理员 |

> 模型名会随时间变化。`/model list gemini` 查的是你账号下**当前真实可用**的型号，比配置文件里写死的靠谱。

---

## 调参数

改 `config/config.json`，然后在 Discord 里发 `/reload` 生效（不用重启）。

也可以直接用斜杠命令改——命令改的值存在数据库里，**优先级高于配置文件**，而且能按服务器 / 按频道分别设置。

### 主动插话（最需要调的部分）

```json
"idle": {
  "enabled": true,
  "probability": 0.5,
  "cooldownSeconds": 300,
  "activityWindowMinutes": 5,
  "activityMinMessages": 3,
  "dailyMax": 120,
  "channels": [],
  "quietHours": { "enabled": true, "start": 2, "end": 8, "timezone": "Asia/Shanghai" }
}
```

**真正决定烧多少额度的是 `cooldownSeconds`，不是 `probability`。**

冷却 N 秒意味着每个频道每天最多插话 `86400 / N` 次，跟概率完全无关：

| 冷却 | 每频道每天最多 | 说明 |
|---|---|---|
| 300 秒（默认） | 288 次 | 配合 `dailyMax: 120` 实际封顶 120 |
| 600 秒 | 144 次 | 更克制 |
| 60 秒 | 1440 次 | 会瞬间烧穿免费额度，别这么设 |

`probability` 控制的是**在够格插话的时机里开口的比例**——概率高只是让它更爱说话，说话总量还是被冷却和 `dailyMax` 锁死的。

判定顺序是：总开关 → 频道白名单 → 静默时段 → 冷却 → 活跃度 → 每日额度 → 掷骰子。

`channels` 留空数组表示所有频道都可能插话；填了频道 ID 就只在这些频道插。

### 其他常用项

| 配置项 | 默认 | 说明 |
|---|---|---|
| `provider.default` | `gemini` | 默认用哪家 |
| `provider.models.*` | 见文件 | 各家的型号名 |
| `provider.maxOutputTokens` | 800 | 单次回复最长多少 token |
| `provider.temperature` | 0.9 | 越高越跳脱 |
| `memory.contextMessages` | 30 | 每次带多少条历史进 prompt，调大更懂上下文但更烧 token |
| `memory.retentionDays` | 14 | 数据库保留多少天 |
| `limits.dailyRequestMax` | 240 | **每日调用总闸**，超了当天停止调用 |
| `limits.userPerMinute` | 5 | 单用户每分钟最多触发几次 |

---

## 写自己的人设

在 `personas/` 目录下新建一个 `.md` 文件，文件名就是人设名字。内容就是普通的自然语言描述，没有任何格式要求。

仓库里自带三套：`网友`、`助手`、`毒舌`，可以照着改。

最终发给模型的 system prompt 是**四层叠加**的：

```
personas/<当前人设>.md     ← 角色是谁
        +
prompts/style.md           ← 全局聊天风格（对所有人设生效）
        +
/prompt set 追加的内容      ← 临时要求，Discord 里随时改
        +
运行时信息                  ← 机器人名字、频道名、当前时间
```

`prompts/style.md` 是让它「像网友聊天」的关键——短句、不用 Markdown 排版、不说客服腔。想调整整体说话方式改这个文件，想换角色改 `personas/`。

改完文件后在 Discord 发 `/reload` 就生效。

---

## 排错

**先看日志，八成问题日志里直接写着原因：**

```bash
sudo journalctl -u aibot -n 50 --no-pager
```

| 症状 | 原因 |
|---|---|
| `No such file or directory` | 多半是一次粘贴了多行，中间的 `git clone` 或 `cd` 被 apt 之类的命令吞掉了。一条一条重新敲 |
| 装到一半 SSH 断了 | 没在 tmux 里跑。重连后 `tmux attach -t bot` 接回去；没开过 tmux 就只能重跑脚本（脚本是幂等的，重跑安全） |
| @ 它完全没反应 | MESSAGE CONTENT INTENT 没开（开发者后台 → Bot 页面） |
| 斜杠命令不出现 | `.env` 里没填 `DISCORD_GUILD_ID`，全局命令要等最多 1 小时 |
| 命令说「只有管理员能用」 | `ADMIN_USER_IDS` 没填，或填的不是你的用户 ID |
| 回复「所有供应商都失败了」 | API key 错了，或型号名不对——用 `/model list gemini` 看真实可用的型号 |
| 提示额度用完 | Gemini 免费额度到顶了，或撞到 `limits.dailyRequestMax`。用 `/stats` 看用量 |
| 它自言自语太频繁 | 调大 `cooldownSeconds`，或 `/idle set cooldown:600` |
| 服务反复重启 | `journalctl` 里看具体报错，多半是 `.env` 某项格式不对 |
| 内存不够 / 装依赖卡死 | 部署脚本会自动配 2GB swap；确认 `swapon --show` 有输出 |

改完代码想自测：

```bash
npm test
```

这会跑一遍内部逻辑的检查（配置解析、上下文合并、分片、插话判定、命令定义），不连 Discord 也不调 AI API。

---

## 花多少钱

| 项目 | 成本 |
|---|---|
| 谷歌云 e2-micro | **$0** —— 只要踩准 Always Free 的四个条件 |
| Gemini Flash | **$0** —— 每天 250 次左右的免费额度 |
| OpenAI | 按量付费，无免费额度 |
| Claude | 按量付费，无免费额度。参考价：Haiku 4.5 是 $1/$5 每百万 token（输入/输出），Sonnet 5 是 $3/$15，Opus 5 是 $5/$25 |

默认配置（Gemini + 谷歌云免费机器）的运行成本是 **0**。

配置里 `provider.models.claude` 默认写的是 `claude-opus-5`，这是最贵的档。日常闲聊想省钱可以换成 `claude-haiku-4-5`：

```
/model set provider:claude model:claude-haiku-4-5
```

三道保险防止意外烧钱：`limits.dailyRequestMax`（每日总闸）、`idle.dailyMax`（主动插话上限）、`limits.userPerMinute`（单人限流）。默认值下就算 bot 被人恶意刷，一天也最多 240 次调用。

---

## 目录结构

```
config/config.json      配置（可 /reload 热加载）
personas/*.md           人设，一个文件一套
prompts/style.md        全局聊天风格
src/
  index.js              入口：Discord 事件处理
  chat.js               上下文组装、生成回复、长文分片
  idle.js               主动插话的判定逻辑
  persona.js            人设加载与四层 prompt 拼装
  quota.js              额度与限流
  settings.js           配置优先级（频道 → 服务器 → 全局 → 文件）
  db.js                 SQLite
  providers/            三家 AI 的统一封装
  commands/             斜杠命令
scripts/deploy.sh       一键部署
test/smoke.mjs          内部逻辑自测
```
