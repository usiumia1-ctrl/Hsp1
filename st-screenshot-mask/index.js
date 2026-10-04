// 截图打码 Screenshot Mask —— SillyTavern 扩展
// 打开「分享模式」后，把聊天界面里的 user / char / NPC 名字替换成代号、黑条、模糊或贴纸。
// 只修改页面显示，不会改动聊天记录，也不影响发送给 AI 的内容。

const MODULE = 'screenshot_mask';
const MAX_STICKERS = 12;
const STICKER_MAX_SIZE = 160;

// 会被打码的区域（每条消息内）
const TARGETS = '.name_text, .mes_text, .mes_reasoning';

const DEFAULTS = {
    active: false,
    style: 'alias',          // alias | bar | blur | sticker
    maskUser: true,
    maskChar: true,
    maskWords: true,
    userAlias: '用户',
    charAlias: '角色',
    npcAlias: 'NPC',
    globalWords: '',
    perChar: {},             // { 'char:xxx.png' | 'group:id': '词表文本' }
    blur: 6,
    barColor: '#111111',
    stickers: [],            // dataURL 数组
    emoji: '🙈',
    stickerFit: 'repeat',    // repeat | single
    avatar: 'off',           // off | blur | sticker
};

// ---------- 基础工具 ----------

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE]) all[MODULE] = {};
    const s = all[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function letterIndex(i) {
    return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

// ---------- 收集要打码的名字 ----------

function getTargetKey() {
    const c = ctx();
    if (c.groupId) return 'group:' + c.groupId;
    const ch = c.characters?.[c.characterId];
    return ch ? 'char:' + ch.avatar : null;
}

function getTargetLabel() {
    const c = ctx();
    if (c.groupId) {
        const g = c.groups?.find(x => x.id == c.groupId);
        return g ? `群聊「${g.name}」` : '当前群聊';
    }
    const ch = c.characters?.[c.characterId];
    return ch ? `角色「${ch.name}」` : null;
}

function collectNames() {
    const c = ctx();
    const users = new Set();
    const chars = new Set();

    if (c.name1) users.add(c.name1);

    if (c.groupId) {
        const g = c.groups?.find(x => x.id == c.groupId);
        for (const av of g?.members ?? []) {
            const ch = c.characters?.find(x => x.avatar === av);
            if (ch?.name) chars.add(ch.name);
        }
    } else {
        const ch = c.characters?.[c.characterId];
        if (ch?.name) chars.add(ch.name);
        else if (c.name2) chars.add(c.name2);
    }

    // 聊天记录里出现过的发言者（换过 persona、群聊里退出的角色等）
    for (const m of c.chat ?? []) {
        if (!m?.name || m.is_system) continue;
        (m.is_user ? users : chars).add(m.name);
    }

    for (const u of users) chars.delete(u);
    return { users: [...users], chars: [...chars] };
}

// 词表格式：每行一个，`名字` 或 `名字=代号`，多个写法用 | 连接：`李管家|老李=管家`
function parseWords(text) {
    const result = [];
    for (const raw of String(text ?? '').split(/[\n,，、;；]/)) {
        const line = raw.trim();
        if (!line) continue;
        const [left, ...rest] = line.split(/[=＝]/);
        const variants = left.split('|').map(x => x.trim()).filter(Boolean);
        if (!variants.length) continue;
        const alias = rest.join('=').trim() || null;
        result.push({ variants, alias });
    }
    return result;
}

// entries: [{ key, alias, variants }]
function buildEntries() {
    const s = settings();
    const { users, chars } = collectNames();
    const entries = [];

    if (s.maskUser) {
        for (const name of users) {
            entries.push({ key: 'user:' + name, alias: s.userAlias || '用户', variants: [name] });
        }
    }

    if (s.maskChar) {
        chars.forEach((name, i) => {
            const alias = (s.charAlias || '角色') + (chars.length > 1 ? letterIndex(i) : '');
            entries.push({ key: 'char:' + name, alias, variants: [name] });
        });
    }

    if (s.maskWords) {
        const key = getTargetKey();
        const words = [
            ...parseWords(key ? s.perChar[key] : ''),
            ...parseWords(s.globalWords),
        ];
        words.forEach((w, i) => {
            entries.push({
                key: 'word:' + w.variants[0],
                alias: w.alias || (s.npcAlias || 'NPC') + (i + 1),
                variants: w.variants,
            });
        });
    }

    return entries;
}

let matcherCache = { sig: null, re: null, lookup: null };

function getMatcher() {
    const entries = buildEntries();
    const lookup = new Map();
    // 后加入的覆盖先加入的：词表里写 `Alice=小A` 可以自定义角色代号
    for (const e of entries) {
        for (const v of e.variants) lookup.set(v.toLowerCase(), e);
    }
    const variants = [...lookup.keys()].sort((a, b) => b.length - a.length);
    const sig = JSON.stringify([...lookup].map(([k, e]) => [k, e.alias, e.key]));
    if (sig === matcherCache.sig) return matcherCache;

    let re = null;
    if (variants.length) {
        const parts = variants.map(v => {
            let p = escapeRegex(v);
            // 英文名加边界，避免 Ann 匹配到 Anna、Banner；中文名不加
            if (/^[A-Za-z0-9_]/.test(v)) p = '(?<![A-Za-z0-9_])' + p;
            if (/[A-Za-z0-9_]$/.test(v)) p = p + '(?![A-Za-z0-9_])';
            return p;
        });
        re = new RegExp(parts.join('|'), 'gi');
    }
    matcherCache = { sig, re, lookup };
    return matcherCache;
}

// ---------- 贴纸 ----------

function emojiToDataUrl(emoji) {
    const size = 96;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const g = canvas.getContext('2d');
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `${size * 0.8}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    g.fillText(emoji || '🙈', size / 2, size / 2 + size * 0.05);
    return canvas.toDataURL('image/png');
}

function stickerList() {
    const s = settings();
    return s.stickers.length ? s.stickers : [emojiToDataUrl(s.emoji)];
}

function stickerIndexFor(entry) {
    return hashString(entry.key) % stickerList().length;
}

function fileToSticker(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => {
            const img = new Image();
            img.onerror = reject;
            img.onload = () => {
                const scale = Math.min(1, STICKER_MAX_SIZE / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/png'));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

// ---------- 页面状态（CSS 变量、body class）----------

function applyBodyState() {
    const s = settings();
    const body = document.body;
    body.classList.toggle('sm-active', !!s.active);
    body.classList.toggle('sm-avatar-blur', s.avatar === 'blur');
    body.classList.toggle('sm-avatar-sticker', s.avatar === 'sticker');
    body.style.setProperty('--sm-blur', `${s.blur}px`);
    body.style.setProperty('--sm-avatar-blur', `${Math.max(6, s.blur + 2)}px`);
    body.style.setProperty('--sm-bar-color', s.barColor);

    // 清掉旧的贴纸变量，再写入新的
    for (let i = 0; i < MAX_STICKERS; i++) body.style.removeProperty(`--sm-sticker-${i}`);
    stickerList().forEach((url, i) => body.style.setProperty(`--sm-sticker-${i}`, `url("${url}")`));
}

// ---------- 打码 / 还原 ----------

function makeMask(orig, entry) {
    const s = settings();
    const span = document.createElement('span');
    span.className = `sm-mask sm-${s.style}`;
    span.dataset.smOrig = orig;

    switch (s.style) {
        case 'alias':
            span.textContent = entry.alias;
            break;
        case 'sticker':
            span.style.backgroundImage = `var(--sm-sticker-${stickerIndexFor(entry)})`;
            if (s.stickerFit === 'single') {
                span.classList.add('sm-sticker-single');
                span.textContent = '';
            } else {
                span.textContent = orig;
            }
            break;
        default: // bar / blur：保留原文，由 CSS 遮盖
            span.textContent = orig;
    }
    return span;
}

function maskTextNode(node, re, lookup) {
    const text = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) return;
    re.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
        if (!m[0]) { re.lastIndex++; continue; }
        const entry = lookup.get(m[0].toLowerCase());
        if (!entry) continue;
        if (m.index > last) frag.append(text.slice(last, m.index));
        frag.append(makeMask(m[0], entry));
        last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
}

function maskElement(root, matcher) {
    if (!matcher.re) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            const p = n.parentElement;
            if (!p || p.closest('.sm-mask, textarea, input, script, style')) return NodeFilter.FILTER_REJECT;
            return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) maskTextNode(n, matcher.re, matcher.lookup);
}

function maskMessage(mes, matcher) {
    for (const el of mes.querySelectorAll(TARGETS)) maskElement(el, matcher);
}

function maskAll() {
    const chat = document.getElementById('chat');
    if (!chat) return;
    const matcher = getMatcher();
    chat.querySelectorAll('.mes').forEach(mes => maskMessage(mes, matcher));
    observer?.takeRecords();
}

function unmaskAll() {
    const parents = new Set();
    document.querySelectorAll('#chat .sm-mask').forEach(span => {
        if (span.parentNode) parents.add(span.parentNode);
        span.replaceWith(document.createTextNode(span.dataset.smOrig ?? ''));
    });
    parents.forEach(p => p.normalize());
    observer?.takeRecords();
}

function remask() {
    unmaskAll();
    if (settings().active) maskAll();
}

// ---------- 监听新消息 / 流式输出 ----------

let observer = null;
const pending = new Set();
let scheduled = false;

function flush() {
    scheduled = false;
    if (!settings().active) { pending.clear(); return; }
    const matcher = getMatcher();
    for (const mes of pending) {
        if (mes.isConnected) maskMessage(mes, matcher);
    }
    pending.clear();
    observer?.takeRecords(); // 丢弃我们自己造成的变动
}

function startObserver() {
    const chat = document.getElementById('chat');
    if (!chat || observer) return;
    observer = new MutationObserver(mutations => {
        if (!settings().active) return;
        for (const m of mutations) {
            const el = m.target.nodeType === Node.ELEMENT_NODE ? m.target : m.target.parentElement;
            const mes = el?.closest?.('.mes');
            if (mes) {
                pending.add(mes);
                continue;
            }
            for (const n of m.addedNodes) {
                if (n.nodeType !== Node.ELEMENT_NODE) continue;
                if (n.classList.contains('mes')) pending.add(n);
                else n.querySelectorAll?.('.mes').forEach(x => pending.add(x));
            }
        }
        if (pending.size && !scheduled) {
            scheduled = true;
            requestAnimationFrame(flush);
        }
    });
    observer.observe(chat, { childList: true, subtree: true, characterData: true });
}

// ---------- 开关 ----------

function setActive(on) {
    const s = settings();
    s.active = !!on;
    save();
    applyBodyState();
    remask();
    updateToggleUI();
}

function updateToggleUI() {
    const on = !!settings().active;
    $('#sm_active').prop('checked', on);
    $('#sm_menu_toggle').toggleClass('sm-on', on);
    $('#sm_menu_toggle .sm-menu-text').text(on ? '分享模式：开' : '分享模式：关');
    $('#sm_menu_toggle .fa-solid').toggleClass('fa-eye-slash', on).toggleClass('fa-eye', !on);
}

// ---------- 设置面板 ----------

const SETTINGS_HTML = `
<div id="sm_settings" class="sm-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>截图打码</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" id="sm_active"><b>开启分享模式</b></label>
      <div class="sm-hint">也可以在输入框左边的魔杖菜单 🪄 里快速开关。只改页面显示，不会改动聊天记录。</div>
      <hr>

      <div class="sm-row">
        <label class="sm-label" for="sm_style">打码方式</label>
        <select id="sm_style" class="text_pole">
          <option value="alias">替换成代号</option>
          <option value="bar">黑条遮盖</option>
          <option value="blur">模糊</option>
          <option value="sticker">贴纸</option>
        </select>
      </div>

      <div class="sm-row sm-only-bar">
        <label class="sm-label" for="sm_bar_color">黑条颜色</label>
        <input type="color" id="sm_bar_color">
      </div>

      <div class="sm-row sm-only-blur">
        <label class="sm-label" for="sm_blur">模糊强度</label>
        <input type="range" id="sm_blur" min="2" max="14" step="1">
        <span id="sm_blur_val"></span>
      </div>

      <div class="sm-only-sticker">
        <div class="sm-row">
          <label class="sm-label" for="sm_sticker_fit">贴纸铺法</label>
          <select id="sm_sticker_fit" class="text_pole">
            <option value="repeat">平铺盖住名字（长度不变）</option>
            <option value="single">单个贴纸替换名字</option>
          </select>
        </div>
        <div class="sm-row">
          <label class="sm-label" for="sm_emoji">默认贴纸</label>
          <input type="text" id="sm_emoji" class="text_pole" style="width:5em" maxlength="8">
          <span class="sm-hint">没上传图片时用这个 emoji</span>
        </div>
        <div class="sm-row">
          <div class="menu_button" id="sm_sticker_add"><i class="fa-solid fa-upload"></i> 上传贴纸</div>
          <input type="file" id="sm_sticker_file" class="sm-sticker-upload" accept="image/*" multiple>
          <span class="sm-hint">最多 ${MAX_STICKERS} 张，多张时每个名字固定分到一张</span>
        </div>
        <div class="sm-stickers" id="sm_sticker_list"></div>
      </div>

      <div class="sm-row">
        <label class="sm-label" for="sm_avatar">头像</label>
        <select id="sm_avatar" class="text_pole">
          <option value="off">不处理</option>
          <option value="blur">模糊</option>
          <option value="sticker">盖第一张贴纸</option>
        </select>
      </div>
      <hr>

      <b>打码对象</b>
      <div class="sm-row">
        <label class="checkbox_label"><input type="checkbox" id="sm_mask_user">user 名字</label>
        <span class="sm-hint">代号</span>
        <input type="text" id="sm_user_alias" class="text_pole" style="width:7em">
      </div>
      <div class="sm-row">
        <label class="checkbox_label"><input type="checkbox" id="sm_mask_char">char 名字</label>
        <span class="sm-hint">代号</span>
        <input type="text" id="sm_char_alias" class="text_pole" style="width:7em">
        <span class="sm-hint">群聊会自动编成 A、B、C…</span>
      </div>
      <div class="sm-row">
        <label class="checkbox_label"><input type="checkbox" id="sm_mask_words">NPC / 自定义词</label>
        <span class="sm-hint">默认代号前缀</span>
        <input type="text" id="sm_npc_alias" class="text_pole" style="width:7em">
      </div>

      <div class="sm-hint">
        每行一个。<code>李管家</code> → 自动编号为 NPC1、NPC2…；
        <code>李管家=管家</code> → 自定义代号；
        <code>李管家|老李=管家</code> → 多种写法用同一个代号。
        也能用来给 char 起别名，例如 <code>Alice|小爱=A</code>。
      </div>
      <label for="sm_char_words"><span id="sm_char_words_label">当前角色专属词表</span></label>
      <textarea id="sm_char_words" class="text_pole" placeholder="只在当前角色/群聊生效"></textarea>
      <label for="sm_global_words">全局词表（所有聊天都生效）</label>
      <textarea id="sm_global_words" class="text_pole" placeholder="例如：你的真名、常用地名…"></textarea>
    </div>
  </div>
</div>`;

function renderStickerList() {
    const s = settings();
    const list = $('#sm_sticker_list').empty();
    s.stickers.forEach((url, i) => {
        const item = $('<div class="sm-sticker-item"></div>').css('background-image', `url("${url}")`);
        const del = $('<div class="sm-sticker-del" title="删除">×</div>').on('click', () => {
            s.stickers.splice(i, 1);
            onSettingsChanged();
            renderStickerList();
        });
        list.append(item.append(del));
    });
}

function refreshStyleRows() {
    const style = settings().style;
    $('#sm_settings .sm-only-bar').toggle(style === 'bar');
    $('#sm_settings .sm-only-blur').toggle(style === 'blur');
    // 头像可以盖贴纸，所以选了「贴纸」头像时也显示贴纸设置
    $('#sm_settings .sm-only-sticker').toggle(style === 'sticker' || settings().avatar === 'sticker');
}

function refreshCharWords() {
    const s = settings();
    const key = getTargetKey();
    const label = getTargetLabel();
    $('#sm_char_words_label').text(label ? `${label}专属词表` : '当前角色专属词表（请先打开一个聊天）');
    $('#sm_char_words').prop('disabled', !key).val(key ? (s.perChar[key] ?? '') : '');
}

function loadSettingsUI() {
    const s = settings();
    $('#sm_style').val(s.style);
    $('#sm_bar_color').val(s.barColor);
    $('#sm_blur').val(s.blur);
    $('#sm_blur_val').text(`${s.blur}px`);
    $('#sm_sticker_fit').val(s.stickerFit);
    $('#sm_emoji').val(s.emoji);
    $('#sm_avatar').val(s.avatar);
    $('#sm_mask_user').prop('checked', s.maskUser);
    $('#sm_mask_char').prop('checked', s.maskChar);
    $('#sm_mask_words').prop('checked', s.maskWords);
    $('#sm_user_alias').val(s.userAlias);
    $('#sm_char_alias').val(s.charAlias);
    $('#sm_npc_alias').val(s.npcAlias);
    $('#sm_global_words').val(s.globalWords);
    refreshCharWords();
    renderStickerList();
    refreshStyleRows();
    updateToggleUI();
}

function onSettingsChanged() {
    save();
    applyBodyState();
    remask();
}

function bindSettingsUI() {
    const s = settings();
    const bind = (sel, key, getter = el => el.value, event = 'input') => {
        $(sel).on(event, function () {
            s[key] = getter(this);
            onSettingsChanged();
        });
    };

    $('#sm_active').on('change', function () { setActive(this.checked); });

    $('#sm_style').on('change', function () {
        s.style = this.value;
        refreshStyleRows();
        onSettingsChanged();
    });
    $('#sm_avatar').on('change', function () {
        s.avatar = this.value;
        refreshStyleRows();
        onSettingsChanged();
    });
    bind('#sm_bar_color', 'barColor');
    $('#sm_blur').on('input', function () {
        s.blur = Number(this.value);
        $('#sm_blur_val').text(`${s.blur}px`);
        onSettingsChanged();
    });
    bind('#sm_sticker_fit', 'stickerFit', el => el.value, 'change');
    bind('#sm_emoji', 'emoji', el => el.value.trim() || '🙈', 'change');
    bind('#sm_mask_user', 'maskUser', el => el.checked, 'change');
    bind('#sm_mask_char', 'maskChar', el => el.checked, 'change');
    bind('#sm_mask_words', 'maskWords', el => el.checked, 'change');
    bind('#sm_user_alias', 'userAlias');
    bind('#sm_char_alias', 'charAlias');
    bind('#sm_npc_alias', 'npcAlias');
    bind('#sm_global_words', 'globalWords');

    $('#sm_char_words').on('input', function () {
        const key = getTargetKey();
        if (!key) return;
        if (this.value.trim()) s.perChar[key] = this.value;
        else delete s.perChar[key];
        onSettingsChanged();
    });

    $('#sm_sticker_add').on('click', () => $('#sm_sticker_file').trigger('click'));
    $('#sm_sticker_file').on('change', async function () {
        const files = [...this.files];
        this.value = '';
        for (const f of files) {
            if (s.stickers.length >= MAX_STICKERS) {
                toastr.warning(`贴纸最多 ${MAX_STICKERS} 张`);
                break;
            }
            try {
                s.stickers.push(await fileToSticker(f));
            } catch (e) {
                console.error('[截图打码] 读取贴纸失败', e);
                toastr.error(`读取图片失败：${f.name}`);
            }
        }
        renderStickerList();
        onSettingsChanged();
    });
}

function addMenuButton() {
    const btn = $(`
      <div id="sm_menu_toggle" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
        <div class="fa-solid fa-eye extensionsMenuExtensionButton"></div>
        <span class="sm-menu-text">分享模式：关</span>
      </div>`);
    btn.on('click', () => setActive(!settings().active));
    $('#extensionsMenu').append(btn);
}

// ---------- 初始化 ----------

jQuery(() => {
    settings();
    const container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    container.append(SETTINGS_HTML);
    addMenuButton();
    bindSettingsUI();
    loadSettingsUI();
    applyBodyState();
    startObserver();
    if (settings().active) maskAll();

    const { eventSource } = ctx();
    const types = ctx().eventTypes ?? ctx().event_types;
    eventSource.on(types.CHAT_CHANGED, () => {
        refreshCharWords();
        // 等新聊天渲染完再处理
        setTimeout(remask, 0);
    });
});
