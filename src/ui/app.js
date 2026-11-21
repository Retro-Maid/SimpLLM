'use strict';

// ---------------------------------------------------------------------------
// simpllm: llama-server 用チャットUI
// - 依存ライブラリなし / 外部通信なし (CSP で connect-src 'self' のみ許可)
// - モデル出力は Markdown.render (DOM 組み立て) か textContent でのみ描画する
// - 会話・画像・設定は受付 (history.ps1) を通して history フォルダに保存する。認証用キーのみ sessionStorage。
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'), chatList: $('chat-list'), search: $('search'), menu: $('menu'),
  btnNew: $('btn-new'), btnNewTop: $('btn-new-top'), btnSideOpen: $('btn-side-open'), btnSideClose: $('btn-side-close'), backdrop: $('backdrop'),
  modelSelect: $('model-select'), status: $('status'), ctx: $('ctx'), ctxFill: $('ctx-fill'), ctxText: $('ctx-text'),
  splash: $('splash'), log: $('log'), btnBottom: $('btn-bottom'), attachments: $('attachments'), input: $('input'), hint: $('hint'), tokenCount: $('token-count'),
  btnAttach: $('btn-attach'), fileInput: $('file-input'), btnThink: $('btn-think'), btnTools: $('btn-tools'), send: $('btn-send'), stop: $('btn-stop'),
  drop: $('drop-overlay'),
  settings: $('settings'), btnSettings: $('btn-settings'), btnCloseSettings: $('btn-close-settings'), settingsNav: $('settings-nav'), settingsPanes: $('settings-panes'),
  systemPrompt: $('system-prompt'), enterSend: $('o-enter-send'), advanced: $('o-advanced'), storageNote: $('storage-note'),
  aboutLlama: $('about-llama'), aboutLlamaTested: $('about-llama-tested'), aboutLlamaOld: $('about-llama-old'),
  launchNote: $('launch-note'), launchError: $('launch-error'), btnLaunchApply: $('btn-launch-apply'), btnLaunchReset: $('btn-launch-reset'),
  presets: $('presets'), btnModelSampling: $('btn-model-sampling'),
  promptSelect: $('prompt-select'), promptName: $('prompt-name'), btnPromptApply: $('btn-prompt-apply'), btnPromptDelete: $('btn-prompt-delete'), btnPromptSave: $('btn-prompt-save'),
  btnImport: $('btn-import'), importFile: $('import-file'), btnExportAll: $('btn-export-all'), btnDeleteAll: $('btn-delete-all'),
  projectChip: $('project-chip'), projectName: $('project-name'),
  btnSelect: $('btn-select'), bulk: $('bulk'), bulkCount: $('bulk-count'), bulkActions: $('bulk-actions'), bulkFolderInput: $('bulk-folder-input'),
  btnBulkAll: $('btn-bulk-all'), btnBulkClose: $('btn-bulk-close'), btnBulkPin: $('btn-bulk-pin'), btnBulkFolder: $('btn-bulk-folder'), btnBulkExport: $('btn-bulk-export'), btnBulkDelete: $('btn-bulk-delete'),
  btw: $('btw'), btnBtw: $('btn-btw'), btnBtwClose: $('btn-btw-close'), btwLog: $('btw-log'), btwInput: $('btw-input'), btnBtwSend: $('btn-btw-send'), btnBtwStop: $('btn-btw-stop'),
  project: $('project'), btnNewProject: $('btn-new-project'), btnCloseProject: $('btn-close-project'), projectNameInput: $('project-name-input'), projectSystem: $('project-system'),
  projectFiles: $('project-files'), btnProjectAdd: $('btn-project-add'), projectFileInput: $('project-file-input'), projectNote: $('project-note'), projectError: $('project-error'),
  btnProjectSave: $('btn-project-save'), btnProjectRemove: $('btn-project-remove'),
  modelDir: $('model-dir'), btnModelDirBrowse: $('btn-model-dir-browse'), btnModelDirApply: $('btn-model-dir-apply'), modelDirNote: $('model-dir-note'), modelDirError: $('model-dir-error'),
  btnImage: $('btn-image'), imgbar: $('imgbar'), btnImgGenerate: $('btn-img-generate'), btnImgEdit: $('btn-img-edit'), imgSize: $('img-size'), imgSeed: $('img-seed'),
  btnImgClose: $('btn-img-close'), imgNote: $('img-note'), imageState: $('image-state'), imageModels: $('image-models'),
  imageTranslate: $('o-image-translate'), imageSizeDefault: $('o-image-size'),
  language: $('o-language'), languageNote: $('language-note'),
  imgModel: $('img-model'), imgModelField: $('img-model-field'), modelList: $('model-list'), btnModelRescan: $('btn-model-rescan'),
};

const PARAMS = ['temperature', 'top_p', 'top_k', 'min_p', 'presence_penalty', 'repeat_penalty', 'max_tokens', 'seed'];
const PRESETS = {
  'think':         { thinking: true,  temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 1.5 },
  'think-precise': { thinking: true,  temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0 },
  'fast':          { thinking: false, temperature: 0.7, top_p: 0.8,  top_k: 20, min_p: 0, presence_penalty: 1.5 },
};
const DEFAULT_SETTINGS = {
  model: '', thinking: false, tools: false, enterSend: true, advanced: false, // advanced: ツール・btw・プロジェクト・複数選択を出す
  // 生成パラメータの空欄は自動: Qwen 系のモデルは公式の推奨値 (AUTO_SAMPLING)、ほかのモデルは送らずに llama.cpp の標準に任せる
  temperature: '', top_p: '', top_k: '', min_p: '', presence_penalty: '', repeat_penalty: '', max_tokens: 8192, seed: '',
  system: tx('model.defaultSystem'),
  prompts: [],
  collapsed: [],
  imageTranslate: true, imageSize: 'square', 
  imageModels: {}, // 処理ごとに最後に選んだ画像モデル { generate: id, edit: id }
};
// 空欄のときに Qwen 系で使う値 (「非思考・一般」と同じ)。ほかの系統の値を足すときは、ここに系統ごとの表を作る
const AUTO_SAMPLING = { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5 };
const LIMITS = { textFileBytes: 512 * 1024, pdfBytes: 50 * 1024 * 1024, imageEdge: 1024, imagesPerMessage: 8, importBytes: 200 * 1024 * 1024 };
const PAGE = 30; // 長い会話は直近だけ描画する
const MAX_TOOL_ROUNDS = 6;
const IMAGE_TOKENS = 1300; // 画像1枚あたりのトークン数の見積もり (長辺 1024px)
const BTW_MAX_TOKENS = 2048; // btw は短い質問用なので、回答の長さを抑える
const EAGER_MIN = 4; // 会話を開いたとき、すぐに描画する末尾の最小件数
const EAGER_MARGIN_PX = 800; // 画面の高さにこの余裕を足した分まで、すぐに描画する
const PAINT_MIN_MS = 16; // 生成中の描画間隔の下限 (1フレーム)。描画が軽いうちは毎フレーム更新して、文字をなめらかに出す
const PAINT_MAX_MS = 500;
const CONTINUE_PROMPT = tx('model.continuePrompt');

let chatOrderCache = null;
class ChatMap extends Map {
  set(id, chat) { chatOrderCache = null; return super.set(id, chat); }
  delete(id) {
    chatOrderCache = null;
    if (historyState.enabled && historyState.onDisk.has(id)) { historyState.deleted.add(id); scheduleSave(); }
    return super.delete(id);
  }
  clear() { for (const id of this.keys()) this.delete(id); }
}
const state = {
  chats: new ChatMap(),
  currentId: null,
  controller: null,
  visible: PAGE,
  thread: null,
  apiKey: '',
  server: { model: '', requested: '', nCtx: 0, vision: false, ok: false, loading: true, settling: false, restarting: false },
  controlPort: '',
  pending: { images: [], files: [] },
  views: new WeakMap(), // メッセージ → 表示中の要素 (ショートカットからの編集用)
  sideItems: new Map(), // チャットID → サイドバーの要素
  sideOrder: [], // サイドバーに表示している順のチャットID (Shift での範囲選択用)
  selection: null, // 複数選択中のチャットID (Set)。選択モードでないときは null
  projects: new Map(), // フォルダ名 → プロジェクト
  generation: null, // 生成中は、回答が確定すると解決する Promise
  generatingChat: null, // 生成中の会話
  // 画像モード: mode は null (チャット) / 'generate' / 'edit'。source は編集の元画像 { url, w, h }
  image: { mode: null, source: null, status: null, statusError: '' },
  inventory: null, // 受付が調べたモデルの一覧 (チャット用・画像用)。置いたばかりのモデルを選べるようにする
  serverModels: [], // llama-server が知っているチャット用モデルの id
};

// ---------------------------------------------------------------------------
// アイコン (SVG を DOM で組み立てる)
// ---------------------------------------------------------------------------

const ICONS = {
  sidebar: ['M4 5h16v14H4z', 'M9.5 5v14'],
  compose: ['M12 20h8', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5 4 19.5l1-3.5Z'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'M20 20l-4-4'],
  settings: ['M4 7h9', 'M17 7h3', 'M15 5v4', 'M4 17h3', 'M11 17h9', 'M9 15v4'],
  plus: ['M12 5v14', 'M5 12h14'],
  'arrow-up': ['M12 19V5', 'M6 11l6-6 6 6'],
  'arrow-down': ['M12 5v14', 'M6 13l6 6 6-6'],
  branch: ['M6 4v10', 'M18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', 'M18 8c0 5-6 4-12 8'],
  stop: ['M5 5h14v14H5z'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  edit: ['M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5 4 19.5l1-3.5Z'],
  regen: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4v5h-5'],
  trash: ['M4 7h16', 'M9.5 7V4.5h5V7', 'M6.5 7l1 12.5h9l1-12.5'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  file: ['M14 3H6v18h12V7z', 'M14 3v4h4'],
  chevron: ['M9 6l6 6-6 6'],
  left: ['M15 6l-6 6 6 6'],
  bulb: ['M9 18h6', 'M10 21h4', 'M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3Z'],
  tool: ['M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.5 2.5-2.5-.5-.5-2.5Z'],
  download: ['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M5 20h14'],
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  pin: ['M9 4h6l-1 5 3 3v2H7v-2l3-3Z', 'M12 14v6'],
  folder: ['M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z'],
  select: ['M4 4h16v16H4z', 'M8 12l3 3 5-6'],
  project: ['M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z', 'M12 11v5', 'M9.5 13.5h5'],
  aside: ['M4 5h16v11H9l-5 4Z', 'M9 10.5h6'],
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 9.5h.01'],
};

const iconCache = new Map(); // 種類ごとに一度だけ組み立てて複製する

function icon(name) {
  let svg = iconCache.get(name);
  if (!svg) {
    const NS = 'http://www.w3.org/2000/svg';
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'i');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    iconCache.set(name, svg);
  }
  return svg.cloneNode(true);
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label, onClick, cls) {
  const b = el('button', cls, label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function iconButton(name, title, onClick) {
  const b = button(undefined, onClick, 'icon-btn');
  b.title = title;
  b.setAttribute('aria-label', title);
  b.append(icon(name));
  return b;
}

// ネイティブの confirm() は使わず、2回クリックで実行する
function armed(btn, action, armedLabel) {
  let original = null;
  let timer = 0;
  const disarm = () => {
    clearTimeout(timer);
    if (!btn.classList.contains('armed')) return;
    btn.classList.remove('armed');
    if (armedLabel) btn.textContent = original.text;
    btn.title = original.title;
  };
  const handler = (e) => {
    if (e) e.stopPropagation();
    if (btn.classList.contains('armed')) {
      disarm();
      action();
      return;
    }
    original = { text: btn.textContent, title: btn.title };
    btn.classList.add('armed');
    if (armedLabel) btn.textContent = armedLabel;
    btn.title = tx('common.pressAgain');
    timer = setTimeout(disarm, 3000);
  };
  handler.disarm = disarm;
  return handler;
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    btn.replaceChildren(icon('check'));
    setTimeout(() => btn.replaceChildren(icon('copy')), 1200);
  }).catch(() => { /* 無視 */ });
}

const uid = () => crypto.randomUUID();
const authHeaders = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.apiKey}` });

function debounce(fn, ms) {
  let t = 0;
  const run = (...args) => { clearTimeout(t); t = setTimeout(() => { t = 0; if (!state.ended) fn(...args); }, ms); };
  run.cancel = () => { clearTimeout(t); t = 0; };
  return run;
}

function download(content, type, name) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeFileName = (s) => (s || 'chat').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80);

// --reasoning-format の設定によっては思考が content 内に <think>...</think> として来るので分離する
function splitThink(text) {
  const open = text.indexOf('<think>');
  const close = text.indexOf('</think>');
  if (close !== -1 && (open === -1 || open < close)) {
    const start = open === -1 ? 0 : open + '<think>'.length;
    return { think: text.slice(start, close), answer: text.slice(close + '</think>'.length).replace(/^\s+/, '') };
  }
  if (open !== -1 && text.slice(0, open).trim() === '') {
    return { think: text.slice(open + '<think>'.length), answer: '' };
  }
  return { think: '', answer: text };
}

const fmtSec = (ms) => tx('unit.seconds', { n: Math.max(1, Math.round(ms / 1000)) });

// ---------------------------------------------------------------------------
// 生成中の Markdown 描画を軽くする
// 空行で区切られた「確定済みブロック」は一度だけ描画して残し、末尾の未確定部分だけを描き直す
// 空行の無い長い文章や箇条書きでは、末尾が回答全体になって描くたびに全部を作り直すことになる (20KB の回答で JS だけで 2〜3 秒。実測)。
// そこで、末尾が SOFT_COMMIT_CHARS を超えたら、段落の行の切れ目・箇条書きの項目の切れ目でも確定する:
//   段落 A\nB を <p>A</p><p>B</p> に、箇条書きを 2 つのリストに分けて描き、間の余白を消す (.soft)。行の切れ目は元から改行で出るので、見た目は変わらない。
//   回答が終わると全体を描き直す (fillAssistant) ので、分けた構造は残らない
// 表は分けると列の幅がそろわなくなるので、1 つの表のまま行を足していく: 確定した行は残し、その後ろの行だけを作り直す
// ---------------------------------------------------------------------------

const SOFT_COMMIT_CHARS = 1500; // 確定していない部分がこれを超えたら、行の切れ目でも確定する (描くたびに作り直す量の上限の目安)
const PLAIN_BAD_RE = /[\n\\`$!*_~\[\]|<>]/; // これを含まない 1 行は、Markdown として読まずに文字のまま追記できる
function evenCount(text, mark) {
  let n = 0;
  for (let i = text.indexOf(mark); i !== -1; i = text.indexOf(mark, i + mark.length)) n++;
  return n % 2 === 0;
}

class StreamMarkdown {
  constructor(container, depth = 0) {
    this.depth = depth;
    this.done = el('div');
    this.tail = el('div');
    this.stableLen = 0; // ここまでは done に描画済み
    this.stable = 0; // ここまでは確定 (次の描画で done に移す)
    this.scanPos = 0; // 行の走査を再開する位置
    this.searchPos = 0; // 改行のない長文も、追加された範囲だけを検索する
    this.fence = ''; // 開いているコードフェンスの記号
    this.fenceLang = '';
    this.fenceTop = false; // 行頭から始まるコードブロックの中か
    this.inMath = false;
    this.mathFrom = 0; // 数式が始まった行の次の行の位置 (閉じないまま空行に来たら、ここから調べ直す)
    this.inQuote = false;
    this.live = null; // 開いているコードブロックの追記先
    this.liveLen = 0; // 追記済みの位置
    this.tailText = '';
    this.kind = ''; // 確定していない部分の先頭のブロックの種類: '' まだ行が無い / 'para' 段落 / 'ul'・'ol' 箇条書き / 'other' 行の切れ目では確定しない
    this.soft = 0; // 行の切れ目で確定できる、いちばん後ろの位置
    this.olNext = 0; // 番号付きの箇条書きで、次の項目に付くはずの番号
    this.softKind = ''; // soft を決めたときのブロックの種類
    this.blockStart = 0; // 表かもしれないブロックの先頭
    this.tableHead = ''; // 表の見出しと区切りの 2 行 (行を足すときに、同じ見出しで行を作るため)
    this.liveTable = null; // 行を足している表 { head, body: <tbody>, rows: 確定した行の数 }
    this.tableEnd = 0; // 行を足している表が終わった位置 (0 = まだ続いている)
    this.quoteText = '';
    this.quoteStart = -1;
    this.quoteLive = null;
    this.plainLive = null;
    container.replaceChildren(this.done, this.tail);
  }

  // 空行やコードブロックで確定したら、次のブロックの種類は決め直す
  settle(pos) {
    if (this.kind === 'table' && this.liveTable && !this.tableEnd) this.tableEnd = pos;
    this.stable = pos;
    this.kind = '';
  }

  // 段落・箇条書き・表の途中で、別の種類のブロックが始まった: その先は空行まで行の切れ目では確定しない
  interrupt(pos) {
    if (this.kind === 'table' && this.liveTable && !this.tableEnd) this.tableEnd = pos;
    this.kind = 'other';
  }

  // 表の行を、出してある表に足す。確定した行は残し、その後ろを作り直す (commit: 足した行を確定する)
  fillTable(rowsText, commit) {
    const t = this.liveTable;
    while (t.body.childNodes.length > t.rows) t.body.lastChild.remove();
    let after = null; // 表の後ろに続くもの (書きかけで、まだ | の無い行など)
    if (rowsText) {
      const part = Markdown.render(t.head + rowsText); // 見出しを付けて表として描き、行だけをもらう
      const wrap = part.firstChild;
      const body = wrap && wrap.firstChild && wrap.firstChild.childNodes[1];
      if (body) {
        while (body.firstChild) t.body.append(body.firstChild);
        wrap.remove();
        after = part;
      }
    }
    if (after) this.tail.replaceChildren(after); else this.tail.replaceChildren();
    if (commit) t.rows = t.body.childNodes.length;
  }

  // 確定していない部分の行を 1 行ずつ見て、行の切れ目で確定できる位置 (soft) を進める
  classify(line, start, text) {
    const k = Markdown.lineKind(line);
    if (this.kind === '') {
      if (k === 'pipe') { this.kind = 'table?'; this.blockStart = start; } // 次の行が区切りなら表
      else this.kind = k === 'plain' ? 'para' : k;
      if (k === 'ol') this.olNext = parseInt(line, 10) + 1;
    } else if (this.kind === 'table?') {
      if (Markdown.isTableSep(line)) {
        this.kind = 'table';
        this.tableHead = text.slice(this.blockStart, this.scanPos);
        if (this.blockStart > this.stable) this.stable = this.blockStart; // 段落のすぐ後ろの表: 表が段落を終わらせるので、手前までを確定できる
      } else this.kind = 'other';
    } else if (this.kind === 'table') {
      if (line.includes('|')) { this.soft = start; this.softKind = 'table'; } else this.interrupt(start); // | の無い行で表は終わる
    } else if (this.kind === 'para') {
      if (k === 'plain') { this.soft = start; this.softKind = 'para'; }
      else if (k === 'pipe') { this.kind = 'table?'; this.blockStart = start; } // 空行を挟まない表かもしれない (次の行が区切りなら表)
      else this.kind = 'other'; // 見出しや箇条書きが続いたら、その先は空行まで待つ
    } else if (this.kind === 'ul' || this.kind === 'ol') {
      if (k === this.kind) {
        // 番号付きは、分けた後ろのリストがその番号から始まるので、番号が続いているときだけ切れ目にする (全部「1.」の書き方では分けない)
        if (k === 'ul' || parseInt(line, 10) === this.olNext) { this.soft = start; this.softKind = k; }
        if (k === 'ol') this.olNext++;
      } else if (k === 'ul' || k === 'ol' || ((k === 'other' || k === 'pipe') && !/^\s/.test(line) && Markdown.lineKind(line.replace(/\|/g, ' ')) === 'other')) this.kind = 'other'; // 別の種類のブロックが始まった
      // 字下げした行と、段落の続きの行は、項目の中身
    }
  }

  // 増えた行だけを調べる (パーサーと同じ規則でコードフェンスの開閉を判定する)
  scan(text) {
    let nl;
    while ((nl = text.indexOf('\n', this.searchPos)) !== -1) {
      const line = text.slice(this.scanPos, nl);
      const start = this.scanPos;
      this.scanPos = nl + 1;
      this.searchPos = this.scanPos;
      if (this.fence) {
        if (line.trim().startsWith(this.fence)) {
          if (this.fenceTop) this.settle(this.scanPos);
          this.fence = '';
          this.fenceTop = false;
        }
        continue;
      }
      if (this.inQuote) { // 引用は空行まで続く (途中のフェンスも引用の一部になる)
        if (line.trim() === '') {
          this.inQuote = false;
          this.settle(this.scanPos);
          this.quoteStart = -1;
        } else if (this.quoteStart >= 0) {
          this.quoteText += (line.match(Markdown.QUOTE_RE)?.[1] ?? line) + '\n';
        }
        continue;
      }
      if (!this.inMath) {
        if (Markdown.QUOTE_RE.test(line)) {
          // A top-level quote keeps one outer block; its body uses the same incremental renderer.
          if (line.startsWith('>') && (this.kind === '' || this.kind === 'para')) {
            this.settle(start);
            this.quoteStart = start;
            this.quoteText = line.match(Markdown.QUOTE_RE)[1] + '\n';
          }
          this.inQuote = true;
          this.interrupt(start);
          continue;
        }
        const m = Markdown.matchFence(line);
        if (m) {
          this.fence = m[1];
          this.fenceLang = m[2];
          this.fenceTop = !/^\s/.test(line);
          if (this.kind === 'para' || this.kind === 'table' || this.kind === 'table?') this.interrupt(start); // 字下げしたコードブロックは段落や表を終わらせる (箇条書きの項目の中なら、項目の中身)
          if (this.fenceTop) { // 行頭のフェンスはリストや段落を必ず終わらせるので、手前までを確定できる
            this.settle(start);
            this.liveLen = this.scanPos;
          }
          continue;
        }
      }
      if ((line.match(/\$\$/g) || []).length % 2 === 1) {
        this.inMath = !this.inMath;
        if (this.inMath) this.mathFrom = this.scanPos;
        this.interrupt(start);
      } else if (this.inMath) {
        // 数式のブロックは空行をまたがない (Markdown.render と同じ)。閉じないまま空行に来たら数式ではなかったので、
        // 数式の中として読み飛ばした行を調べ直す (その中で始まったコードブロックや引用を見落とさないように)
        if (line.trim() === '') { this.inMath = false; this.scanPos = this.searchPos = this.mathFrom; }
      } else if (line.trim() === '') this.settle(this.scanPos);
      else this.classify(line, start, text);
    }
    this.searchPos = text.length;
  }

  update(text) {
    this.scan(text);
    if (this.liveTable && this.tableEnd) { // 行を足していた表が終わった: 残りの行を足して閉じる
      this.fillTable(text.slice(this.stableLen, this.tableEnd), true);
      this.stableLen = this.tableEnd;
      this.liveTable = null;
      this.tailText = '';
      this.plainLive = null; // 末尾を描き直したので、追記先はもう無い
      this.quoteLive = null;
    }
    this.tableEnd = 0;
    if (this.stable > this.stableLen) {
      this.done.append(Markdown.render(text.slice(this.stableLen, this.stable)));
      this.stableLen = this.stable;
      this.live = null;
      this.tailText = '';
      this.tail.replaceChildren();
      this.quoteLive = null;
      this.plainLive = null;
    }
    if (this.soft > this.stableLen && text.length - this.stableLen > SOFT_COMMIT_CHARS && !this.fence && !this.inMath && !this.inQuote) {
      const chunk = text.slice(this.stableLen, this.soft);
      if (this.softKind === 'table') {
        if (this.liveTable) { // 2 回目以降: 確定した行を表に足す
          this.fillTable(chunk, true);
          this.stableLen = this.soft;
          this.tailText = '';
          this.plainLive = null;
          this.quoteLive = null;
        } else if (this.kind === 'table' && chunk.startsWith(this.tableHead)) { // 最初: ここまでを表として描き、その表に行を足していく
          const part = Markdown.render(chunk);
          const wrap = part.firstChild;
          const body = wrap && wrap.firstChild && wrap.firstChild.childNodes[1];
          if (body) {
            this.done.append(part);
            this.liveTable = { head: this.tableHead, body, rows: body.childNodes.length };
            this.stableLen = this.soft;
            this.tailText = '';
            this.tail.replaceChildren();
            this.plainLive = null;
            this.quoteLive = null;
          }
        }
      // 行をまたぐ強調・コード・数式の途中では切らない (閉じ記号が後ろのブロックに分かれて、記号がそのまま出てしまう)
      } else if (evenCount(chunk, '`') && evenCount(chunk, '**') && evenCount(chunk, '$') && evenCount(chunk, '~~')) {
        const part = Markdown.render(chunk);
        const last = part.lastElementChild;
        if (last) last.classList.add('soft'); // 続きとの間に余白を空けない
        this.done.append(part);
        this.stableLen = this.soft;
        this.tailText = '';
        this.tail.replaceChildren();
        this.plainLive = null; // 確定した位置からの長さで覚えているので、位置が進んだら使えない
        this.quoteLive = null;
      }
    }
    if (this.fenceTop) {
      if (!this.live) {
        this.live = Markdown.liveCode(this.fenceLang);
        this.tail.replaceChildren(this.live.wrap);
      }
      // 閉じるフェンスになりそうな書きかけの行は、確定するまで出さない
      const lineStart = text.lastIndexOf('\n') + 1;
      const end = /^\s*[`~]*$/.test(text.slice(lineStart)) ? lineStart : text.length;
      if (end > this.liveLen) {
        this.live.append(text.slice(this.liveLen, end));
        this.liveLen = end;
      }
      return;
    }
    const partialQuote = !this.inQuote && !this.fence && !this.inMath && this.scanPos === this.stableLen && text[this.scanPos] === '>';
    if (this.depth < 8 && ((this.inQuote && this.quoteStart === this.stableLen) || partialQuote)) {
      if (!this.quoteLive) {
        const wrap = el('blockquote');
        this.tail.replaceChildren(wrap);
        this.quoteLive = new StreamMarkdown(wrap, this.depth + 1);
      }
      const partial = text.slice(this.scanPos);
      this.quoteLive.update((partialQuote ? '' : this.quoteText) + (partial.match(Markdown.QUOTE_RE)?.[1] ?? partial));
      return;
    }
    const rest = text.slice(this.stableLen);
    if (rest === this.tailText) return;
    this.tailText = rest;
    if (this.liveTable) { this.fillTable(rest, false); return; } // 表の途中: 確定していない行だけを作り直す
    // Plain single lines have no commit boundary. Append text chunks instead of reparsing their prefix.
    if (this.plainLive && !PLAIN_BAD_RE.test(rest.slice(this.plainLive.length))) {
      this.plainLive.chunks.append(rest.slice(this.plainLive.length));
      this.plainLive.length = rest.length;
      return;
    }
    if (rest.length > SOFT_COMMIT_CHARS && !PLAIN_BAD_RE.test(rest) &&!/^\s*(?:#{1,6}\s|[-+]|\d+[.)]\s)/.test(rest)) {
      const p = el('p');
      const node = document.createTextNode(rest);
      p.append(node);
      const chunks = { append: (s) => node.appendData(s) };
      this.tail.replaceChildren(p);
      this.plainLive = { chunks, length: rest.length };
      return;
    }
    this.plainLive = null;
    this.tail.replaceChildren(Markdown.render(rest, { highlight: false }));
  }
}

// ---------------------------------------------------------------------------
// 設定は history/meta.json に保存する (loadHistory / flushHistory)。APIキーだけsessionStorageを使う。
// ---------------------------------------------------------------------------

// settings.x = ... と代入すると、保存が必要になったことを記録する (配列の中身の変更は markMetaDirty を呼ぶ)
const settingsChange = { dirty: false };
const settings = new Proxy({ ...DEFAULT_SETTINGS, prompts: [], collapsed: [] }, {
  set(target, key, value) {
    if (target[key] !== value) { target[key] = value; settingsChange.dirty = true; scheduleSave(); }
    return true;
  },
});
function loadApiKey() {
  try {
    state.apiKey = sessionStorage.getItem('simpllm.apiKey') || '';
    state.controlPort = sessionStorage.getItem('simpllm.controlPort') || ''; // 再読み込みの後も使う
  } catch { /* 無効でも続行 */ }
  takeKeyFromUrl();
}

// start.ps1 が開く URL の #key=... を受け取る。フラグメントはサーバーに送られない。URL からはすぐ消す
function takeKeyFromUrl() {
  const fromUrl = location.hash.match(/^#key=([0-9a-f]{64})(?:&control=(\d{1,5}))?(?:&lang=[A-Za-z0-9-]{2,20})?$/); // lang は i18n.js が先に読んでいる
  if (!fromUrl) return false;
  state.apiKey = fromUrl[1];
  state.controlPort = fromUrl[2] || '';
  try {
    sessionStorage.setItem('simpllm.apiKey', fromUrl[1]);
    sessionStorage.setItem('simpllm.controlPort', state.controlPort);
  } catch { /* 無効でも続行 */ }
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

function settingsToForm() {
  for (const p of PARAMS) $('p-' + p).value = settings[p] === '' ? '' : String(settings[p]);
  els.enterSend.checked = settings.enterSend;
  els.advanced.checked = settings.advanced;
  applyAdvanced();
  els.btnThink.classList.toggle('on', settings.thinking);
  els.btnTools.classList.toggle('on', settings.tools);
  els.imageTranslate.checked = settings.imageTranslate !== false;
  if (!IMAGE_SIZES[settings.imageSize]) settings.imageSize = 'square';
  els.imageSizeDefault.value = settings.imageSize;
  els.imgSize.value = settings.imageSize;
  renderPromptLib();
  updateStorageNote();
  updateHint();
}

function formToSettings() {
  for (const p of PARAMS) {
    const v = $('p-' + p).value.trim();
    if (p === 'seed') { settings.seed = v; continue; }
    const n = Number(v);
    if (v === '') settings[p] = ''; // 空欄は自動
    else if (Number.isFinite(n)) settings[p] = n;
  }
  settings.enterSend = els.enterSend.checked;
  settings.advanced = els.advanced.checked;
  applyAdvanced();
  settings.imageTranslate = els.imageTranslate.checked;
  if (IMAGE_SIZES[els.imageSizeDefault.value]) settings.imageSize = els.imageSizeDefault.value;
  els.imgSize.value = settings.imageSize;

  updateStorageNote();
  updateHint();
}

// 今のチャット用モデルの、受付が調べた情報 (系統・推奨値)。まだ分からなければ null
function currentChatModel() {
  const id = state.server.model;
  return (id && state.inventory && state.inventory.chat.find((x) => x.id === id)) || null;
}

const isQwenModel = (c) => !!(c && /^qwen/i.test(c.arch || ''));

// 数値として正しい値だけ送る (空欄や NaN を送ると 400 になる)。空欄は自動: Qwen 系だけ推奨値を送る
function samplingParams() {
  const out = {};
  const auto = isQwenModel(currentChatModel()) ? AUTO_SAMPLING : {};
  for (const p of PARAMS) {
    let v = String(settings[p]).trim();
    if (v === '' && auto[p] !== undefined) v = String(auto[p]);
    if (v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || (p === 'seed' && n < 0)) continue;
    out[p] = (p === 'top_k' || p === 'max_tokens' || p === 'seed') ? Math.round(n) : n;
  }
  return out;
}

function updateStorageNote() {
  const e = historyState.error;
  els.storageNote.textContent = e === 'off'
    ? tx('storage.off')
    : e ? e
      : tx('storage.on');
}

function updateHint() {
  // 画像を添付できるかどうかは、添付しようとしたときに知らせる (addImage)。いつも出すと初めての人には雑音になる
  const text = (settings.enterSend ? tx('hint.enterSend') : tx('hint.ctrlEnterSend'))
    + (historyState.enabled ? '' : tx('hint.noHistory'));
  if (els.hint.textContent !== text) els.hint.textContent = text; // サイドバー描画のたびに書き換えない
}

// ---- システムプロンプト集 -------------------------------------------------

function renderPromptLib() {
  const opts = [el('option', '', settings.prompts.length ? tx('prompts.select') : tx('prompts.none'))];
  opts[0].value = '';
  settings.prompts.forEach((p, k) => {
    const o = el('option', '', p.name);
    o.value = String(k);
    opts.push(o);
  });
  els.promptSelect.replaceChildren(...opts);
}

function selectedPrompt() {
  const k = els.promptSelect.value;
  return k === '' ? null : settings.prompts[Number(k)];
}

// ---------------------------------------------------------------------------
// チャットの管理
// ---------------------------------------------------------------------------

// 生成・画像処理の最中か。state.controller は準備 (トークン数の計算・画像の読み込み) の後に立つので、
// 準備中から立つ state.generation も見る (準備中に別の生成や画像処理を始めないように)
const isBusy = () => !!state.controller || !!state.generation;

const current = () => state.chats.get(state.currentId);

// folder: プロジェクト (フォルダ) の中に作るとき
const chatCount = (c) => c.lazy ? c.messageCount : c.messages.length;
function newChat(folder = '') {
  let existing;
  for (const chat of state.chats.values()) if (chatCount(chat) === 0) { existing = chat; break; }
  const chat = existing || { id: uid(), title: '', createdAt: Date.now(), updatedAt: Date.now(), system: settings.system, messages: [], lastUsage: 0, pinned: false, folder: '' };
  // 空のまま残っていたチャットを使い回すときも、いま作ったものとして扱う (作った後に変えたシステムプロンプトを引き継ぐ)
  if (existing) { chat.system = settings.system; chat.createdAt = chat.updatedAt = Date.now(); }
  chat.folder = folder;
  state.chats.set(chat.id, chat);
  openChat(chat.id);
  els.input.focus();
}

let chatOpenTurn = 0;
let chatOpenId = null; // 最後に開こうとした会話
function openChat(id) {
  const turn = ++chatOpenTurn;
  chatOpenId = id;
  const wanted = state.chats.get(id);
  if (!wanted) return;
  if (wanted.lazy) {
    return loadChat(wanted).then(() => {
      if (turn === chatOpenTurn && !state.ended && !isBusy() && state.chats.get(id) === wanted) openChat(id);
      else if (chatOpenId !== id) unloadChat(wanted); // 読み込む間に別の会話を開いた: 開かなかった本文は、持ち続けない
    }).catch((e) => showError(tx('history.loadFailed') + e.message));
  }
  if (id === state.currentId && state.thread) {
    if (isNarrow()) els.app.classList.add('side-closed');
    return; // 同じ会話をクリックしても再描画・添付破棄・スクロール移動はしない
  }
  if (id !== state.currentId) resetBtw(); // 開いている会話をもう一度押しただけなら消さない
  const previous = state.chats.get(state.currentId);
  // 離れた会話の画像は、保存が済むのを待ってから手放す (すぐ戻ってきたときは、開いている会話なので何もしない)
  if (previous && previous.id !== id) setTimeout(() => {
    historyState.unload.add(previous);
    releaseChatImages(previous);
    unloadChat(previous);
  }, 3000);
  state.currentId = id;
  state.visible = PAGE;
  clearPending();
  if (!markActive()) renderSidebar();
  renderLog();
  const chat = current();
  els.systemPrompt.value = chat.system;
  renderCtx(chat.lastUsage || 0);
  renderChatBadges();
  if (isNarrow()) els.app.classList.add('side-closed');
}

function touchChat(chat) {
  chat.updatedAt = Date.now();
  markDirty(chat);
}

function deleteChat(id) {
  if (isBusy()) return; // 生成中の会話を削除しない
  state.chats.delete(id);
  if (state.currentId === id) newChat();
  renderSidebar();
}

const sortedChats = () => chatOrderCache || (chatOrderCache = [...state.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt));

function autoTitle(chat) {
  if (chat.title) return; // 題が空のチャットだけ、最初の発言から題を付ける
  const first = chat.messages.find((m) => m.role === 'user' || m.role === 'image');
  if (!first) return;
  const t = (first.content || first.files.map((f) => f.name).join(', ') || tx('chat.imageTitle')).replace(/\s+/g, ' ').trim();
  chat.title = t.length > 40 ? t.slice(0, 40) + '…' : t;
}

const isNarrow = () => window.matchMedia('(max-width: 760px)').matches;

// ---------------------------------------------------------------------------
// ポップアップメニュー
// ---------------------------------------------------------------------------

let menuAnchor = null; // 開いているメニューの元になったボタン
function closeMenu() {
  if (els.menu.hidden && !menuAnchor) return; // 一覧のスクロールやウィンドウの大きさの変更のたびに呼ばれる。開いていなければ何もしない
  menuAnchor = null;
  els.menu.hidden = true;
  els.menu.replaceChildren();
}

function openMenu(anchor, items) {
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const b = button(undefined, null, 'menu-item' + (it.danger ? ' danger' : ''));
    b.append(icon(it.icon), el('span', '', it.label));
    if (it.confirm) {
      const label = b.lastChild;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (b.classList.contains('armed')) { closeMenu(); it.action(); return; }
        b.classList.add('armed');
        label.textContent = it.confirm;
      });
    } else {
      b.addEventListener('click', () => { closeMenu(); it.action(); });
    }
    frag.append(b);
  }
  els.menu.replaceChildren(frag);
  els.menu.hidden = false;
  menuAnchor = anchor;
  const r = anchor.getBoundingClientRect();
  const mh = els.menu.offsetHeight;
  const mw = els.menu.offsetWidth;
  const top = r.bottom + 4 + mh > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4;
  els.menu.style.top = top + 'px';
  els.menu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.left)) + 'px';
}

// ---------------------------------------------------------------------------
// 描画: サイドバー (ピン留め → フォルダ → 日付)
// ---------------------------------------------------------------------------

function dateGroup(t, today) {
  const day = 86400000;
  const diff = today - t;
  if (diff <= 0) return tx('date.today');
  if (diff <= day) return tx('date.yesterday');
  if (diff <= 7 * day) return tx('date.last7');
  if (diff <= 30 * day) return tx('date.last30');
  return tx('date.older');
}

const sidebarRows = new Map();
const sidebarSearch = { query: '', ids: new Set(), controller: null, timer: 0 };
// 本文をまだ読み込んでいない会話があるか (あれば、本文の検索は受付に頼む)
function hasLazyChat() {
  for (const c of state.chats.values()) if (c.lazy) return true;
  return false;
}
function chatItem(chat) {
  const signature = JSON.stringify([chat.title, !!chat.pinned, !!state.selection, !!state.selection?.has(chat.id)]);
  const cached = sidebarRows.get(chat.id);
  if (cached && cached.chat === chat && cached.signature === signature) {
    state.sideItems.set(chat.id, cached.item);
    state.sideOrder.push(chat.id);
    cached.item.classList.toggle('active', chat.id === state.currentId);
    return cached.item;
  }
  const item = el('div', 'chat-item' + (chat.id === state.currentId ? ' active' : ''));
  item.dataset.chatId = chat.id;
  sidebarRows.set(chat.id, { chat, signature, item });
  state.sideItems.set(chat.id, item);
  state.sideOrder.push(chat.id);
  const open = button(undefined, () => { if (!state.selection && !isBusy()) openChat(chat.id); }, 'open');
  if (chat.pinned) open.append(icon('pin'));
  open.append(el('span', '', chat.title));
  open.title = chat.title;
  if (state.selection) {
    const on = state.selection.has(chat.id);
    const box = el('input', 'sel');
    box.type = 'checkbox';
    box.tabIndex = -1;
    box.checked = on;
    item.classList.toggle('selected', on);
    item.addEventListener('click', (e) => toggleSelect(chat.id, e));
    item.append(box, open);
    return item;
  }
  const more = iconButton('more', tx('common.menu'));
  more.classList.add('more-btn');
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(more, [
      { icon: 'pin', label: chat.pinned ? tx('chat.unpin') : tx('chat.pin'), action: () => { chat.pinned = !chat.pinned; markDirty(chat, true); renderSidebar(); } },
      { icon: 'folder', label: tx('chat.moveToFolder'), action: () => startInlineEdit(item, chat.folder || '', tx('chat.folderPlaceholder'), (v) => { chat.folder = v.slice(0, 60); markDirty(chat, true); }, true) },
      { icon: 'edit', label: tx('chat.rename'), action: () => startInlineEdit(item, chat.title, tx('chat.namePlaceholder'), (v) => { if (v) { chat.title = v.slice(0, 200); markDirty(chat, true); } }) },
      { icon: 'download', label: tx('chat.exportMarkdown'), action: async () => {
        const wasLazy = chat.lazy;
        try { await loadChat(chat); download(chatToMarkdown(chat), 'text/markdown', `${safeFileName(chat.title)}.md`); }
        catch (e) { showError(tx('history.loadFailed') + e.message); }
        finally { if (wasLazy) unloadChat(chat); } // 書き出すためだけに読み込んだ本文は、持ち続けない
      } },
      { icon: 'download', label: tx('chat.exportJson'), action: () => exportChats([chat], `${safeFileName(chat.title)}.json`) },
      { icon: 'trash', label: tx('common.delete'), danger: true, confirm: tx('common.pressAgainDelete'), action: () => deleteChat(chat.id) },
    ]);
  });
  item.append(open, more);
  return item;
}

function groupHeader(label, key, iconName) {
  const collapsed = key && settings.collapsed.includes(key);
  const h = el('h4', key ? 'foldable' : '');
  if (iconName) h.append(icon(iconName));
  h.append(el('span', '', label));
  if (key) {
    h.classList.toggle('collapsed', collapsed);
    h.addEventListener('click', () => {
      settings.collapsed = collapsed ? settings.collapsed.filter((x) => x !== key) : settings.collapsed.concat(key);

      renderSidebar();
    });
  }
  return { h, collapsed };
}

// 開いているチャットの強調だけを移す。一覧に無くて作り直しが必要なら false
function markActive() {
  const item = state.sideItems.get(state.currentId);
  if (!item && chatCount(current())) return false;
  for (const old of els.chatList.querySelectorAll('.chat-item.active')) old.classList.remove('active');
  if (item) item.classList.add('active');
  return true;
}

function renderSidebar() {
  for (const id of sidebarRows.keys()) if (!state.chats.has(id)) sidebarRows.delete(id);
  const q = els.search.value.trim();
  // 大文字小文字を無視した検索。全文を小文字に変換して複製しなくて済むよう正規表現で調べる
  const re = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  if (q && sidebarSearch.query !== q && hasLazyChat()) {
    sidebarSearch.query = q; sidebarSearch.ids = new Set();
    sidebarSearch.controller?.abort();
    clearTimeout(sidebarSearch.timer);
    const controller = new AbortController(); sidebarSearch.controller = controller;
    // 本文の検索は、受付が保存してある全会話のファイルを読む。入力が落ち着いてから頼む (題の一致は、待たずに下で出る)
    sidebarSearch.timer = setTimeout(() => {
      if (controller.signal.aborted || state.ended) return;
      controlRequest('GET', '/history/search?q=' + encodeURIComponent(q), undefined, controller.signal).then((data) => {
        if (sidebarSearch.controller !== controller || state.ended) return;
        sidebarSearch.ids = new Set(Array.isArray(data.ids) ? data.ids : []); renderSidebar();
      }).catch((e) => { if (!controller.signal.aborted) { sidebarSearch.query = ''; showError(tx('history.loadFailed') + e.message); } });
    }, 250);
  }
  const visible = sortedChats().filter((c) => chatCount(c) > 0
    && (!re || re.test(c.title) || (c.lazy ? sidebarSearch.ids.has(c.id) : c.messages.some((m) => re.test(m.content)))));
  const nodes = [];
  const frag = { append: (...items) => nodes.push(...items) };
  const today = new Date().setHours(0, 0, 0, 0);
  state.sideItems.clear();
  state.sideOrder = [];

  const pinned = [], dated = [], byFolder = new Map();
  for (const c of visible) {
    if (c.pinned) pinned.push(c);
    else if (!c.folder) dated.push(c);
    else {
      if (!byFolder.has(c.folder)) byFolder.set(c.folder, []);
      byFolder.get(c.folder).push(c);
    }
  }
  if (pinned.length) {
    frag.append(groupHeader(tx('sidebar.pinned')).h);
    for (const c of pinned) frag.append(chatItem(c));
  }
  // プロジェクトはチャットがなくても一覧に残す
  if (!q) for (const name of state.projects.keys()) if (!byFolder.has(name)) byFolder.set(name, []);
  const folders = [...byFolder.keys()].sort((a, b) => a.localeCompare(b, I18n.locale));
  for (const f of folders) {
    const { h, collapsed } = groupHeader(f, 'folder:' + f, state.projects.has(f) ? 'project' : 'folder');
    if (!state.selection) h.append(folderButtons(f));
    frag.append(h);
    if (!collapsed || q) for (const c of byFolder.get(f)) frag.append(chatItem(c));
  }
  let group = '';
  for (const c of dated) {
    const g = dateGroup(c.updatedAt, today);
    if (g !== group) { frag.append(groupHeader(g).h); group = g; }
    frag.append(chatItem(c));
  }
  const desired = new Set(nodes);
  for (const child of [...els.chatList.children]) if (!desired.has(child)) child.remove();
  for (let i = 0; i < nodes.length; i++) {
    if (els.chatList.children[i] !== nodes[i]) els.chatList.insertBefore(nodes[i], els.chatList.children[i] || null);
  }
  while (els.chatList.children.length > nodes.length) els.chatList.lastElementChild.remove();
  if (state.selection) { // 検索や折りたたみで見えなくなったものは、知らずに操作しないよう選択から外す
    for (const id of [...state.selection]) if (!state.sideItems.has(id)) state.selection.delete(id);
    updateBulk();
  }
  renderChatBadges();
}

function folderButtons(name) {
  const box = el('span', 'folder-btns');
  const add = iconButton('plus', tx('folder.newChat'), (e) => {
    e.stopPropagation();
    if (!isBusy()) newChat(name);
  });
  const edit = iconButton('settings', tx('folder.projectSettings'), (e) => {
    e.stopPropagation();
    openProject(name);
  });
  box.append(add, edit);
  return box;
}

function renderFolderList() {
  let list = $('folder-list');
  if (!list) {
    list = el('datalist');
    list.id = 'folder-list';
    document.body.append(list);
  }
  const names = [...new Set([...state.chats.values()].map((c) => c.folder).filter(Boolean).concat(...state.projects.keys()))];
  list.replaceChildren(...names.map((n) => { const o = el('option'); o.value = n; return o; }));
}

function startInlineEdit(item, value, placeholder, commit, folderList) {
  sidebarRows.delete(item.dataset.chatId); // 完了・取消時には入力欄を通常の行へ戻す
  const input = el('input');
  input.value = value;
  input.placeholder = placeholder;
  if (folderList) {
    renderFolderList();
    input.setAttribute('list', 'folder-list');
  }
  item.replaceChildren(input);
  input.focus();
  input.select();
  let finished = false;
  const done = (ok) => {
    if (finished) return;
    finished = true;
    if (ok) commit(input.value.trim());
    renderSidebar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') { e.stopPropagation(); done(false); } // 取り消すのは名前の入力だけ (全体のショートカットに渡すと、生成まで止まる)
  });
  input.addEventListener('blur', () => done(true));
}

// ---------------------------------------------------------------------------
// 描画: メッセージ
// ---------------------------------------------------------------------------

// 画面外のメッセージの Markdown は後回しにする。スクロールで近づくか、ブラウザの手が空いたときに組み立てる
// (全部そろえばページ内検索でも見つかる。組み立てた後も .cv により画面外のレイアウトと描画は省かれる)
const lazyRenders = new WeakMap();
let lazyQueue = [];
let lazyIdle = 0;

function runLazy(wrap) {
  const render = lazyRenders.get(wrap);
  if (!render) return;
  lazyRenders.delete(wrap);
  lazyObserver.unobserve(wrap);
  render();
}

const lazyObserver = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) runLazy(e.target);
}, { root: els.log, rootMargin: `${EAGER_MARGIN_PX}px 0px` });

function drainLazy(deadline) {
  lazyIdle = 0;
  // 1回に1件まで。アイドル時間を使い切らず、入力やスクロールへ戻す。
  while (lazyQueue.length && deadline.timeRemaining() > 4) {
    const wrap = lazyQueue.pop();
    if (lazyRenders.has(wrap)) { runLazy(wrap); break; }
  }
  scheduleLazy();
}

function scheduleLazy() {
  if (lazyQueue.length && !lazyIdle && !document.hidden && !state.controller) lazyIdle = requestIdleCallback(drainLazy);
}

const estimateHeight = (m) => (m.role === 'image' ? 640 : Math.round(60 + Math.min(m.content.length, 20000) * 0.6));

// 古いメッセージ: 描画前の高さは文字数から見積もる。一度描画すれば実際の高さをブラウザが覚える
function lazyMessage(chat, m) {
  const view = messageView(chat, m, true);
  view.wrap.classList.add('cv');
  view.wrap.style.containIntrinsicBlockSize = `auto ${estimateHeight(m)}px`;
  if (m.role === 'assistant') {
    lazyRenders.set(view.wrap, () => { view.body.replaceChildren(renderAnswer(view, m)); });
    lazyObserver.observe(view.wrap);
    lazyQueue.push(view.wrap);
  }
  return view.wrap;
}

// 画面に収まりそうな末尾の分は、開いた瞬間に空白が見えないようすぐに描画する
function eagerStart(chat, start) {
  const limit = els.log.clientHeight + EAGER_MARGIN_PX;
  const minStart = chat.messages.length - EAGER_MIN;
  let i = chat.messages.length;
  let height = 0;
  while (i > start && (i > minStart || height < limit)) height += estimateHeight(chat.messages[--i]);
  return i;
}

function moreButton(chat, start) {
  const more = button(tx('log.showEarlier', { count: start }), () => {
    const next = more.nextElementSibling; // 表示位置を保つ目印
    const before = next.getBoundingClientRect().top;
    state.visible += PAGE;
    const newStart = Math.max(0, chat.messages.length - state.visible);
    const frag = document.createDocumentFragment();
    if (newStart > 0) frag.append(moreButton(chat, newStart));
    for (let i = newStart; i < start; i++) frag.append(lazyMessage(chat, chat.messages[i]));
    more.replaceWith(frag);
    els.log.scrollTop += next.getBoundingClientRect().top - before;
    scheduleLazy();
    hydrateVisibleImages(chat);
  }, 'more');
  return more;
}

function renderLog() {
  const chat = current();
  state.views = new WeakMap(); // 切り替え前の会話のDOMをメッセージから保持し続けない
  lazyObserver.disconnect();
  lazyQueue = [];
  cancelIdleCallback(lazyIdle);
  lazyIdle = 0;
  els.log.replaceChildren();
  state.thread = null;
  if (chat.messages.length === 0) {
    els.log.append($('welcome-template').content.cloneNode(true));
    return;
  }
  const thread = el('div', 'thread');
  const start = Math.max(0, chat.messages.length - state.visible);
  const eager = eagerStart(chat, start);
  if (start > 0) thread.append(moreButton(chat, start));
  for (let i = start; i < eager; i++) thread.append(lazyMessage(chat, chat.messages[i]));
  for (let i = eager; i < chat.messages.length; i++) thread.append(messageView(chat, chat.messages[i]).wrap);
  els.log.append(thread);
  state.thread = thread;
  markLast();
  els.log.scrollTop = els.log.scrollHeight;
  updateBottomButton();
  scheduleLazy();
  hydrateVisibleImages(chat);
}

function ensureThread() {
  if (!state.thread) {
    els.log.replaceChildren();
    state.thread = el('div', 'thread');
    els.log.append(state.thread);
  }
  return state.thread;
}

function markLast() {
  if (!state.thread) return;
  for (const m of state.thread.children) m.classList.remove('last'); // .msg は thread の直下だけ
  const last = state.thread.lastElementChild;
  if (last && last.classList.contains('msg')) last.classList.add('last');
}

function deleteMessage(chat, m) {
  if (isBusy()) return;
  const idx = chat.messages.indexOf(m);
  if (idx === -1) return;
  chat.messages.splice(idx, 1);
  touchChat(chat);
  renderLog();
  renderSidebar();
}

function messageView(chat, m, lazy) {
  if (m.role === 'image') return imageView(chat, m);
  return m.role === 'user' ? userView(chat, m) : assistantView(chat, m, lazy);
}

function userView(chat, m) {
  const wrap = el('div', 'msg user');
  if (m.images.length || m.files.length) {
    const atts = el('div', 'atts');
    for (const src of m.images) {
      const img = el('img');
      img.decoding = 'async';
      img.loading = 'lazy';
      setImageSrc(img, src);
      img.alt = tx('msg.attachedImage');
      atts.append(img);
    }
    for (const f of m.files) atts.append(fileChip(f));
    wrap.append(atts);
  }
  const bubble = el('div', 'bubble', m.content);
  if (!m.content) bubble.hidden = true;
  const actions = el('div', 'actions');
  const copy = iconButton('copy', tx('common.copy'), () => copyText(m.content, copy));
  const nav = variantNav(chat, m);
  if (nav) actions.append(nav);
  actions.append(
    copy,
    iconButton('edit', tx('common.edit'), () => startEdit(chat, m, wrap, bubble)),
    messageMenuButton(chat, m),
  );
  wrap.append(bubble, actions);
  state.views.set(m, { wrap, bubble });
  return { wrap };
}

// よく使う操作 (コピー・編集・再生成) だけを並べ、残りは「…」のメニューにまとめる
function messageMenuButton(chat, m) {
  const more = iconButton('more', tx('msg.more'));
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    const items = [];
    items.push(
      { icon: 'branch', label: tx('msg.fork'), action: () => forkChat(chat, m) },
      { icon: 'trash', label: tx('common.delete'), danger: true, confirm: tx('common.pressAgainDelete'), action: () => deleteMessage(chat, m) },
    );
    openMenu(more, items);
  });
  return more;
}

// 編集・再生成で作られた別の版を「‹ 2 / 3 ›」で切り替えるボタン
function variantNav(chat, m) {
  if (!m.variants || m.variants.length < 2) return null;
  const vi = m.vi || 0;
  const nav = el('span', 'variants');
  const user = m.role === 'user';
  const prev = iconButton('left', tx(user ? 'variant.prevVersion' : 'variant.prevAnswer'), () => switchVariant(chat, m, vi - 1));
  const next = iconButton('chevron', tx(user ? 'variant.nextVersion' : 'variant.nextAnswer'), () => switchVariant(chat, m, vi + 1));
  prev.disabled = vi === 0;
  next.disabled = vi === m.variants.length - 1;
  nav.append(prev, el('span', '', `${vi + 1} / ${m.variants.length}`), next);
  return nav;
}

function fileChip(f) {
  const chip = el('span', 'file-chip');
  chip.append(icon('file'), el('span', '', f.name), el('small', '', tx('unit.chars', { n: f.text.length.toLocaleString(I18n.locale) })));
  return chip;
}

function assistantView(chat, m, lazy) {
  const wrap = el('div', 'msg assistant');
  const details = el('details', 'think');
  const summary = el('summary');
  const summaryText = el('span', '', tx('think.title'));
  summary.append(summaryText, icon('chevron'));
  const thinkBody = el('div', 'think-body');
  details.append(summary, thinkBody);
  details.hidden = true;
  const toolsBox = el('div', 'tool-trace');
  toolsBox.hidden = true;
  const progress = el('div', 'progress');
  progress.hidden = true;
  const body = el('div', 'md');
  const notice = el('div', 'notice');
  notice.hidden = true;
  const actions = el('div', 'actions');
  const copy = iconButton('copy', tx('common.copy'), () => copyText(m.content, copy));
  const meta = el('span', 'meta');
  const nav = variantNav(chat, m);
  if (nav) actions.append(nav);
  actions.append(
    copy,
    iconButton('regen', tx('msg.regenerate'), () => regenerate(chat, m)),
    messageMenuButton(chat, m),
    meta,
  );
  wrap.append(details, toolsBox, progress, body, notice, actions);
  const view = { chat, wrap, details, summaryText, thinkBody, toolsBox, progress, body, notice, actions, meta };
  fillAssistant(view, m, lazy);
  return view;
}

function renderTools(view, tools) {
  view.toolsBox.hidden = !tools || tools.length === 0;
  if (view.toolsBox.hidden) return;
  view.toolsBox.replaceChildren(...tools.map((t) => {
    const line = el('div', 'tool-line');
    let args = t.args || '';
    try { const a = JSON.parse(args || '{}'); args = Object.values(a).map((v) => String(v)).join(', '); } catch { /* そのまま */ }
    const result = t.result.length > 160 ? t.result.slice(0, 160) + '…' : t.result;
    line.title = t.result;
    line.append(icon('tool'), el('code', '', `${t.name}(${args})`), el('span', '', '→'), el('span', 'res', result));
    return line;
  }));
}

function fillAssistant(view, m, lazy) {
  if (m.reasoning) {
    view.details.hidden = false;
    view.summaryText.textContent = m.thinkMs ? tx('think.duration', { time: fmtSec(m.thinkMs) }) : tx('think.title');
    view.summaryText.className = '';
    view.thinkBody.textContent = m.reasoning;
  }
  renderTools(view, m.tools);
  if (!lazy) view.body.replaceChildren(renderAnswer(view, m));
  const s = m.stats;
  view.meta.textContent = [s && s.genTps ? `${s.genTps.toFixed(1)} tok/s · ${s.genN} tok` : '', m.edited ? tx('msg.edited') : ''].filter(Boolean).join(' · ');
  view.notice.replaceChildren();
  const cut = m.finish === 'length' || m.finish === 'abort';
  view.notice.hidden = !(cut || m.dropped);
  if (m.dropped) {
    view.notice.append(el('span', 'dim', tx('msg.dropped', { count: m.dropped })));
  }
  if (cut) {
    view.notice.append(el('span', '', m.finish === 'length' ? tx('msg.cutLength') : tx('msg.stopped')));
    const chat = view.chat;
    if (chat && chat.messages[chat.messages.length - 1] === m && m.content) {
      view.notice.append(button(tx('msg.continue'), () => continueAnswer(chat, m), 'pill'));
    }
  }
}

function startEdit(chat, m, wrap, bubble) {
  if (isBusy()) return;
  const box = el('div', 'edit');
  const ta = el('textarea');
  ta.autocomplete = 'off';
  ta.spellcheck = false;
  ta.rows = Math.min(12, Math.max(2, m.content.split('\n').length + 1));
  ta.value = m.content;
  const actions = wrap.querySelector('.actions');
  const row = el('div', 'row');
  row.append(
    button(tx('common.cancel'), () => {
      bubble.hidden = !m.content;
      box.replaceWith(bubble);
      actions.hidden = false;
    }, 'pill'),
    button(tx('common.send'), () => {
      if (isBusy()) return;
      if (!ta.value.trim() && !m.images.length && !m.files.length) { ta.focus(); return; } // 空のメッセージは送らない (send と同じ)
      const idx = chat.messages.indexOf(m);
      if (idx === -1) return;
      if (ta.value !== m.content || idx < chat.messages.length - 1) { // 同じ内容で送り直すときも、後ろの会話を失わない
        // 編集前の版と、それに続いていた会話を残しておく
        const vs = m.variants && m.variants.length ? m.variants.slice() : [snapshot(m)];
        vs[m.vi || 0] = { ...snapshot(m), tail: chat.messages.slice(idx + 1) };
        m.content = ta.value;
        m.variants = vs.concat(snapshot(m));
        m.vi = m.variants.length - 1;
      }
      chat.messages.splice(idx + 1);
      touchChat(chat);
      renderLog();
      generate(chat);
    }, 'pill light'),
  );
  box.append(ta, row);
  bubble.hidden = false;
  bubble.replaceWith(box);
  actions.hidden = true;
  ta.focus();
}

// ---- 版の履歴 (編集・再生成で作った別の版を切り替える) ----------------------

const snapshot = (m) => (m.role === 'user'
  ? { content: m.content, images: m.images, files: m.files }
  : { content: m.content, reasoning: m.reasoning, stats: m.stats, finish: m.finish, thinkMs: m.thinkMs || 0, tools: m.tools || [], dropped: m.dropped || 0, edited: !!m.edited });

function applyVariant(m, v) {
  if (m.role === 'user') Object.assign(m, { content: v.content, images: v.images || [], files: v.files || [] });
  else Object.assign(m, { content: v.content, reasoning: v.reasoning, stats: v.stats, finish: v.finish, thinkMs: v.thinkMs || 0, tools: v.tools || [], dropped: v.dropped || 0, edited: !!v.edited });
}

// 途中のメッセージまでを新しいチャットとして複製する (版の履歴は持ち越さない)
function forkChat(chat, m) {
  if (isBusy()) return;
  const idx = chat.messages.indexOf(m);
  if (idx === -1) return;
  const messages = chat.messages.slice(0, idx + 1).map((x) => {
    const { variants, vi, ...rest } = x; // 捨てる版の履歴 (画像を含む) は複製しない
    const c = copyData(rest);
    c.id = uid();
    return c;
  });
  const fork = {
    id: uid(), title: tx('chat.forkTitle', { title: chat.title }).slice(0, 200), createdAt: Date.now(), updatedAt: Date.now(),
    system: chat.system, messages, lastUsage: 0, pinned: false, folder: chat.folder || '',
  };
  state.chats.set(fork.id, fork);
  touchChat(fork);
  openChat(fork.id);
}

function continueAnswer(chat, m) {
  if (isBusy() || chat.messages[chat.messages.length - 1] !== m) return;
  generate(chat, { target: m });
}

async function regenerate(chat, m) {
  if (isBusy()) return;
  const idx = chat.messages.indexOf(m);
  if (idx === -1) return;
  const variants = m.variants && m.variants.length ? m.variants.slice() : [snapshot(m)];
  const vi = m.variants ? (m.vi || 0) : 0;
  variants[vi] = { ...snapshot(m), tail: chat.messages.slice(idx + 1) }; // この回答に続いていた会話も残す
  chat.messages.splice(idx);
  renderLog();
  const ok = await generate(chat, { variants });
  if (!ok) { // 失敗したら元の回答に戻す
    chat.messages.splice(idx);
    chat.messages.push(m, ...(variants[vi].tail || []));
    renderLog();
    touchChat(chat);
  }
}

function switchVariant(chat, m, to) {
  if (isBusy() || !m.variants || to < 0 || to >= m.variants.length || to === (m.vi || 0)) return;
  const idx = chat.messages.indexOf(m);
  if (idx === -1) return;
  const vs = m.variants;
  vs[m.vi || 0] = { ...snapshot(m), tail: chat.messages.slice(idx + 1) };
  const v = vs[to];
  applyVariant(m, v);
  m.vi = to;
  const tail = v.tail || [];
  vs[to] = snapshot(m);
  chat.messages.splice(idx + 1, chat.messages.length, ...tail);
  chat.lastUsage = 0; // 内容が変わったので、次の送信では数え直す
  touchChat(chat);
  renderLog();
}

// ---- 状態表示 -------------------------------------------------------------

const CTX_NOTICE_RATIO = 0.7;
let ctxUsed = 0; // 最後に表示した使用量 (詳細機能の切り替えで描き直すため)
function renderCtx(used) {
  const n = state.server.nCtx;
  ctxUsed = used;
  if (!n) { els.ctxText.textContent = ''; els.ctxFill.style.transform = 'scaleX(0)'; els.ctx.hidden = true; return; }
  const ratio = Math.min(1, used / n);
  // 詳細機能がオフのときは、上限に近づいたときだけ見せる (普段は専門用語を出さない)
  els.ctx.hidden = !(settings.advanced || ratio > CTX_NOTICE_RATIO);
  els.ctxFill.style.transform = `scaleX(${ratio.toFixed(3)})`;
  els.ctxText.textContent = `${(used / 1000).toFixed(1)}k / ${Math.round(n / 1000)}k`;
  els.ctx.classList.toggle('high', ratio > 0.85);
}

function showError(text) {
  const wrap = el('div', 'msg error');
  wrap.append(el('div', 'bubble-err', text));
  ensureThread().append(wrap);
  els.log.scrollTop = els.log.scrollHeight;
}

function setBusy(busy) {
  els.send.hidden = busy;
  els.stop.hidden = !busy;
  updateSendState();
  if (busy) {
    cancelIdleCallback(lazyIdle);
    lazyIdle = 0;
    if (tokenRequest) tokenRequest.abort();
    tokenRequest = null;
  } else { scheduleLazy(); countTokens(); }
  updateBulk();
}

function updateSendState() {
  const has = /\S/.test(els.input.value) || state.pending.images.length || state.pending.files.length;
  els.send.disabled = state.image.mode ? !imageSendable() : !has || !!state.controller || !state.server.ok;
  els.modelSelect.disabled = !!state.controller || !!btwState.controller || state.server.loading;
}

// 明滅を次の山 (完全に明るい状態) まで続けて、そこで止める。途中で明るさを飛ばさない
async function settleSplash() {
  const pulses = document.hidden || els.splash.hidden ? [] : els.splash.getAnimations({ subtree: true }).filter((a) => a.animationName === 'load-pulse');
  for (const a of pulses) {
    const i = a.effect.getComputedTiming().currentIteration || 0; // 偶数回目は暗くなる途中、奇数回目は明るくなる途中
    a.effect.updateTiming({ iterations: i + (i % 2 ? 1 : 2), fill: 'forwards' });
    a.updatePlaybackRate(1.5);
  }
  const done = Promise.all(pulses.map((a) => a.finished)).catch(() => {});
  await Promise.race([done, new Promise((r) => setTimeout(r, 2500))]); // 途中でウィンドウが隠れて止まっても待ち続けない
}

const fade = (node, from, to) => node.animate({ opacity: [from, to] }, { duration: 200, easing: 'ease-out' }).finished.catch(() => {});

// 読み込みの完了を知らせる発光。ぼかした複製を重ねて不透明度だけを動かすので、白い部分も元の明るさを超えて光って見える
async function flashSplash() {
  const parts = [...els.splash.querySelectorAll('.welcome-logo, .welcome-title')];
  // 位置をまとめて読んでから挿入する (読み書きを交互にするとレイアウト計算が増える)
  const boxes = parts.map((part) => [part.offsetLeft, part.offsetTop, part.offsetWidth, part.offsetHeight]);
  const glows = parts.map((part, k) => {
    const glow = part.cloneNode(true);
    const [left, top, width, height] = boxes[k];
    glow.classList.add('splash-glow');
    glow.removeAttribute('alt');
    glow.setAttribute('aria-hidden', 'true');
    glow.style.left = `${left}px`;
    glow.style.top = `${top}px`;
    glow.style.width = `${width}px`;
    glow.style.height = `${height}px`;
    part.after(glow);
    return glow;
  });
  try {
    await Promise.all(glows.map((g) => (g.decode ? g.decode().catch(() => {}) : null)));
    const timing = { duration: 900, easing: 'linear' };
    const keyframes = [
      { opacity: 0, easing: 'ease-in-out' },
      { opacity: 0.7, offset: 0.3, easing: 'ease-in-out' }, // 使えるようになったことがはっきり分かる明るさ
      { opacity: 0 },
    ];
    await Promise.race([
      Promise.all(glows.map((g) => g.animate(keyframes, timing).finished)).catch(() => {}),
      new Promise((r) => setTimeout(r, 1200)), // 途中でウィンドウが隠れて止まっても待ち続けない
    ]);
  } finally {
    glows.forEach((g) => g.remove());
  }
}

// 読み込みの完了後の画面に切り替える。ロゴを点灯させてから入力を受け付ける
let loadingTurn = 0;
async function finishLoading(turn) {
  await settleSplash();
  if (turn !== loadingTurn) return;
  if (state.server.ok && !document.hidden && !els.splash.hidden) await flashSplash(); // 失敗で読み込みが終わったときは光らせない
  if (turn !== loadingTurn) return;
  // 明滅と同じ、動きのないフェードなので「視覚効果を減らす」設定でも省かない
  const unseen = document.hidden || els.splash.hidden;
  const logo = els.log.querySelector('.welcome-logo');
  if (logo) await logo.decode().catch(() => {}); // 空のチャットは同じ位置のロゴに替わるので、描画が抜けないよう先に用意する
  else if (!unseen) await fade(els.splash, 1, 0); // 会話があるときは、ロゴを消してから会話を出す
  if (turn !== loadingTurn) return;
  state.server.loading = false;
  els.splash.hidden = true;
  els.log.hidden = false;
  els.input.disabled = false;
  els.btnAttach.disabled = false;
  updateSendState();
  els.log.scrollTop = els.log.scrollHeight; // 隠れている間はスクロール位置が反映されない
  updateBottomButton();
  countTokens();
  if (!els.app.inert) els.input.focus();
  if (!logo && !unseen) fade(els.log, 0, 1);
}

// モデルの読み込み中はロゴを明滅させ、入力を受け付けない
function setLoading(loading) {
  if (state.server.backgroundLoading) {
    // 画像の後のチャット復帰は会話・スクロール・入力を保ったまま知らせる。
    state.server.loading = loading;
    state.server.settling = false;
    if (!loading && state.server.ok) state.server.backgroundLoading = false;
    updateSendState();
    return;
  }
  if (!loading) {
    updateSendState(); // 読み込み中でなくても、サーバーの状態が変わったので送信ボタンを更新する
    if (state.server.loading && !state.server.settling) {
      const turn = ++loadingTurn;
      state.server.settling = true;
      finishLoading(turn).finally(() => { if (turn === loadingTurn) state.server.settling = false; });
    }
    return;
  }
  loadingTurn++; // 点灯へ向かっている途中で読み込みに戻ったときは、明滅を始めからやり直す
  if (state.server.settling) { els.splash.hidden = true; void els.splash.offsetWidth; }
  state.server.settling = false;
  state.server.loading = true;
  if (!els.app.inert) els.splash.hidden = false;
  els.log.hidden = true;
  els.input.disabled = true;
  els.btnAttach.disabled = true;
  updateSendState();
}

// delay ms 待ってから、次の画面更新に合わせて fn を呼ぶ。描画をフレームに揃えて、途中の状態や二重の描画を見せない。
// 戻り値を呼ぶと取り消せる
function frameAfter(delay, fn) {
  let frame = 0;
  let timeout = 0;
  if (delay > 0) timeout = setTimeout(() => { timeout = 0; frame = requestAnimationFrame(fn); }, delay);
  else frame = requestAnimationFrame(fn);
  return () => { clearTimeout(timeout); cancelAnimationFrame(frame); };
}

// ---- 最下部へボタン -------------------------------------------------------

let bottomFrame = 0;
function updateBottomButton() {
  if (bottomFrame) return;
  bottomFrame = requestAnimationFrame(() => {
    bottomFrame = 0;
    const hide = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 200;
    if (els.btnBottom.hidden !== hide) els.btnBottom.hidden = hide;
  });
}

// 遠いときは途中の描画を省くため、なめらかに動かさず一度で移動する
function scrollToBottom(smooth) {
  const far = els.log.scrollHeight - els.log.scrollTop > els.log.clientHeight * 3;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  els.log.scrollTo({ top: els.log.scrollHeight, behavior: smooth && !far && !reduce ? 'smooth' : 'auto' });
}

// ---- キーボードショートカット ----------------------------------------------

function lastMessage(chat, role) {
  for (let i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i].role === role) return chat.messages[i];
  return null;
}

function onShortcut(e) {
  const key = e.key.toLowerCase();
  const ctrlShift = (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey;
  if (e.key === 'Escape' && e.shiftKey) { e.preventDefault(); els.input.focus(); return; }
  if (e.key === 'Escape') {
    if (!els.menu.hidden) closeMenu();
    else if (!$('model-editor').hidden) closeModelEditor();
    else if (!els.project.hidden) closeProject();
    else if (!els.settings.hidden) closeSettings();
    else if (state.selection) exitSelection();
    else if (state.controller) state.controller.abort();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === '/') {
    e.preventDefault();
    openSettings('shortcuts');
    return;
  }
  if (!ctrlShift || !els.settings.hidden || !els.project.hidden) return;
  if (key === 'o') { e.preventDefault(); if (!isBusy()) newChat(); }
  else if (key === 'b') { e.preventDefault(); if (!state.image.mode) toggleBtw(); }
  else if (key === 'g') { e.preventDefault(); toggleImageMode(); }
  else if (key === 's') { e.preventDefault(); els.app.classList.toggle('side-closed'); }
  else if (key === 'k') {
    e.preventDefault();
    const m = lastMessage(current(), 'assistant');
    if (m) navigator.clipboard.writeText(m.content).then(() => flashHint(tx('hint.copiedAnswer'))).catch(() => {});
  } else if (e.key === 'End') { e.preventDefault(); scrollToBottom(true); }
}

let hintTimer = 0;
function flashHint(text) {
  clearTimeout(hintTimer);
  els.hint.textContent = text;
  hintTimer = setTimeout(updateHint, 1600);
}

// 入力欄が空のときの ↑ で、直前の自分のメッセージを編集する
function editLastUserMessage() {
  const chat = current();
  const m = lastMessage(chat, 'user');
  const v = m && state.views.get(m);
  if (!v || !v.wrap.isConnected || isBusy()) return false;
  startEdit(chat, m, v.wrap, v.bubble);
  v.wrap.scrollIntoView({ block: 'nearest' });
  return true;
}

// 対応ブラウザでは CSS の field-sizing に任せる (キー入力のたびにレイアウトを強制しない)
const NATIVE_AUTOSIZE = CSS.supports('field-sizing', 'content');

function autosize() {
  if (NATIVE_AUTOSIZE) return;
  els.input.style.height = 'auto';
  els.input.style.height = els.input.scrollHeight + 'px';
}

// ---- 送信前のトークン数 (サーバーの /tokenize で数える) -----------------------

// composeText の結果の長さ。添付の全文を連結せずに求める
function composedLength(content, files) {
  if (!files.length) return content.length;
  let n = (files.length - 1) * 2 + (content ? 2 + content.length : 0);
  const wrapper = tx('model.attachment', { name: '', text: '' }).length; // 見出しと囲みの長さ (言語ごとに違う)
  for (const f of files) n += wrapper + f.name.length + f.text.length;
  return n;
}

function composeText(content, files) {
  if (!files.length) return content;
  const blocks = files.map((f) => tx('model.attachment', { name: f.name, text: f.text }));
  return blocks.join('\n\n') + (content ? '\n\n' + content : '');
}

// サーバーの /tokenize で数える。数えられないときは null
const tokenSlots = Runtime.limit(2);
function tokenize(text, signal) {
  const model = state.server.model;
  return tokenSlots(async () => {
  try {
    const res = await fetch('/tokenize', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model, content: text }),
      credentials: 'omit',
      signal,
    });
    if (res.ok) {
      const j = await res.json();
      if (Array.isArray(j.tokens)) return j.tokens.length;
    }
  } catch { /* null を返す */ }
  return null;
  }, signal);
}

async function tokenCount(text, signal) {
  if (!text) return 0;
  const n = await tokenize(text, signal);
  if (signal) signal.throwIfAborted();
  return n !== null ? n : Math.ceil(text.length * 1.2); // 数えられないときは多めに見積もる
}

// メッセージごとのトークン数は一度数えたら覚えておく (内容が変わったら数え直す)
let messageTokenCache = new WeakMap();
async function messageTokens(m, signal) {
  const cached = messageTokenCache.get(m);
  const model = state.server.model;
  const content = m.content, images = m.images.length;
  if (cached && cached.content === m.content && cached.images === m.images.length && cached.model === model
      && cached.files.length === m.files.length && m.files.every((f, i) => f.name === cached.files[i][0] && f.text === cached.files[i][1])) return cached.n;
  const files = m.files.map((f) => [f.name, f.text]); // 数えている間に添付が変わっても、数えた時点の内容と結び付ける
  const n = await tokenCount(composeText(content, m.files), signal) + images * IMAGE_TOKENS + 8;
  if (!state.ended) messageTokenCache.set(m, { content, images, model, files, n });
  return n;
}

// システム側 (プロジェクトのファイルを含むと大きい) は、内容とモデルが前回と同じなら数え直さない
let systemTokenCache = { text: null, model: '', n: 0 };
async function systemTokens(text, signal) {
  const model = state.server.model;
  if (systemTokenCache.text === text && systemTokenCache.model === model) return systemTokenCache.n;
  const n = await tokenCount(text, signal);
  if (!state.ended) systemTokenCache = { text, model, n };
  return n;
}

// コンテキストの上限 (回答用の余白を残す) に収まるよう、古いメッセージから送信対象を外す
// upcoming: これから足す分の文字数 (btw の質問など)。予算から先に引いておく
async function buildContext(chat, list, signal = state.controller && state.controller.signal, upcoming = 0, prepareImages = false) {
  list = list.filter(isChatTurn); // 画像の生成・編集は AI に送らない
  const system = systemFor(chat);
  const sys = system.trim() ? [{ role: 'system', content: system }] : [];
  // プロジェクトに入れた直後などでシステム側が増えた分は、前回の使用量に含まれていない (sysLen はサーバーが使用量を返したときに更新する)
  const grown = Math.max(0, system.length - (chat.sysLen === undefined ? chat.system.length : chat.sysLen));
  // 対象が決まるまで大きな添付文字列や画像の配列を組み立てない。
  const resultFrom = async (start) => {
    const selected = list.slice(start);
    if (prepareImages && !(await ensureImages(chat, selected.map((m) => ({ images: m.images }))))) throw new Error(IMAGES_NOT_READY);
    return { messages: sys.concat(selected.map((m) => ({ role: m.role, content: apiContent(m) }))), dropped: start };
  };
  const n = state.server.nCtx;
  if (!n || list.length < 2) return resultFrom(0);
  const budget = n - (Math.min(Number(settings.max_tokens) || 8192, Math.floor(n / 2)) + 512) - Math.ceil(upcoming * 1.2);
  // 前回の使用量に今回の入力を足しても余裕があれば数えない (前回分には思考も含まれるので多めの見積もり)
  const last = list[list.length - 1];
  const quick = (chat.lastUsage || 0) + (composedLength(last.content, last.files) + grown) * 1.2 + last.images.length * IMAGE_TOKENS;
  // 前回 (最後の回答) に古い発言を外していたら、前回の使用量は全履歴の量ではないので見積もりに使えない。
  // それより前の回答で外していても、最後の回答が全履歴を送れていれば前回の使用量は正しい
  let lastReply = null;
  for (let i = list.length - 1; i >= 0 && !lastReply; i--) if (list[i].role === 'assistant') lastReply = list[i];
  if (chat.lastUsage && quick < budget && !(lastReply && lastReply.dropped)) return resultFrom(0);

  let total = sys.length ? await systemTokens(system, signal) : 0;
  let start = list.length - 1;
  // 新しい発言から最大2件ずつ数える。送らない古い履歴は数えず、長い会話の送信待ちを減らす。
  countHistory: for (let end = list.length; end > 0; end -= 2) {
    const begin = Math.max(0, end - 2);
    const counts = await Promise.all(list.slice(begin, end).map((m) => messageTokens(m, signal)));
    for (let i = end - 1; i >= begin; i--) {
      const count = counts[i - begin];
      if (i < list.length - 1 && total + count > budget) break countHistory;
      total += count;
      start = i;
    }
  }
  while (start > 0 && start < list.length - 1 && list[start].role !== 'user') start++; // 先頭はユーザーの発言にそろえる
  return resultFrom(start);
}

// 添付ファイルは一度だけ数えて覚えておく (入力のたびに全文を送らない)
let fileTokens = new WeakMap();
let tokenRequest = null;

async function fileTokenCount(f, signal) {
  const model = state.server.model;
  const cached = fileTokens.get(f);
  if (cached && cached.model === model && cached.name === f.name && cached.text === f.text && !cached.signal?.aborted) return cached.pending || cached.n;
  const name = f.name, text = f.text;
  const entry = { model, name, text, signal, pending: null };
  entry.pending = tokenize(composeText('', [f]), signal).then((n) => {
    if (fileTokens.get(f) === entry) {
      if (n === null || state.ended || signal?.aborted) fileTokens.delete(f);
      else { entry.n = n; entry.pending = null; entry.signal = null; }
    }
    return n;
  });
  fileTokens.set(f, entry);
  return entry.pending;
}

let typedTokenCache = { text: null, model: '', n: 0 };

const countTokens = debounce(async () => {
  if (tokenRequest) tokenRequest.abort(); // 古い問い合わせは取り消す
  tokenRequest = null;
  const typed = els.input.value.trim();
  const files = state.pending.files;
  // 表示するのは詳細機能がオンのときだけ。オフなら問い合わせもしない
  if ((!typed && !files.length) || !settings.advanced || !state.server.ok || state.controller || document.hidden || state.image.mode) { els.tokenCount.textContent = ''; return; }
  const request = new AbortController();
  tokenRequest = request;
  // 送信や読み込み完了のたびに呼ばれるので、入力が変わっていなければ前回の数を使う
  const model = state.server.model;
  const memo = typedTokenCache.text === typed && typedTokenCache.model === model ? typedTokenCache.n : null;
  const counts = await Promise.all([memo !== null ? memo : typed ? tokenize(typed, request.signal) : 0, ...files.map((f) => fileTokenCount(f, request.signal))]);
  if (tokenRequest !== request) return;
  tokenRequest = null;
  if (typed && memo === null && counts[0] !== null && !state.ended) typedTokenCache = { text: typed, model, n: counts[0] };
  if (counts.includes(null)) { els.tokenCount.textContent = ''; return; }
  const n = counts.reduce((a, b) => a + b, 0);
  els.tokenCount.textContent = `${n.toLocaleString(I18n.locale)} tok` + (state.pending.images.length ? tx('tokens.plusImages') : '');
}, 500);

// ---------------------------------------------------------------------------
// 添付ファイル
// ---------------------------------------------------------------------------

function clearPending() {
  state.pending = { images: [], files: [] };
  renderPending();
}

function renderPending() {
  const frag = document.createDocumentFragment();
  const removeBtn = (onClick) => {
    const b = button(undefined, onClick, 'rm');
    b.title = tx('common.remove');
    b.append(icon('x'));
    return b;
  };
  // 画像モードでは、チャット用の添付の代わりに編集の元画像だけを表示する (チャット用の添付は残しておく)
  if (!state.image.mode) {
    state.pending.images.forEach((src, k) => {
      const att = el('div', 'att');
      const img = el('img');
      img.src = src;
      img.alt = tx('msg.attachedImage');
      att.append(img, removeBtn(() => { state.pending.images.splice(k, 1); renderPending(); }));
      frag.append(att);
    });
    state.pending.files.forEach((f, k) => {
      const att = el('div', 'att');
      att.append(fileChip(f), removeBtn(() => { state.pending.files.splice(k, 1); renderPending(); }));
      frag.append(att);
    });
  } else {
    if (state.image.mode === 'edit' && state.image.source) {
      const att = el('div', 'att source');
      const img = el('img');
      img.src = state.image.source.url;
      img.alt = tx('image.source');
      att.append(img, el('span', 'att-label', tx('image.source')), removeBtn(() => { state.image.source = null; renderPending(); }));
      frag.append(att);
    }
  }
  els.attachments.replaceChildren(frag);
  updateSendState();
  countTokens();
}

async function addFiles(fileList) {
  if (state.image.mode) { await addImageModeFiles(fileList); return; } // 画像モードでは元画像の指定になる
  if (state.server.loading) return;
  for (const file of fileList) {
    try {
      if (file.type.startsWith('image/')) await addImage(file);
      else if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') await addPdf(file);
      else await addTextFile(file);
    } catch (e) {
      showError(`${file.name}: ${e.message}`);
    }
  }
  renderPending();
}

// 画像を受け取れない理由: モデルの読み込みがまだ・起動設定でオフ・このモデルが対応していない (対応する mmproj が無い)
async function visionProblem() {
  if (!state.server.ok) return tx('attach.visionNotReady');
  try {
    const info = await controlRequest('GET', '/launch');
    if (info.effective && info.effective.vision === false) return tx('attach.visionOff');
  } catch { /* 起動設定を確かめられないときは、モデルの側の理由として知らせる */ }
  return tx('attach.visionUnsupported');
}

async function addImage(file) {
  if (!state.server.vision) throw new Error(await visionProblem());
  if (state.pending.images.length >= LIMITS.imagesPerMessage) throw new Error(tx('attach.tooManyImages', { max: LIMITS.imagesPerMessage }));
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, LIMITS.imageEdge / Math.max(bmp.width, bmp.height));
  const canvas = el('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  state.pending.images.push(canvas.toDataURL('image/jpeg', 0.9));
}

async function addPdf(file) {
  if (file.size > LIMITS.pdfBytes) throw new Error(tx('attach.pdfTooBig', { mb: LIMITS.pdfBytes / 1024 / 1024 }));
  const chip = el('div', 'att');
  const label = el('span', 'file-chip shimmer', tx('attach.reading', { name: file.name }));
  chip.append(label);
  els.attachments.append(chip);
  try {
    state.pending.files.push(await readPdfFile(file));
  } finally {
    chip.remove();
  }
}

// signal: 読み込みを途中でやめるための AbortSignal (渡せば PdfText が処理を譲るたびに確かめる。今の呼び出し元には取り消しの操作が無いので渡していない)
async function readPdfFile(file, signal) {
  if (file.size > LIMITS.pdfBytes) throw new Error(tx('attach.pdfTooBig', { mb: LIMITS.pdfBytes / 1024 / 1024 }));
  // 文字数の上限は抽出の途中で確かめる (超えたら PdfText が、その旨の例外を出して止まる)
  const text = await PdfText.extract(await file.arrayBuffer(), { maxChars: LIMITS.textFileBytes, signal });
  return { name: file.name.slice(0, 255), text };
}

async function addTextFile(file) {
  state.pending.files.push(await readTextFile(file));
}

// UTF-8 でない古いテキストファイルを読む。文字コードはファイルからは分からないので、候補を順に試して、読めない並びが出ない最初のもので読む:
// 画面の言語の文字コード → ブラウザの言語の文字コード → そのほかの主なもの。どれでも読めない並びが出るなら、画面の言語のもので読む
// (画面の言語と違う言語のファイルも読めるように。英語の画面で Shift_JIS のファイルを読む、など)
const LEGACY_ENCODINGS = { ja: 'shift_jis', 'zh-cn': 'gb18030', 'zh-tw': 'big5', ko: 'euc-kr' };
function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* UTF-8 ではない */ }
  const own = tx('meta.legacyEncoding');
  const browser = String(navigator.language || '').toLowerCase();
  const byBrowser = LEGACY_ENCODINGS[browser] || LEGACY_ENCODINGS[browser.split('-')[0]] || (browser.startsWith('zh') ? (/hant|-tw|-hk|-mo/.test(browser) ? 'big5' : 'gb18030') : '');
  // windows-1252 はどんなバイト列も読めてしまうので、最後に試す
  const order = [...new Set([own, byBrowser, 'shift_jis', 'gb18030', 'big5', 'euc-kr'].filter((e) => e && e !== 'windows-1252'))];
  for (const encoding of order) {
    try { return new TextDecoder(encoding, { fatal: true }).decode(buf); } catch { /* 次を試す */ }
  }
  return new TextDecoder(own).decode(buf);
}

async function readTextFile(file) {
  if (file.size > LIMITS.textFileBytes) throw new Error(tx('attach.textTooBig', { kb: LIMITS.textFileBytes / 1024 }));
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.subarray(0, 8192).includes(0)) throw new Error(tx('attach.binary'));
  return { name: file.name.slice(0, 255), text: decodeText(buf).replace(/^﻿/, '') };
}

// ---------------------------------------------------------------------------
// 送信と生成
// ---------------------------------------------------------------------------

function apiContent(m) {
  const text = composeText(m.content, m.files);
  if (m.role !== 'user' || m.images.length === 0) return text;
  // http(s) の URL を渡すとサーバーが取得しに行くので、data: 以外は送らない
  const parts = m.images.filter((url) => SAFE_IMAGE_RE.test(url)).map((url) => ({ type: 'image_url', image_url: { url } }));
  if (text) parts.push({ type: 'text', text });
  return parts;
}

function send() {
  if (state.image.mode) { sendImage(); return; }
  if (state.controller || state.generation || !state.server.ok) return;
  const chat = current();
  const text = els.input.value.trim();
  const { images, files } = state.pending;
  if (!text && images.length === 0 && files.length === 0) return;
  const m = { id: uid(), role: 'user', content: text, images: [...images], files: [...files] };
  const title = chat.title;
  chat.messages.push(m);
  autoTitle(chat);
  els.input.value = '';
  autosize();
  clearPending();
  ensureThread().append(messageView(chat, m).wrap);
  // 一覧に初めて出るときと題名が変わったときだけ作り直す (並び順は回答の保存後に作り直すときに変わる)
  if (chat.messages.length === 1 || chat.title !== title) renderSidebar();
  generate(chat);
}

async function request(payload, signal) {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
    signal,
    credentials: 'omit',
  });
  if (res.status === 401) throw new Error(tx('error.apiKey'));
  if (res.ok) return res;
  const text = await res.text();
  if (/exceed|context (size|length|window)|n_ctx|too long/i.test(text)) {
    throw new Error(tx('error.contextOverflow'));
  }
  throw new Error(tx('error.serverStatus', { status: res.status, text }));
}

// 回答を1つ生成する。ツールが有効なら、モデルがツールを呼ぶたびに実行して結果を返し、続きを生成させる
// opts.target: 既存の回答の続きを生成して追記する / opts.variants: 再生成前の回答の履歴
async function generate(chat, opts = {}) {
  let finish = () => {};
  state.generation = new Promise((resolve) => { finish = resolve; }); // btw は回答が確定するまで待つ
  // 新しい送信なら、送った時点の会話を先に保存する (再生成・続きでは、保存済みの前の回答を残す)
  if (!opts.variants && !opts.target) freezeChat(chat);
  state.generatingChat = chat;
  let released = false;
  // 回答が確定した時点で解放する。途中で例外が出ても、btw を待たせたままにしない
  const release = () => {
    if (released) return;
    released = true;
    state.generation = null;
    state.generatingChat = null;
    unfreezeChat(chat);
    finish();
  };
  try {
    // 保存した画像が読み込み終わっていないと、モデルに渡らない
    return await runGeneration(chat, opts, release);
  } finally {
    release();
  }
}

async function runGeneration(chat, opts, release) {
  chat.system = els.systemPrompt.value;
  const target = opts.target || null;
  const msg = target || { id: uid(), role: 'assistant', content: '', reasoning: '', images: [], files: [], stats: null, finish: null, thinkMs: 0, tools: [] };
  msg.tools = msg.tools || [];
  if (target) {
    const old = state.thread && state.thread.lastElementChild; // 今の表示を差し替える
    if (old && old.classList.contains('assistant')) old.remove();
    msg.finish = null;
  } else {
    chat.messages.push(msg);
  }
  const contextList = chat.messages.slice(0, chat.messages.indexOf(msg) + (target ? 1 : 0));
  const view = messageView(chat, msg);
  ensureThread().append(view.wrap);
  markLast();
  view.actions.hidden = true;
  view.notice.hidden = true;
  els.log.scrollTop = els.log.scrollHeight;

  // 進捗表示: 入力処理 (プログレスバー) → 思考中 (経過秒) → 回答 (逐次描画)
  const pLabel = el('span', 'shimmer');
  const pBar = el('div', 'pbar');
  const pFill = el('span');
  pBar.append(pFill);
  view.progress.append(pLabel, pBar);
  const typing = el('span', 'typing');
  // 思考の打ち切り: 応答の id を指定してサーバーに伝える (ツールを使うと往復ごとに id が変わる)
  const canEndThinking = settings.thinking;
  const THINK_STOP_LABEL = tx('think.stop');
  let completionId = '';
  const thinkStop = button(THINK_STOP_LABEL, async () => {
    thinkStop.disabled = true;
    thinkStop.textContent = tx('think.stopping');
    let ended = false;
    try {
      const res = await fetch('/v1/chat/completions/control', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ id: completionId, action: 'reasoning_end', model: state.server.model }),
        credentials: 'omit',
      });
      ended = (await res.json()).success === true;
    } catch { /* 生成はそのまま続くので、もう一度押せるように戻す */ }
    if (!ended && phase === 'think') { // すでに思考が終わっていた場合は、回答に移るので何もしない
      thinkStop.disabled = false;
      thinkStop.textContent = THINK_STOP_LABEL;
    }
  }, 'pill think-stop');
  thinkStop.hidden = true;
  view.wrap.insertBefore(thinkStop, view.toolsBox);
  view.thinkBody.replaceChildren();
  const thinkChunks = new Markdown.TextChunks(view.thinkBody);
  const stream = new StreamMarkdown(view.body);

  let phase = 'prompt';
  let round = 0;
  let t0 = 0;
  let promptPct = -1;
  let shownPct = -1;
  let shownLabel = '';
  let thinkStart = 0;
  let thinkTotal = target ? target.thinkMs || 0 : 0;
  let reasoningAll = target && target.reasoning ? target.reasoning + '\n\n' : '';
  let answerAll = target ? target.content : '';
  let roundRaw = '';
  let roundReasoning = '';
  let seenThink = reasoningAll.length;
  let shownThink = 0; // 折りたたみが閉じている間は表示に足さない (開いたときにまとめて足す)
  let paintTimer = null; // 予約中の描画を取り消す関数
  let lastPaint = 0;
  let paintCost = 0;
  if (reasoningAll) view.details.hidden = false; // 続きを生成するときは、これまでの思考と回答を表示したまま始める
  if (answerAll) stream.update(answerAll);

  const endThinking = () => {
    if (phase === 'think') thinkTotal += performance.now() - thinkStart;
  };
  const startRound = () => {
    phase = 'prompt';
    t0 = performance.now();
    promptPct = -1;
    shownPct = -1;
    roundRaw = '';
    roundReasoning = '';
    completionId = '';
    thinkStop.hidden = true;
    thinkStop.disabled = false;
    thinkStop.textContent = THINK_STOP_LABEL;
    pBar.className = 'pbar indeterminate';
    pFill.style.transform = '';
    view.progress.hidden = false;
  };
  const setLabel = (node, label) => {
    if (label === shownLabel) return;
    shownLabel = label;
    node.textContent = label;
  };
  const tick = () => {
    if (document.hidden) return;
    const now = performance.now();
    if (phase === 'prompt') {
      const base = round > 0 ? tx('progress.toolResult') : tx('progress.prompt');
      const sec = Math.floor((now - t0) / 1000);
      setLabel(pLabel, promptPct >= 0 ? `${base} ${promptPct}%` : `${base}${sec >= 2 ? tx('unit.secondsParen', { n: sec }) : ''}`);
      if (promptPct !== shownPct) {
        shownPct = promptPct;
        pBar.className = 'pbar';
        pFill.style.transform = `scaleX(${promptPct / 100})`;
      }
    } else if (phase === 'think') {
      setLabel(view.summaryText, tx('think.inProgress', { time: fmtSec(thinkTotal + now - thinkStart) }));
    }
  };
  const timer = setInterval(tick, 500);

  const paint = () => {
    paintTimer = null;
    const started = performance.now();
    const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 120; // DOM を変える前に読む
    const parts = splitThink(roundRaw);
    const think = reasoningAll + roundReasoning + parts.think;
    if (think.length > seenThink) {
      seenThink = think.length;
      if (phase !== 'think' && !parts.answer) {
        phase = 'think';
        thinkStart = performance.now();
        view.progress.hidden = true;
        view.details.hidden = false;
        view.summaryText.className = 'shimmer';
        thinkStop.hidden = !canEndThinking || !completionId;
      }
    }
    if (view.details.open && think.length > shownThink) {
      thinkChunks.append(think.slice(shownThink));
      shownThink = think.length;
    }
    if (parts.answer) {
      if (phase !== 'answer') {
        endThinking();
        phase = 'answer';
        thinkStop.hidden = true;
        view.progress.hidden = true;
        view.summaryText.className = '';
        if (thinkTotal) view.summaryText.textContent = tx('think.duration', { time: fmtSec(thinkTotal) });
        if (!typing.parentNode) view.wrap.insertBefore(typing, view.notice);
      }
      stream.update(answerAll + parts.answer);
      if (nearBottom) els.log.scrollTop = els.log.scrollHeight;
      else updateBottomButton();
    }
    tick();
    lastPaint = performance.now();
    paintCost = lastPaint - started;
  };
  // 描画の間隔を空ける。1回の描画が重いほど長く空けて、CPU を使いすぎないようにする
  const schedulePaint = () => {
    if (paintTimer || document.hidden) return;
    const gap = Math.min(PAINT_MAX_MS, Math.max(PAINT_MIN_MS, paintCost * 8));
    paintTimer = frameAfter(lastPaint + gap - performance.now(), paint);
  };
  const cancelPaint = () => { if (paintTimer) paintTimer(); paintTimer = null; };
  view.details.addEventListener('toggle', schedulePaint);
  const onVisible = () => { if (!document.hidden) schedulePaint(); };
  document.addEventListener('visibilitychange', onVisible);

  const extra = [];
  state.controller = new AbortController();
  setBusy(true);
  try {
    pLabel.textContent = tx('progress.preparing');
    view.progress.hidden = false;
    const built = await buildContext(chat, contextList, state.controller.signal, 0, true);
    const base = built.messages;
    msg.dropped = built.dropped;
    const sysLen = systemFor(chat).length; // 使用量を受け取るたびにプロジェクトの全文を組み立て直さない
    if (target) base.push({ role: 'user', content: CONTINUE_PROMPT }); // 続きの指示は会話には残さない
    for (round = 0; round < MAX_TOOL_ROUNDS; round++) {
      startRound();
      tick();
      const payload = {
        model: state.server.model,
        messages: base.concat(extra),
        stream: true,
        stream_options: { include_usage: true },
        return_progress: true,
        chat_template_kwargs: { enable_thinking: settings.thinking },
        ...samplingParams(),
      };
      if (settings.tools) payload.tools = Tools.DEFS;
      if (canEndThinking) payload.reasoning_control = true;
      const res = await request(payload, state.controller.signal);
      const calls = [];
      for await (const obj of Runtime.events(res.body)) {
          if (obj.id) completionId = obj.id;
          const pp = obj.prompt_progress;
          if (pp && pp.total > 0) promptPct = Math.min(100, Math.round((pp.processed / pp.total) * 100));
          const choice = obj.choices && obj.choices[0];
          if (choice) {
            const d = choice.delta || {};
            if (d.reasoning_content) roundReasoning += d.reasoning_content;
            if (d.content) roundRaw += d.content;
            for (const tc of d.tool_calls || []) {
              const k = typeof tc.index === 'number' ? tc.index : calls.length;
              const c = calls[k] || (calls[k] = { id: '', name: '', args: '' });
              if (tc.id) c.id = tc.id;
              if (tc.function && tc.function.name) c.name += tc.function.name;
              if (tc.function && tc.function.arguments) c.args += tc.function.arguments;
            }
            if (choice.finish_reason) msg.finish = choice.finish_reason;
          }
          if (obj.timings) {
            const t = obj.timings;
            msg.stats = { genTps: t.predicted_per_second, genN: t.predicted_n };
          }
          if (obj.usage && obj.usage.total_tokens) {
            chat.lastUsage = obj.usage.total_tokens;
            chat.sysLen = sysLen;
            renderCtx(chat.lastUsage);
          }
        schedulePaint();
      }
      cancelPaint();
      paint();
      endThinking();

      const parts = splitThink(roundRaw);
      reasoningAll += roundReasoning + parts.think;
      answerAll += parts.answer;
      roundRaw = '';
      roundReasoning = '';
      const realCalls = calls.filter((c) => c && c.name);
      if (!settings.tools || realCalls.length === 0) break;

      // ツールを実行して結果を会話に足し、もう一度生成させる
      if (reasoningAll) reasoningAll += '\n\n';
      const ids = realCalls.map((c, k) => c.id || `call_${round}_${k}`);
      extra.push({
        role: 'assistant',
        content: parts.answer || '',
        tool_calls: realCalls.map((c, k) => ({ id: ids[k], type: 'function', function: { name: c.name, arguments: c.args || '{}' } })),
      });
      for (const [k, c] of realCalls.entries()) {
        // この画面で開いている会話だけを検索対象にする
        const result = await runLocalTool(c.name, c.args, chat.id);
        extra.push({ role: 'tool', tool_call_id: ids[k], content: result });
        msg.tools.push({ name: c.name, args: c.args, result });
      }
      renderTools(view, msg.tools);
      msg.finish = null;
    }
  } catch (err) {
    if (err.name === 'AbortError') msg.finish = 'abort';
    else showError(String(err.message || err));
    const parts = splitThink(roundRaw);
    reasoningAll += roundReasoning + parts.think;
    answerAll += parts.answer;
    endThinking();
  } finally {
    state.controller = null;
    clearInterval(timer);
    cancelPaint();
    thinkStop.remove();
    view.details.removeEventListener('toggle', schedulePaint);
    document.removeEventListener('visibilitychange', onVisible);
  }

  msg.content = answerAll;
  msg.reasoning = reasoningAll.trim();
  msg.thinkMs = thinkTotal;
  typing.remove();
  view.progress.hidden = true;
  view.actions.hidden = false;
  setBusy(false);
  const ok = !!(msg.content || msg.reasoning);
  if (!ok) {
    chat.messages.pop();
    view.wrap.remove();
  } else {
    if (opts.variants) {
      msg.variants = opts.variants.concat(snapshot(msg));
      msg.vi = msg.variants.length - 1;
      const fresh = assistantView(chat, msg); // 回答の切り替えボタンを付けて描き直す
      view.wrap.replaceWith(fresh.wrap);
    } else {
      fillAssistant(view, msg); // 最後に全体を1回だけ正しく描画し直す
    }
  }
  markLast();
  release();
  if (ok) touchChat(chat);
  renderSidebar();
  return ok;
}

// ---------------------------------------------------------------------------
// 読み込み / 書き出し (読み込むJSONは信用しない: 形式と型を検証してから取り込む)
// ---------------------------------------------------------------------------

const SAFE_IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function sanitizeMessage(m) {
  if (m && m.role === 'image') return sanitizeImageMessage(m);
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
  let content = '';
  let images = [];
  if (typeof m.content === 'string') content = m.content;
  else if (Array.isArray(m.content)) { // OpenAI 形式
    for (const p of m.content) {
      if (p && p.type === 'text' && typeof p.text === 'string') content += p.text;
      if (p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string') images.push(p.image_url.url);
    }
  }
  if (Array.isArray(m.images)) images = images.concat(m.images);
  images = images.filter((s) => isStoredImage(s)).slice(0, LIMITS.imagesPerMessage);
  const files = Array.isArray(m.files)
    ? m.files.filter((f) => f && typeof f.name === 'string' && typeof f.text === 'string').map((f) => ({ name: f.name.slice(0, 255), text: f.text }))
    : [];
  const tools = Array.isArray(m.tools)
    ? m.tools.filter((t) => t && typeof t.name === 'string' && typeof t.result === 'string')
      .map((t) => ({ name: t.name.slice(0, 64), args: typeof t.args === 'string' ? t.args.slice(0, 2000) : '', result: t.result.slice(0, 20000) }))
    : [];
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const s = m.stats && typeof m.stats === 'object' ? m.stats : null;
  return {
    id: uid(),
    role: m.role,
    content,
    reasoning: typeof m.reasoning === 'string' ? m.reasoning : '',
    images,
    files,
    tools,
    stats: s ? { genTps: num(s.genTps), genN: num(s.genN) } : null,
    finish: m.finish === 'length' || m.finish === 'abort' || m.finish === 'stop' ? m.finish : null,
    thinkMs: num(m.thinkMs) || 0,
    edited: m.edited === true,
  };
}

function sanitizeChat(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.messages)) return null;
  const t = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Date.now());
  return {
    id: uid(),
    title: typeof c.title === 'string' && c.title.trim() ? c.title.trim().slice(0, 200) : tx('chat.imported'),
    createdAt: t(c.createdAt),
    updatedAt: t(c.updatedAt),
    system: typeof c.system === 'string' ? c.system : '',
    messages: [], // 発言は呼び出し側が 1 件ずつ確かめて足す (sanitizeChatAsync・restoreChatAsync)
    lastUsage: 0,
    pinned: c.pinned === true,
    folder: typeof c.folder === 'string' ? c.folder.slice(0, 60) : '',
  };
}

async function importFile(file) {
  if (file.size > LIMITS.importBytes) throw new Error(tx('import.tooBig'));
  const data = await Runtime.json(await file.text());
  const list = Array.isArray(data.chats) ? data.chats : [data];
  const chats = [];
  for (let i = 0; i < list.length; i++) {
    const c = await sanitizeChatAsync(list[i]);
    if (c && c.messages.length) chats.push(c);
    if (i % 10 === 0) await Runtime.yieldTask();
  }
  if (chats.length === 0) throw new Error(tx('import.none'));
  for (const c of chats) {
    state.chats.set(c.id, c);
    markDirty(c);

  }
  // 同じ名前のプロジェクトがあれば、今あるものを優先する
  for (const raw of Array.isArray(data.projects) ? data.projects : []) {
    const p = sanitizeProject(raw);
    if (p && !state.projects.has(p.name)) {
      state.projects.set(p.name, p); markProjectsDirty();
    }
  }
  // 生成・画像処理の最中は、開いている会話を切り替えない (回答の表示先がずれる)。一覧に足すだけにする
  if (isBusy()) renderSidebar();
  else openChat(chats[0].id); // 新しい会話なのでサイドバーも描き直す
}

async function sanitizeChatAsync(raw) {
  if (!raw || !Array.isArray(raw.messages)) return null;
  const chat = sanitizeChat({ ...raw, messages: [] });
  if (!chat) return null;
  const list = raw.messages.slice(0, 10000);
  for (let i = 0; i < list.length; i++) {
    const m = sanitizeMessage(list[i]);
    if (m && (m.content || m.reasoning || m.images.length || m.files.length)) chat.messages.push(m);
    if (i % 100 === 99) await Runtime.yieldTask();
  }
  return chat;
}

// 書き出す写しから、保存した画像の参照 (このPCでしか意味がない) を外す。外した数を返す
function dropImageRefs(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 100) return 0;
  const isRef = (v) => typeof v === 'string' && v.startsWith(IMG_REF);
  let n = 0;
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      if (isRef(node[i])) { node.splice(i, 1); n++; } else n += dropImageRefs(node[i], depth + 1);
    }
  } else {
    for (const k of Object.keys(node)) {
      if (isRef(node[k])) { delete node[k]; n++; } else n += dropImageRefs(node[k], depth + 1);
    }
  }
  return n;
}

async function exportChats(chats, name, projects) {
  const parts = ['{"format":"simpllm","version":4,"exportedAt":' + JSON.stringify(new Date().toISOString()) + ',"chats":['];
  let first = true, lost = 0;
  try {
    for (const c of chats) {
      if (!chatCount(c)) continue;
      const wasLazy = c.lazy;
      try {
        await loadChat(c);
        // 保存先から消えた画像 (missing) は取り戻せないので、それだけを理由に書き出し全体を止めない
        if (!(await ensureImages(c))) throw new Error(IMAGES_NOT_READY);
        const copy = { ...historyChatFields(c) };
        delete copy.id;
        if (hasImageRefs(c)) { copy.messages = copyData(c.messages); lost += dropImageRefs(copy.messages); }
        const text = await Runtime.json(copy, true);
        parts.push(new Blob([(first ? '' : ',') + text])); first = false;
        await Runtime.yieldTask();
      } finally {
        releaseChatImages(c);
        if (wasLazy) unloadChat(c);
      }
    }
    parts.push(']');
    if (projects) parts.push(',"projects":' + await Runtime.json(projects.map((p) => ({ name: p.name, system: p.system, files: p.files })), true));
    parts.push('}');
    if (lost) showError(tx('export.lostImages', { count: lost }));
    await download(new Blob(parts, { type: 'application/json' }), 'application/json', name);
  } catch (e) { showError(tx('export.imageLoadFailed') + e.message); }
}

// ---------------------------------------------------------------------------
// 履歴の保存: 受付 (history.ps1) に 1 会話 = 1 ファイルで書く。
// 画像は 1 枚ずつ別に保存し、会話には "simpllm-img:<名前>" だけを書く (保存のたびに画像を送り直さない)。
// 画像の本体は、その会話を開いたときに読み込む。暗号化はしない (軽さ優先)。
// ---------------------------------------------------------------------------

// 変わったものだけを書く: 会話は markDirty (touchChat から呼ぶ)、設定は settings への代入 (Proxy) と markMetaDirty。
// 定期的な見直しはしない (開いている会話を毎回丸ごと JSON にしない)。

const IMG_REF = 'simpllm-img:';
const IMG_REF_RE = /^simpllm-img:[0-9a-f]{64}\.(png|jpg|webp|gif)$/;
const CHAT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const HISTORY_RETRY_MS = 5000; // 受付に届かなかったときの再試行の間隔
const KEEPALIVE_BYTES = 60000; // 閉じる直前の送信は合計 64KB (バイト数) まで
const isStoredImage = (s) => typeof s === 'string' && (SAFE_IMAGE_RE.test(s) || IMG_REF_RE.test(s));
const historyState = {
  enabled: false, // 読み込みが済むまでは書かない (空の状態で上書きしない)
  deleted: new Set(), attributes: new Set(), savingAttributes: new Set(), release: new Set(), unload: new Set(),
  onDisk: new Set(), // 保存してある会話ID (消された会話のファイルを消すため)
  imaged: new Set(), // 保存した内容に画像の参照がある会話ID (消したときだけ画像を片付ける)
  dirty: new Set(), // 書く必要がある会話ID
  saving: new Set(), // 保存処理が完了するまでは、終了時の保存対象にも残す
  savingMeta: false, savingProjects: false,
  frozen: new Map(), // 生成中の会話ID → 送信した時点の写し (閉じても質問は残す)
  rejected: new Map(), // 受付が受け付けなかった会話ID → その内容 (変わるまで送り直さない)
  timer: 0, busy: false, again: false, error: '', loadNote: '',
  refs: new Map(), // data URL → 保存した画像の名前
  urls: new Map(), // 画像の名前 → data URL
  missing: new Set(), // 保存先に無かった画像の名前
  refused: new Set(), // 受付が受け付けなかった画像 (data URL)。会話に埋め込んだまま保存する
  loading: new WeakMap(), // 会話 → 画像の読み込み中の Promise
};

function markDirty(chat, attributesOnly = false) {
  chatOrderCache = null;
  if (chat) {
    if (attributesOnly && historyState.onDisk.has(chat.id) && !historyState.dirty.has(chat.id)) historyState.attributes.add(chat.id);
    else { historyState.dirty.add(chat.id); historyState.attributes.delete(chat.id); }
  }
  scheduleSave();
}

function markMetaDirty() {
  settingsChange.dirty = true;
  scheduleSave();
}

// プロジェクトは設定とは別に保存する (設定の切り替えのたびに、プロジェクトのファイルの全文を書き直さない)
const projectsChange = { dirty: false };
function markProjectsDirty() {
  projectsChange.dirty = true;
  scheduleSave();
}

function scheduleSave(ms = 300) {
  if (!historyState.enabled || state.ended) return;
  if (!historyState.dirty.size && !historyState.deleted.size && !historyState.attributes.size && !settingsChange.dirty && !projectsChange.dirty) return;
  clearTimeout(historyState.timer);
  historyState.timer = setTimeout(flushHistory, ms);
}

// 会話の中の画像 (data URL / 参照) をすべてたどる。fn が値を返したら置き換える
// 会話のデータ (配列・オブジェクト・文字列・数など) の写しを作る。文字列は写さずに共有する:
// structuredClone は画像 (数 MB の data URL) の文字列まで写すので、分岐や編集のたびにその分のメモリが増える
function copyData(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 100) return v;
  if (Array.isArray(v)) return v.map((x) => copyData(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) out[k] = copyData(v[k], depth + 1);
  return out;
}

function eachImage(node, fn, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 100) return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (typeof v === 'string') {
      if (v.startsWith('data:image/') || v.startsWith(IMG_REF)) {
        const r = fn(v);
        if (r !== undefined) node[k] = r;
      }
    } else if (v && typeof v === 'object') eachImage(v, fn, depth + 1);
  }
}

// 条件に合う画像の参照が1つでもあれば true。見つけた時点で探索をやめる
function someImageRef(node, pred, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 100) return false;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (typeof v === 'string') {
      if (v.startsWith(IMG_REF) && pred(v)) return true;
    } else if (v && typeof v === 'object' && someImageRef(v, pred, depth + 1)) return true;
  }
  return false;
}

const historyChatFields = (c) => ({
  id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, system: c.system,
  messages: c.messages, lastUsage: c.lastUsage || 0, pinned: !!c.pinned, folder: c.folder || '',
});
// 保存済みの画像は参照に置き換える。JSON.stringify は改行を含まない 1 行を返す
const historyReplacer = (k, v) => (typeof v === 'string' && v.startsWith('data:image/') && historyState.refs.has(v) ? IMG_REF + historyState.refs.get(v) : v);
const serializeChat = (c) => JSON.stringify(historyChatFields(c), historyReplacer);
const serializeAttributes = (c) => JSON.stringify({ title: c.title, updatedAt: c.updatedAt, pinned: !!c.pinned, folder: c.folder || '' });
const serializeMeta = () => JSON.stringify({ format: 'simpllm-meta', version: 2, settings });
const PROJECTS_FORMAT = 'simpllm-projects';
const serializeProjects = () => JSON.stringify({ format: PROJECTS_FORMAT, version: 1, projects: [...state.projects.values()] });
const utf8Bytes = (s) => new TextEncoder().encode(s).length;

async function historyPost(path, body) {
  const res = await controlFetch('POST', path, body, undefined, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream' });
  try { return await controlJson(res); } catch (e) { e.status = res.status; throw e; }
}

// まだ保存していない画像を送り、名前を覚える (受け付けられなかった画像は会話に埋め込んだまま保存する)
async function uploadImages(node) {
  const fresh = new Set();
  eachImage(node, (v) => { if (v.startsWith('data:image/') && !historyState.refs.has(v) && !historyState.refused.has(v) && SAFE_IMAGE_RE.test(v)) fresh.add(v); });
  for (const url of fresh) {
    try {
      const { name } = await historyPost('/history/image', dataUrlBytes(url));
      if (typeof name === 'string' && IMG_REF_RE.test(IMG_REF + name)) { historyState.refs.set(url, name); historyState.urls.set(name, url); }
    } catch (e) {
      if (e.status !== 400) throw e; // 届かなかったときは、会話ごと後で送り直す
      historyState.refused.add(url); // 受け付けられない画像 (大きすぎる・形式が違う) は、保存のたびに送り直さない
    }
  }
}

// 送信した時点の会話を写しておく。生成中はこれを書く (途中で閉じても、送った質問は残る)。
// pick: 写しに入れるメッセージを差し替える (画像の処理中のカードを「中止」として残すため)
function freezeChat(chat, pick = (x) => x) {
  historyState.frozen.set(chat.id, { ...historyChatFields(chat), messages: chat.messages.map(pick), written: false });
  markDirty(chat);
}

function unfreezeChat(chat) {
  historyState.frozen.delete(chat.id);
  markDirty(chat);
}

async function flushHistory() {
  if (!historyState.enabled || state.ended) return;
  if (historyState.busy) { historyState.again = true; return; }
  historyState.busy = true;
  // 画面を閉じると state が空になる。待っている間に閉じられたら、空の状態で消したり上書きしたりしない
  const alive = () => historyState.enabled && !state.ended;
  const ids = [...historyState.dirty];
  historyState.saving = new Set(ids);
  historyState.dirty.clear();
  let retry = false;
  let removed = false;
  const problems = [];
  const fail = (e, what) => {
    if (e.status === 400) problems.push(tx('history.saveFailed', { what, message: e.message }));
    else { retry = true; problems.push(tx('history.saveRetry', { seconds: HISTORY_RETRY_MS / 1000, message: e.message })); }
  };
  try {
    // 1 件ずつ失敗を分ける (1 件が受け付けられなくても、ほかの会話と設定は書く)
    for (const id of ids) {
      if (!alive()) return;
      const chat = state.chats.get(id);
      if (!chat) continue; // 消された会話は下で消す
      if (chat.lazy) continue; // 本文を読み込んでいない会話は書かない (空の本文として扱うと、下で保存先のファイルを消してしまう)
      let target = chat;
      if (chat === state.generatingChat) {
        historyState.dirty.add(id); // 生成が終わったら書く
        const frozen = historyState.frozen.get(id);
        if (!frozen || frozen.written) continue;
        target = frozen;
      }
      let text = '';
      try {
        if (!target.messages.length) {
          if (historyState.onDisk.has(id)) { await historyPost('/history/chat/delete?id=' + encodeURIComponent(id), '{}'); historyState.onDisk.delete(id); if (historyState.imaged.delete(id)) removed = true; }
          continue;
        }
        await uploadImages(target.messages);
        if (!alive()) return;
        text = serializeChat(target);
        if (historyState.rejected.get(id) === text) continue;
        await historyPost('/history/chat?id=' + encodeURIComponent(id), text);
        historyState.onDisk.add(id);
        // 初めての保存を待つ間に消された会話は、消したときにはまだ保存先に無かったので削除の対象に入っていない。
        // いま書いたファイルを、下の削除で消す (残すと、次回の起動で会話が戻ってくる)
        if (state.chats.get(id) !== chat) historyState.deleted.add(id);
        if (text.includes(IMG_REF)) historyState.imaged.add(id); else if (historyState.imaged.delete(id)) removed = true; // 画像を外した
        historyState.rejected.delete(id);
        if (target !== chat) target.written = true;
      } catch (e) {
        if (e.status === 400) historyState.rejected.set(id, text); else historyState.dirty.add(id);
        fail(e, tx('history.whatChat', { title: chat.title }));
      }
    }
    for (const id of [...historyState.attributes]) {
      if (!alive()) return;
      historyState.attributes.delete(id);
      const chat = state.chats.get(id);
      if (!chat) continue;
      historyState.savingAttributes.add(id);
      try { await historyPost('/history/attributes?id=' + encodeURIComponent(id), serializeAttributes(chat)); }
      catch (e) { if (e.status !== 400) historyState.attributes.add(id); fail(e, tx('history.whatChat', { title: chat.title })); }
      finally { historyState.savingAttributes.delete(id); }
    }
    for (const id of [...historyState.deleted]) {
      if (!alive()) return;
      if (state.chats.has(id)) { historyState.deleted.delete(id); continue; }
      try {
        await historyPost('/history/chat/delete?id=' + encodeURIComponent(id), '{}');
        historyState.onDisk.delete(id);
        historyState.deleted.delete(id);
        if (historyState.imaged.delete(id)) removed = true; // 画像のない会話を消しただけなら、全体を読み直さない
      } catch (e) { fail(e, tx('history.whatDelete')); }
    }
    if (!alive()) return;
    if (settingsChange.dirty) {
      historyState.savingMeta = true;
      settingsChange.dirty = false;
      try { await historyPost('/history/meta', serializeMeta()); } catch (e) {
        if (e.status !== 400) settingsChange.dirty = true;
        fail(e, tx('history.whatSettings'));
      } finally { historyState.savingMeta = false; }
    }
    if (projectsChange.dirty && alive()) {
      historyState.savingProjects = true;
      projectsChange.dirty = false;
      try { await historyPost('/history/projects', serializeProjects()); } catch (e) {
        if (e.status !== 400) projectsChange.dirty = true;
        fail(e, tx('history.whatSettings'));
      } finally { historyState.savingProjects = false; }
    }
    // 消した会話だけが使っていた画像を、すぐに消す (全削除で画像が残らないように)。受付は全会話を読むので、画像のあった会話を消したときだけ
    if (removed && alive()) {
      try {
        const { removed: gone } = await historyPost('/history/prune', '{}');
        for (const name of Array.isArray(gone) ? gone : []) {
          const url = historyState.urls.get(name);
          if (url) historyState.refs.delete(url); // また使われたら送り直す
          historyState.urls.delete(name);
        }
      } catch (e) { fail(e, tx('history.whatPrune')); }
    }
    // 起動時の「読み込めない会話がある」という知らせは、新しい問題が出るまで残す
    setHistoryError(problems[0] || historyState.loadNote);
  } finally {
    historyState.saving.clear();
    historyState.busy = false;
    for (const chat of historyState.release) releaseChatImages(chat);
    for (const chat of historyState.unload) unloadChat(chat);
  }
  if (historyState.again) { historyState.again = false; scheduleSave(0); } else if (retry) scheduleSave(HISTORY_RETRY_MS);
}

// 閉じる直前: 書けていない設定と開いている会話を、送れる大きさなら送る (keepalive は合計 64KB まで)
function flushHistoryOnExit() {
  if (!historyState.enabled || !state.controlPort) return;
  let budget = KEEPALIVE_BYTES;
  const send = (path, text) => {
    if (text.length > budget) return; // バイト数は文字数より少なくならない。送れない大きさの会話を、数えるためだけに変換しない
    const bytes = utf8Bytes(text);
    if (bytes > budget) return;
    budget -= bytes;
    fetch(`http://127.0.0.1:${state.controlPort}${path}`, {
      method: 'POST', body: text, keepalive: true, credentials: 'omit',
      headers: { 'Authorization': `Bearer ${state.apiKey}`, 'Content-Type': 'text/plain; charset=utf-8' },
    }).catch(() => {});
  };
  // 書き残しのある会話の、保存する内容 (生成中は送信した時点の写し)
  const pendingTarget = (chat) => {
    if (!chat || !chat.messages.length) return null;
    const frozen = historyState.frozen.get(chat.id);
    if (chat === state.generatingChat) return frozen && !frozen.written ? frozen : null;
    return historyState.dirty.has(chat.id) || historyState.saving.has(chat.id) ? chat : null;
  };
  // 送れる大きさを明らかに超える会話は、JSON にする前に見切る (本文・添付・未保存の画像の長さの合計は、JSON の長さを超えない)。
  // 閉じる間際に、送れもしない大きな会話を丸ごと JSON にして画面を止めない
  const exceeds = (messages, limit) => {
    let n = 0;
    for (const m of messages) {
      n += (m.content ? m.content.length : 0) + (m.reasoning ? m.reasoning.length : 0);
      for (const f of m.files || []) n += f.text ? f.text.length : 0;
      for (const v of m.images || []) if (typeof v === 'string' && !historyState.refs.has(v)) n += v.length;
      if (n > limit) return true;
    }
    return false;
  };
  const sendChat = (chat) => {
    const target = pendingTarget(chat);
    if (target && !exceeds(target.messages, budget)) send('/history/chat?id=' + encodeURIComponent(chat.id), serializeChat(target));
  };
  // 開いている会話を最優先にし、次に小さな削除と設定、残りの会話は送れる分だけ送る
  const chat = current();
  sendChat(chat);
  for (const id of historyState.deleted) send('/history/chat/delete?id=' + encodeURIComponent(id), '{}');
  for (const id of new Set([...historyState.attributes, ...historyState.savingAttributes])) { const c = state.chats.get(id); if (c) send('/history/attributes?id=' + encodeURIComponent(id), serializeAttributes(c)); }
  if (settingsChange.dirty || historyState.savingMeta) send('/history/meta', serializeMeta());
  if (projectsChange.dirty || historyState.savingProjects) send('/history/projects', serializeProjects());
  for (const id of new Set([...historyState.dirty, ...historyState.saving])) {
    const other = state.chats.get(id);
    if (other && other !== chat) sendChat(other);
  }
}

function setHistoryError(text) {
  if (historyState.error === text) return;
  historyState.error = text;
  updateStorageNote();
}

// ---- 読み込み (ファイルは手で書き換えられうるので、読み込む JSON と同じく検証する) ----

const VARIANT_USER = ['content', 'images', 'files'];
const VARIANT_AI = ['content', 'reasoning', 'stats', 'finish', 'thinkMs', 'tools', 'dropped', 'edited'];

function restoreMessage(raw, depth = 0) {
  const m = sanitizeMessage(raw);
  if (!m) return null;
  if (typeof raw.id === 'string' && raw.id.length <= 64) m.id = raw.id;
  const dropped = Number.isInteger(raw.dropped) && raw.dropped > 0 ? raw.dropped : 0;
  if (dropped) m.dropped = dropped;
  if (m.role !== 'image' && Array.isArray(raw.variants) && raw.variants.length > 1 && depth < 20) {
    const keys = m.role === 'user' ? VARIANT_USER : VARIANT_AI;
    const variants = [];
    for (const v of raw.variants.slice(0, 200)) {
      const s = v && typeof v === 'object' ? sanitizeMessage({ ...v, role: m.role }) : null;
      if (!s) { variants.length = 0; break; }
      const out = {};
      for (const k of keys) if (s[k] !== undefined) out[k] = s[k];
      if (m.role === 'assistant') out.dropped = Number.isInteger(v.dropped) && v.dropped > 0 ? v.dropped : 0;
      if (Array.isArray(v.tail)) out.tail = v.tail.slice(0, 10000).map((t) => restoreMessage(t, depth + 1)).filter(Boolean);
      variants.push(out);
    }
    const vi = raw.vi;
    if (variants.length > 1 && Number.isInteger(vi) && vi >= 0 && vi < variants.length) { m.variants = variants; m.vi = vi; }
  }
  return m;
}

function restoreSummary(raw) {
  if (!raw || typeof raw.id !== 'string' || !CHAT_ID_RE.test(raw.id) || !Number.isInteger(raw.messageCount) || raw.messageCount < 1) return null;
  return { id: raw.id, title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
    createdAt: Number(raw.createdAt) || 0, updatedAt: Number(raw.updatedAt) || 0,
    pinned: !!raw.pinned, folder: typeof raw.folder === 'string' ? raw.folder.slice(0, 60) : '',
    messages: [], system: '', lastUsage: 0, lazy: true, messageCount: raw.messageCount, hasImages: !!raw.hasImages };
}
const chatLoads = new WeakMap();
function loadChat(chat) {
  if (!chat.lazy) return Promise.resolve(chat);
  if (chatLoads.has(chat)) return chatLoads.get(chat);
  const task = (async () => {
    const res = await controlFetch('GET', '/history/chat?id=' + encodeURIComponent(chat.id));
    if (!res.ok) throw new Error(tx('error.status', { status: res.status }));
    const restored = await restoreChatAsync(await Runtime.json(await res.text()));
    if (!restored) throw new Error(tx('history.metaBroken'));
    // Summary attributes may have changed without rewriting the body file.
    const attributes = { title: chat.title, pinned: chat.pinned, folder: chat.folder, updatedAt: chat.updatedAt };
    Object.assign(chat, restored, attributes, { lazy: false });
    return chat;
  })().finally(() => chatLoads.delete(chat));
  chatLoads.set(chat, task);
  return task;
}

function unloadChat(chat) {
  if (!historyState.enabled || !historyState.onDisk.has(chat.id)) { historyState.unload.delete(chat); return; }
  // rejected: 受付に断られた内容は保存先に無い。メモリの本文が唯一の写しなので、手放さない
  if (chat === current() || chat === state.generatingChat || historyState.dirty.has(chat.id) || historyState.saving.has(chat.id) || historyState.rejected.has(chat.id) || historyState.loading.has(chat)) return;
  historyState.unload.delete(chat);
  const summary = { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, pinned: chat.pinned, folder: chat.folder,
    messages: [], system: '', lastUsage: 0, lazy: true, messageCount: chatCount(chat), hasImages: historyState.imaged.has(chat.id) };
  for (const k of Object.keys(chat)) delete chat[k];
  Object.assign(chat, summary);
}

async function runLocalTool(name, args, currentId) {
  if (name !== 'search_conversations') return Tools.run(name, args, { chats: [], currentId }); // 会話を使うのは検索だけ
  let query;
  try { query = JSON.parse(args || '{}').query || ''; } catch { return Tools.run(name, args, { chats: [], currentId }); }
  let ids = null;
  if (hasLazyChat()) {
    const data = await controlRequest('GET', '/history/search?words=1&q=' + encodeURIComponent(String(query).slice(0, 1000)), undefined, state.controller?.signal);
    ids = new Set(data.ids || []);
  }
  const loaded = [];
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  let hits = 0;
  try {
    const candidates = [];
    for (const c of state.chats.values()) {
      if (c.id === currentId || (c.lazy && !ids?.has(c.id))) continue;
      if (c.lazy) { await loadChat(c); loaded.push(c); }
      candidates.push(c);
      for (const m of c.messages) if (m.role !== 'image' && words.every((w) => m.content.toLowerCase().includes(w))) { if (++hits >= 8) break; }
      if (hits >= 8) break;
    }
    return Tools.run(name, args, { chats: candidates, currentId });
  } finally { for (const c of loaded) unloadChat(c); }
}

async function restoreChatAsync(raw) {
  const chat = restoreChat(raw, false);
  if (!chat) return null;
  const list = Array.isArray(raw.messages) ? raw.messages.slice(0, 10000) : [];
  for (let i = 0; i < list.length; i++) {
    const m = restoreMessage(list[i]);
    if (m && (m.content || m.reasoning || m.images.length || m.files.length || m.role === 'image' || m.variants)) chat.messages.push(m);
    if (i % 100 === 99) await Runtime.yieldTask();
  }
  return chat.messages.length ? chat : null;
}

function restoreChat(raw, body = true) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !CHAT_ID_RE.test(raw.id)) return null;
  const chat = sanitizeChat({ ...raw, messages: [] });
  if (!chat) return null;
  chat.id = raw.id;
  if (typeof raw.title === 'string' && raw.title.trim()) chat.title = raw.title.trim().slice(0, 200);
  if (body) chat.messages = (Array.isArray(raw.messages) ? raw.messages.slice(0, 10000) : []).map((m) => restoreMessage(m))
    .filter((m) => m && (m.content || m.reasoning || m.images.length || m.files.length || m.role === 'image' || m.variants)); // 版の履歴があれば、本文が空でも残す
  chat.lastUsage = Number.isInteger(raw.lastUsage) && raw.lastUsage > 0 ? raw.lastUsage : 0;
  return chat.messages.length || !body ? chat : null;
}

function restoreSettings(saved) {
  if (!saved || typeof saved !== 'object') return;
  // この設定より前から使っている人は、使い慣れたボタンを隠さない
  if (saved.advanced === undefined) saved = { ...saved, advanced: true };
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    const v = saved[k];
    if (k === 'prompts') {
      if (Array.isArray(v)) settings.prompts = v.filter((p) => p && typeof p.name === 'string' && typeof p.text === 'string').slice(0, 500).map((p) => ({ name: p.name.slice(0, 60), text: p.text }));
    } else if (k === 'collapsed') {
      if (Array.isArray(v)) settings.collapsed = v.filter((x) => typeof x === 'string').slice(0, 1000);
    } else if (k === 'imageModels') {
      if (v && typeof v === 'object') settings.imageModels = Object.fromEntries(Object.entries(v).filter(([a, b]) => typeof a === 'string' && typeof b === 'string').slice(0, 20));
    } else if (k === 'seed') {
      if (typeof v === 'string' || typeof v === 'number') settings.seed = String(v);
    } else if (PARAMS.includes(k)) {
      if (v === '' || (typeof v === 'number' && Number.isFinite(v))) settings[k] = v; // 空欄 (自動) か数
    } else if (typeof v === typeof def && (typeof v !== 'number' || Number.isFinite(v))) settings[k] = v;
  }
}

async function loadHistory() {
  if (!state.controlPort || !state.apiKey) { historyState.error = 'off'; return; }
  // 読めないまま書くと、保存済みの履歴を上書きしてしまう。読めなかったときは、この画面では保存しない
  const refuse = (why) => {
    state.chats.clear(); state.projects.clear(); // 読みかけの状態は使わない (あとで消したと誤って扱わない)
    historyState.error = tx('history.loadFailed') + why;
  };
  try {
    const res = await controlFetch('GET', '/history?view=index');
    if (!res.ok) {
      let why = tx('error.status', { status: res.status });
      try { why = (await res.json()).error || why; } catch { /* 下で表示 */ }
      refuse(why);
      return;
    }
    const lines = (await res.text()).split('\n');
    let meta = null;
    if (lines[0] !== 'null') { // 設定のファイルがあるのに読めないなら、保存しない (初期値で上書きしない)
      try { meta = await Runtime.json(lines[0]); } catch { /* 下で扱う */ }
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) { refuse(tx('history.metaBroken')); return; }
      restoreSettings(meta.settings);
    }
    const addProjects = (list) => {
      for (const raw of Array.isArray(list) ? list : []) {
        const p = sanitizeProject(raw);
        if (p && !state.projects.has(p.name)) state.projects.set(p.name, p);
      }
    };
    let broken = 0;
    let projectsOnDisk = false;
    let lineNo = 0;
    for (const line of lines.slice(1)) {
      if (++lineNo % 100 === 0) await Runtime.yieldTask();
      let chat = null;
      try {
        const data = await Runtime.json(line);
        if (data && data.format === PROJECTS_FORMAT) { addProjects(data.projects); projectsOnDisk = true; continue; } // プロジェクトの行 (会話ではない)
        chat = data && data.format === 'simpllm-chat-summary' ? restoreSummary(data) : restoreChat(data);
      } catch { /* 壊れた会話は飛ばす (ファイルはそのまま残る) */ }
      if (!chat) { broken++; continue; }
      state.chats.set(chat.id, chat);
      historyState.onDisk.add(chat.id);
      if (chat.hasImages || line.includes(IMG_REF)) historyState.imaged.add(chat.id);
    }
    settingsChange.dirty = false; // 読み込んだだけの設定は書き直さない
    // 以前は設定のファイルにプロジェクトも入れていた。プロジェクトのファイルがまだ無ければ、そこから引き継いで書き出す
    const legacyProjects = !projectsOnDisk && meta && Array.isArray(meta.projects) && meta.projects.length > 0;
    if (legacyProjects) addProjects(meta.projects);
    projectsChange.dirty = !!legacyProjects;
    historyState.enabled = true;
    if (legacyProjects) scheduleSave();
    historyState.loadNote = broken ? tx('history.brokenChats', { count: broken }) : '';
    historyState.error = historyState.loadNote;
  } catch (e) {
    refuse(e.message);
  }
}

// 表示用と送信・書き出し用の読み込みが重なっても、全体で最大4枚。同じ画像の要求は共有する。
const IMAGE_LOAD_CONCURRENCY = 4;
const imageLoads = new Map();
const imageLoadQueue = [];
let imageLoadActive = 0;
function pumpImageLoads() {
  while (imageLoadActive < IMAGE_LOAD_CONCURRENCY && imageLoadQueue.length) {
    const task = imageLoadQueue.shift();
    imageLoadActive++;
    task().finally(() => { imageLoadActive--; pumpImageLoads(); });
  }
}

function loadStoredImage(name) {
  if (imageLoads.has(name)) return imageLoads.get(name);
  const pending = new Promise((resolve) => {
    imageLoadQueue.push(async () => {
      try {
        if (state.ended || historyState.urls.has(name) || historyState.missing.has(name)) return;
        const res = await controlFetch('GET', '/history/image?name=' + encodeURIComponent(name));
        if (state.ended) return;
        if (res.status === 404) { historyState.missing.add(name); return; }
        if (!res.ok) return; // 一時的な失敗は、次の操作で再試行する
        const url = await blobToDataUrl(await res.blob());
        if (state.ended) return;
        if (!SAFE_IMAGE_RE.test(url)) { historyState.missing.add(name); return; }
        historyState.urls.set(name, url);
        historyState.refs.set(url, name);
      } catch { /* 一時的な失敗 */ }
      finally { imageLoads.delete(name); resolve(); }
    });
  });
  imageLoads.set(name, pending);
  pumpImageLoads();
  return pending;
}

// nodes を指定すると、その範囲だけを読み込む。送信・書き出しでは版の履歴も含めて読み込む。
async function hydrateChat(chat, nodes = chat.messages) {
  const names = new Set();
  eachImage(nodes, (v) => {
    const name = v.startsWith(IMG_REF) ? v.slice(IMG_REF.length) : '';
    if (name && !historyState.urls.has(name) && !historyState.missing.has(name) && IMG_REF_RE.test(v)) names.add(name);
  });
  await Promise.all([...names].map(loadStoredImage));
  let changed = false;
  eachImage(nodes, (v) => {
    if (!v.startsWith(IMG_REF)) return undefined;
    const url = historyState.urls.get(v.slice(IMG_REF.length));
    if (url) { changed = true; return url; }
    return undefined;
  });
  return changed;
}

// 処理ごとに最後に選んだ画像モデルを覚える。同じなら設定を書き換えない (書き換えると、設定とプロジェクトの全文を保存し直すことになる)
function rememberImageModel(mode, id) {
  if (settings.imageModels && settings.imageModels[mode] === id) return;
  settings.imageModels = { ...(settings.imageModels || {}), [mode]: id };
}

// 開いていない会話の画像を手放す: 表示のために読み込んだ画像 (data URL) を、保存してある名前の参照に戻し、覚えていた本体も捨てる。
// 何もしないと、その画面で 1 度でも表示した画像がすべて、閉じるまでメモリに残る。また開けば保存先から読み直す。
// 保存していない画面・保存が済んでいない会話・生成中の会話・読み込み中の会話は触らない
function releaseChatImages(chat) {
  if (!chat || !historyState.enabled || state.ended || chat === current() || chat === state.generatingChat) return;
  if (historyState.dirty.has(chat.id) || historyState.saving.has(chat.id) || historyState.frozen.has(chat.id) || historyState.loading.has(chat)) { historyState.release.add(chat); return; }
  historyState.release.delete(chat);
  if (historyState.rejected.has(chat.id)) return; // 断られた内容は保存先に無い (画像の参照に戻すと、片付けで本体が消えうる)
  const names = new Set();
  eachImage(chat.messages, (v) => {
    const name = v.startsWith('data:image/') ? historyState.refs.get(v) : undefined;
    if (!name) return undefined; // 保存していない画像は、そのまま持っておく
    names.add(name);
    return IMG_REF + name;
  });
  // 開いている会話・生成中の会話が同じ画像を持っていれば、名前との対応は残す
  // (分岐した会話は元と同じ画像を持つ。対応を捨てると、次の保存でその画像を全部送り直すことになる)
  const keep = new Set();
  for (const other of new Set([current(), state.generatingChat])) {
    if (!other || other === chat) continue;
    eachImage(other.messages, (v) => { const name = v.startsWith('data:image/') ? historyState.refs.get(v) : undefined; if (name) keep.add(name); });
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    const url = historyState.urls.get(name);
    historyState.urls.delete(name);
    if (url) historyState.refs.delete(url); // ほかの会話がまだ本体を持っていても、保存のときに送り直せば同じ名前が返る
  }
}

function hydrateVisibleImages(chat) {
  // 非表示の古い発言・別の版は、表示や送信が必要になるまで読み込まない。
  const nodes = chat.messages.slice(-state.visible).map((m) => ({ images: m.images, gen: m.gen }));
  if (!someImageRef(nodes, () => true)) return; // 保存先から読む画像が無ければ、表示中の画像を調べ直さない
  hydrateChat(chat, nodes).then(() => {
    if (!state.ended && current() === chat) showLoadedImages(chat);
  }).catch(() => {});
}

const hasImageRefs = (chat) => someImageRef(chat.messages, () => true);

// 保存した画像を使う前に読み込み終える。保存先に無い画像 (missing) は省いてよいものとして扱う。
// 一時的に読めなかった画像が残っていれば false
function ensureImages(chat, nodes = chat.messages) {
  if (!nodes || typeof nodes !== 'object') nodes = chat.messages;
  if (nodes !== chat.messages) return hydrateChat(chat, nodes).then(() => !someImageRef(nodes, (v) => !historyState.missing.has(v.slice(IMG_REF.length))));
  if (!hasImageRefs(chat)) return Promise.resolve(true);
  let p = historyState.loading.get(chat);
  if (!p) {
    p = hydrateChat(chat).finally(() => { historyState.loading.delete(chat); if (historyState.release.has(chat)) releaseChatImages(chat); });
    historyState.loading.set(chat, p);
  }
  return p.then(() => !someImageRef(chat.messages, (v) => !historyState.missing.has(v.slice(IMG_REF.length))));
}

const isStoredImageReady = (s) => !s || SAFE_IMAGE_RE.test(s);

// 保存した画像の参照は src に入れない (CSP で拒否される)。読み込めたら showLoadedImages が入れる
function setImageSrc(img, src) {
  if (typeof src === 'string' && src.startsWith(IMG_REF)) img.dataset.ref = src;
  else img.src = src;
}

function showLoadedImages(chat) {
  for (const m of chat.messages) {
    const view = state.views.get(m);
    if (!view || !view.wrap) continue;
    for (const img of view.wrap.querySelectorAll('img')) {
      const ref = img.dataset.ref;
      const url = ref && historyState.urls.get(ref.slice(IMG_REF.length));
      if (!url) continue;
      img.src = url;
      delete img.dataset.ref;
    }
  }
}
const IMAGES_NOT_READY =tx('image.notReady');

// 画像を使う操作 (保存・元に編集) は、読み込み終えてから行う
function withImages(chat, m, fn) {
  ensureImages(chat, [m]).then((ok) => { if (ok) fn(); else showError(IMAGES_NOT_READY); }).catch(() => showError(IMAGES_NOT_READY));
}

function chatToMarkdown(chat) {
  const out = [`# ${chat.title}`, ''];
  if (chat.system.trim()) out.push(tx('export.md.system'), '> ' + chat.system.replace(/\n/g, '\n> '), '');
  for (const m of chat.messages) {
    if (m.role === 'image') {
      const g = m.gen || {};
      out.push(tx(g.mode === 'edit' ? 'export.md.imageEdit' : 'export.md.imageGenerate'), '', m.content, '');
      if (g.prompt && g.prompt !== m.content) out.push(tx('export.md.translated', { prompt: g.prompt }), '');
      out.push(tx('export.md.imageMeta', { w: g.w, h: g.h, seed: g.seed, extra: m.images.length ? '' : tx('export.md.noImage') }), '');
      continue;
    }
    out.push(m.role === 'user' ? tx('export.md.you') : '## AI', '');
    for (const f of m.files) out.push(tx('export.md.file', { name: f.name }), '');
    if (m.images.length) out.push(tx('export.md.images', { count: m.images.length }), '');
    for (const t of m.tools || []) out.push(tx('export.md.tool', { name: t.name, args: t.args, result: t.result.replace(/\n/g, ' ').slice(0, 200) }), '');
    out.push(m.content, '');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// サーバーの状態 (モデルの読み込みは UI が指示し、終わるまで定期的に確認する)
// ---------------------------------------------------------------------------

let serverTimer = 0;
let serverCheck = 0;

// サーバーが知っているモデルに、フォルダに置いたばかりのモデル (受付が調べたもの) を「新規」として足す
function renderModels(models) {
  if (models) state.serverModels = models.map((m) => m.id);
  const serverIds = new Set(state.serverModels);
  const inv = state.inventory ? chatLabels(state.inventory.chat).filter((c) => c.id) : [];
  const known = new Map(inv.map((c) => [c.id, c]));
  const usable = (id) => !known.has(id) || known.get(id).state === 'ok';
  const options = state.serverModels.filter(usable).map((id) => [id, known.has(id) ? known.get(id).label : id]);
  for (const c of inv) if (c.state === 'ok' && !serverIds.has(c.id)) options.push([c.id, tx('models.newLabel', { label: c.label })]);
  const sig = options.map((o) => o.join('\t')).join('\n');
  if (els.modelSelect.dataset.sig !== sig) {
    const value = els.modelSelect.value;
    els.modelSelect.replaceChildren(...options.map(([id, label]) => { const o = el('option', '', label); o.value = id; o.title = id; return o; }));
    els.modelSelect.dataset.sig = sig;
    if (options.some((o) => o[0] === value)) els.modelSelect.value = value;
  }
  els.modelSelect.hidden = options.length < 2;
}

// 受付にフォルダを調べてもらう (先頭だけ読むので軽い。ウィンドウに戻ったときや設定を開いたときに呼ぶ)
let inventorySignature = '';
let inventoryVersion = 0;
const loadInventory = Runtime.refresh(async () => {
  const version = inventoryVersion;
  const inv = await controlRequest('GET', '/models/inventory');
  if (state.ended || version !== inventoryVersion) return;
  const signature = JSON.stringify(inv);
  state.inventory = inv;
  if (signature !== inventorySignature) {
    inventorySignature = signature;
    renderModels(); renderModelList(); renderModelFeatures();
  }
});
function refreshInventory(force = false) {
  if (state.ended || !state.controlPort || !state.apiKey) return Promise.resolve();
  return loadInventory(force).catch(() => {});
}
function clearModelCache() {
  inventoryVersion++;
  loadInventory.clear();
  loadImageStatus.clear();
}

// 中の名前 (general.name) が同じファイルが複数あるときは、ファイル名を添えて見分けられるようにする
function chatLabels(list) {
  const count = new Map();
  for (const c of list) count.set(c.label, (count.get(c.label) || 0) + 1);
  return list.map((c) => (count.get(c.label) > 1 ? { ...c, label: tx('models.labelWithFile', { label: c.label, file: c.file }) } : c));
}

const fmtGB = (bytes) => `${(bytes / 2 ** 30).toFixed(1)}GB`;
const MODEL_MARK = { ok: '✓', partial: '…', missing: '✗', unsupported: '✗' };

function modelRow(mark, title, detail, onEdit) {
  const row = el('div', 'model-row');
  const text = el('div', 'model-text');
  text.append(el('span', 'model-mark', mark), el('span', 'model-name', title));
  if (detail) text.append(el('small', '', detail));
  row.append(text);
  if (onEdit) row.append(button(tx('common.settings'), onEdit, 'pill'));
  return row;
}

function renderModelList() {
  const inv = state.inventory;
  els.modelList.replaceChildren();
  if (!inv) return;
  const frag = document.createDocumentFragment();
  frag.append(el('h4', '', tx('models.chat')));
  if (!inv.chat.length) frag.append(el('p', 'note', tx('common.none')));
  for (const c of chatLabels(inv.chat)) {
    const size = c.bytes ? `${fmtGB(c.bytes)}${c.context ? tx('models.maxContext', { k: Math.round(c.context / 1024) }) : ''}` : '';
    frag.append(modelRow(MODEL_MARK[c.state] || '✗', c.label, [size, c.note, c.entry && c.entry.applyOnSwitch ? tx('models.applyOnSwitch') : ''].filter(Boolean).join(' · '),
      c.entry ? () => openChatModelEditor(c) : null));
  }
  frag.append(el('h4', '', tx('models.image')));
  if (!inv.image.length) frag.append(el('p', 'note', tx('models.imageNone')));
  for (const m of inv.image) {
    const modes = m.modes.map((x) => (x === 'edit' ? tx('image.modeEdit') : tx('image.modeGenerate'))).join(tx('common.listSep'));
    const detail = m.state === 'ok' ? [modes, m.note, m.verified ? '' : tx('models.unverified')].filter(Boolean).join(' · ') : m.problem;
    frag.append(modelRow(MODEL_MARK[m.state] || '✗', m.label, detail, m.entry ? () => openImageModelEditor(m) : null));
  }
  for (const p of inv.problems) frag.append(el('p', 'form-error', `⚠ ${p}`));
  els.modelList.append(frag);
}

// ---- モデルの設定 (model-catalog.json の項目を画面から直す。検証と保存は受付が行う) ----

function quietInput(input) {
  input.autocomplete = 'off';
  input.spellcheck = false;
  return input;
}

function labeled(text, control, help) {
  const label = el('label', 'editor-field');
  label.append(el('span', '', text), control);
  if (help) label.append(el('small', '', help));
  return label;
}

function textInput(value, max) {
  const input = quietInput(el('input'));
  input.type = 'text';
  input.value = value || '';
  if (max) input.maxLength = max;
  return input;
}

function checkbox(text, checked, disabled, why) {
  const label = el('label', 'check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = !!checked;
  input.disabled = !!disabled;
  label.append(input, document.createTextNode(text));
  if (why) label.title = why;
  return { label, input };
}

// 受付の定義 (paramSpec) どおりに入力欄を作る。空欄は「指定しない (sd-cli の既定)」
function paramControl(spec, value) {
  if (spec.type === 'flag') return checkbox(spec.label, value === true || value === 'true');
  let input;
  if (spec.type === 'choice') {
    input = el('select');
    const blank = el('option', '', tx('common.default'));
    blank.value = '';
    input.append(blank, ...spec.options.map((o) => { const op = el('option', '', o); op.value = o; return op; }));
    input.value = value === undefined || value === null ? '' : String(value);
  } else {
    input = quietInput(el('input'));
    input.type = spec.type === 'text' ? 'text' : 'number';
    if (spec.type !== 'text') {
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = spec.type === 'int' ? '1' : '0.01';
    }
    input.placeholder = tx('common.default');
    input.value = value === undefined || value === null ? '' : String(value);
  }
  return { label: labeled(spec.label, input, spec.help), input };
}

function readParam(spec, input) {
  if (spec.type === 'flag') return input.checked ? true : undefined;
  const v = input.value.trim();
  if (v === '') return undefined;
  return spec.type === 'int' || spec.type === 'float' ? Number(v) : v;
}

async function saveCatalog(body, errorEl) {
  errorEl.textContent = '';
  try {
    clearModelCache();
    state.inventory = await controlRequest('POST', '/models/catalog', body);
    inventorySignature = JSON.stringify(state.inventory);
    renderModels();
    renderModelList();
    refreshImageStatus(true);
    closeModelEditor();
  } catch (e) {
    errorEl.textContent = e instanceof TypeError ? tx('error.launcher') : e.message;
  }
}

function openModelEditorShell(title) {
  $('model-editor-title').textContent = title;
  const body = $('model-editor-body');
  body.replaceChildren();
  $('model-editor').hidden = false;
  return body;
}

function closeModelEditor() {
  $('model-editor').hidden = true;
  $('model-editor-body').replaceChildren();
}

function editorButtons(onSave, onDelete, deleteLabel) {
  const error = el('p', 'form-error');
  const row = el('div', 'row-btns');
  const save = button(tx('common.save'), () => onSave(error));
  row.append(save);
  if (onDelete) {
    const del = button(deleteLabel || tx('editor.delete'));
    del.className = 'danger';
    del.addEventListener('click', armed(del, () => onDelete(error), tx('common.pressAgainDelete')));
    row.append(del);
  }
  row.append(button(tx('common.cancel'), closeModelEditor));
  const section = el('section');
  section.append(error, row);
  return section;
}

const MAIN_IMAGE_PARAMS = ['steps', 'cfg-scale', 'sampling-method', 'scheduler'];

function openImageModelEditor(m) {
  const inv = state.inventory;
  const entry = m.entry;
  const body = openModelEditorShell(tx('editor.imageTitle', { label: m.label }));
  const intro = el('section');
  const shared = !entry.folder;
  intro.append(el('p', 'note', entry.source === 'auto'
    ? tx('editor.introAuto')
    : entry.origin === 'models.json'
      ? tx('editor.introModelsJson')
      : entry.origin !== 'user'
        ? tx('editor.introBundled')
        : tx('editor.introUser')));
  const own = checkbox(tx('editor.saveOwn'), shared, !shared, shared ? '' : tx('editor.alreadyOwn'));
  if (shared) {
    intro.append(el('p', 'note', tx('editor.sharedNote', { family: entry.diffusion })), own.label);
  }
  intro.append(el('p', 'note', tx('editor.folderFiles', { dir: m.dir, files: m.kinds.map((k) => inv.kindLabels[k] || k).join(tx('common.comma')) || tx('common.none') })));

  const basics = el('section');
  basics.append(el('h3', '', tx('editor.basics')));
  const label = textInput(entry.label, 80);
  const note = textInput(entry.note, 80);
  const gen = checkbox(tx('editor.useGenerate'), entry.modes.includes('generate'));
  const edit = checkbox(tx('editor.useEdit'), entry.modes.includes('edit'));
  const translate = checkbox(tx('editor.translate'), entry.translate);
  basics.append(labeled(tx('editor.label'), label), labeled(tx('editor.note'), note), gen.label, edit.label);
  basics.append(translate.label);

  const files = el('section');
  files.append(el('h3', '', tx('editor.files')), el('p', 'note', tx('editor.filesNote')));
  const roleInputs = {};
  for (const role of inv.roles) {
    const select = el('select');
    const none = el('option', '', tx('editor.unused'));
    none.value = '';
    select.append(none);
    const kinds = new Set(m.kinds.filter((k) => k.startsWith('text:') || k.startsWith('vae:')));
    const current = entry.files ? entry.files[role.name] : undefined;
    if (current) kinds.add(current);
    for (const k of kinds) { const o = el('option', '', (inv.kindLabels[k] || k) + (m.kinds.includes(k) ? '' : tx('editor.notInFolder'))); o.value = k; select.append(o); }
    select.value = current || '';
    roleInputs[role.name] = select;
    files.append(labeled(role.label, select));
  }

  const params = el('section');
  params.append(el('h3', '', tx('editor.params')), el('p', 'note', tx('editor.paramsNote')));
  // よく直す項目だけを並べ、残りは「詳細」に畳む (値が入っている項目があれば開いておく)
  const grid = el('div', 'editor-grid');
  const moreGrid = el('div', 'editor-grid');
  const more = el('details', 'launch-more');
  more.append(el('summary', '', tx('editor.more')), moreGrid);
  const paramInputs = [];
  for (const spec of inv.paramSpec) {
    const value = entry.params ? entry.params[spec.name] : undefined;
    const control = paramControl(spec, value);
    paramInputs.push([spec, control.input]);
    if (MAIN_IMAGE_PARAMS.includes(spec.name)) grid.append(control.label);
    else {
      moreGrid.append(control.label);
      if (value !== undefined && value !== null && value !== '' && value !== false) more.open = true;
    }
  }
  const negative = quietInput(el('textarea'));
  negative.rows = 3;
  negative.maxLength = 1000;
  negative.value = entry.negative || '';
  const editSteps = quietInput(el('input'));
  editSteps.type = 'number'; editSteps.min = '1'; editSteps.max = '150'; editSteps.step = '1';
  editSteps.placeholder = tx('editor.editStepsPlaceholder');
  editSteps.value = entry.editSteps ?? '';
  params.append(grid, labeled(tx('editor.editSteps'), editSteps), labeled(tx('editor.negative'), negative), more);

  const actions = editorButtons((error) => {
    const modes = [];
    if (gen.input.checked) modes.push('generate');
    if (edit.input.checked) modes.push('edit');
    const filesOut = {};
    for (const [role, select] of Object.entries(roleInputs)) if (select.value) filesOut[role] = select.value;
    const paramsOut = {};
    for (const [spec, input] of paramInputs) { const v = readParam(spec, input); if (v !== undefined) paramsOut[spec.name] = v; }
    const asOwn = shared && own.input.checked;
    const saved = {
      ...entry,
      id: asOwn ? `folder-${m.id}`.slice(0, 64) : entry.id,
      folder: asOwn ? m.dir.split('\\').pop() : entry.folder,
      label: label.value.trim(), note: note.value.trim(), modes, translate: translate.input.checked,
      files: filesOut, params: paramsOut, editSteps: editSteps.value === '' ? null : Number(editSteps.value), negative: negative.value.trim(),
    };
    if (asOwn) saved.match = '';
    saveCatalog({ action: 'save', kind: 'image', entry: saved }, error);
  }, entry.origin !== 'user' ? null : (error) => saveCatalog({ action: 'delete', kind: 'image', key: entry.id }, error), // 同梱の設定は消せない
  entry.source === 'auto' ? tx('editor.deleteAuto') : tx('editor.delete'));
  body.append(intro, basics, files, params, actions);
}

const CHAT_SAMPLING_LABELS = { temperature: tx('sampling.temperature'), top_p: 'top_p', top_k: 'top_k', min_p: 'min_p', presence_penalty: 'presence_penalty', repeat_penalty: 'repeat_penalty' };

function openChatModelEditor(c) {
  const inv = state.inventory;
  const entry = c.entry;
  const body = openModelEditorShell(tx('editor.chatTitle', { label: c.label }));
  const intro = el('section');
  intro.append(el('p', 'note', tx('editor.chatFile', { file: c.file }) + (c.sampling ? tx('editor.chatFileSampling', { sampling: c.sampling }) : '')),
    el('p', 'note', tx('editor.chatLaunchNote')));
  const basics = el('section');
  basics.append(el('h3', '', tx('editor.basics')));
  const label = textInput(entry.label, 80);
  basics.append(labeled(tx('editor.label'), label));
  const sampling = el('section');
  sampling.append(el('h3', '', tx('editor.sampling')), el('p', 'note', tx('editor.samplingNote')));
  const grid = el('div', 'editor-grid');
  const inputs = {};
  for (const key of inv.chatSamplingKeys) {
    const input = quietInput(el('input'));
    input.type = 'number';
    input.step = '0.01';
    input.placeholder = tx('editor.unset');
    const v = entry.sampling ? entry.sampling[key] : undefined;
    input.value = v === undefined || v === null ? '' : String(v);
    inputs[key] = input;
    grid.append(labeled(CHAT_SAMPLING_LABELS[key] || key, input));
  }
  const apply = checkbox(tx('editor.applyOnSwitch'), entry.applyOnSwitch);
  const now = button(tx('editor.applyNow'), () => {
    for (const [key, input] of Object.entries(inputs)) if (input.value.trim() !== '' && PARAMS.includes(key)) $('p-' + key).value = input.value.trim();
    formToSettings();
    flashHint(tx('hint.samplingApplied'));
  }, 'pill');
  sampling.append(grid, apply.label, now);
  const actions = editorButtons((error) => {
    const out = {};
    for (const [key, input] of Object.entries(inputs)) if (input.value.trim() !== '') out[key] = Number(input.value);
    saveCatalog({ action: 'save', kind: 'chat', entry: { file: entry.file, label: label.value.trim(), sampling: out, applyOnSwitch: apply.input.checked } }, error);
  }, entry.origin !== 'user' ? null : (error) => saveCatalog({ action: 'delete', kind: 'chat', key: entry.file }, error), tx('editor.deleteChat'));
  body.append(intro, basics, sampling, actions);
}

// 切り替えたモデルの設定で「切り替え時に適用」がオンなら、推奨値を生成パラメータに入れる (force: ボタンで明示的に入れる)
function applyChatSampling(id, force = false) {
  const c = state.inventory && state.inventory.chat.find((x) => x.id === id);
  if (!c || !c.entry || (!c.entry.applyOnSwitch && !force) || !c.entry.sampling) return;
  let changed = false;
  for (const [key, v] of Object.entries(c.entry.sampling)) {
    if (PARAMS.includes(key) && typeof v === 'number' && Number.isFinite(v)) { settings[key] = v; changed = true; }
  }
  if (changed) { settingsToForm(); flashHint(tx('hint.modelSamplingApplied', { label: c.label })); }
}

// モデルに合わせて、使える機能のボタンだけを出す
// 思考: チャットテンプレートが思考の切り替え (enable_thinking) に対応しているときだけ
// 推奨値: Qwen 公式の値は Qwen 系のときだけ。ほかはモデルのファイルに推奨値が書かれていれば、その値のボタン
function renderModelFeatures() {
  const c = currentChatModel();
  const known = state.server.ok && state.server.thinking !== undefined;
  els.btnThink.hidden = known && !state.server.thinking;
  const qwen = isQwenModel(c);
  for (const b of els.presets.querySelectorAll('[data-qwen]')) {
    b.hidden = !qwen || (known && !state.server.thinking && PRESETS[b.dataset.preset].thinking);
  }
  const sampling = c && c.entry && c.entry.sampling ? Object.keys(c.entry.sampling).filter((k) => PARAMS.includes(k)) : [];
  els.btnModelSampling.hidden = qwen || !sampling.length;
}

// 読み込みに失敗した理由を、起動スクリプトがサーバーのログから判定する (分からなければ空)
async function loadFailureReason() {
  if (!state.controlPort) return '';
  try { return (await controlRequest('GET', '/server/diagnosis')).reason || ''; } catch { return ''; }
}

// 読み込み中の表示。ロゴの明滅だけだと固まったように見えるので、経過秒数と、長いときの一言を添える
// (checkServer が 1 秒ごとに呼ぶので、専用のタイマーは持たない)
let loadingSince = 0;
function showLoadingStatus(restart = false) {
  if (restart || !loadingSince) loadingSince = performance.now();
  const sec = Math.floor((performance.now() - loadingSince) / 1000);
  els.status.textContent = tx('status.loading') + (sec >= 3 ? tx('unit.secondsParen', { n: sec }) : '') + (sec >= 30 ? tx('status.loadingLong') : '');
}

function serverUnavailable(text) {
  loadingSince = 0;
  state.server.ok = false;
  els.status.textContent = text;
  setLoading(false);
}

async function checkServer() {
  const turn = ++serverCheck;
  const stale = () => state.ended || turn !== serverCheck || state.server.restarting || state.image.running;
  clearTimeout(serverTimer);
  if (state.server.restarting || state.image.running) return; // 画像用に空けたGPUへチャットを読み戻さない
  const retry = (ms) => { serverTimer = setTimeout(checkServer, ms); };
  if (!state.apiKey) { serverUnavailable(tx('status.needLauncher')); return; }
  try {
    const res = await fetch('/models', { headers: authHeaders(), credentials: 'omit' });
    if (stale()) return;
    if (res.status === 401) { serverUnavailable(tx('status.apiKey')); return; }
    if (!res.ok) { serverUnavailable(tx('status.serverError', { status: res.status })); retry(5000); return; }
    const models = (await res.json()).data;
    if (stale()) return;
    checkLlamaBuild(); // 待たない (読み込みの確認とは別に進める)
    renderModels(models);
    const want = models.find((m) => m.id === settings.model) || models[0];
    if (!want) { serverUnavailable(tx('status.noModel')); return; }
    els.modelSelect.value = want.id;
    if (want.status.value === 'loaded') {
      const props = await (await fetch(`/props?model=${encodeURIComponent(want.id)}`, { headers: authHeaders(), credentials: 'omit' })).json();
      if (stale()) return;
      state.server.model = want.id;
      state.server.nCtx = props.default_generation_settings.n_ctx || 0;
      state.server.vision = !!(props.modalities && props.modalities.vision);
      state.server.thinking = /enable_thinking/.test(props.chat_template || '');
      state.server.ok = true;
      loadingSince = 0;
      els.status.textContent = '';
      setLoading(false);
      renderModelFeatures();
      renderCtx((current() && current().lastUsage) || 0);
      updateHint();
      countTokens();
      return;
    }
    if (want.status.value === 'unloaded' && !models.some((m) => m.status.value === 'loading')) {
      // 読み込みを指示したのに読み込まれていなければ失敗 (指示し直すと失敗を繰り返すだけ)
      if (state.server.requested === want.id) {
        const reason = await loadFailureReason();
        if (stale()) return;
        serverUnavailable(tx('status.loadFailed'));
        if (reason) showError(tx('error.loadFailed', { reason }));
        return;
      }
      state.server.requested = want.id;
      await fetch('/models/load', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ model: want.id }), credentials: 'omit' });
      if (stale()) return;
    }
    state.server.ok = false;
    showLoadingStatus();
    setLoading(true);
    retry(1000);
  } catch {
    if (stale()) return;
    serverUnavailable(tx('status.offline'));
    retry(5000);
  }
}

// ---- モデルのフォルダ -------------------------------------------------------
// ブラウザはファイルに書けず、サーバーの再起動もできないので、起動スクリプトの受付 (同じ API キーで認証) に頼む

async function controlRequest(method, path, body, signal) {
  return controlJson(await controlFetch(method, path, body === undefined ? undefined : JSON.stringify(body), signal, { 'Content-Type': 'application/json' }));
}

function updateModelDirButtons(busy = false) {
  const blocked = busy || !!state.controller || !!btwState.controller;
  els.btnModelDirApply.disabled = blocked;
  els.btnModelDirBrowse.disabled = blocked;
}

async function loadModelDir() {
  els.modelDirError.textContent = '';
  updateModelDirButtons();
  els.modelDir.disabled = !state.controlPort;
  if (!state.controlPort) {
    els.modelDirNote.textContent = tx('launch.unavailable');
    updateModelDirButtons(true);
    return;
  }
  try {
    const info = await controlRequest('GET', '/model-dir');
    els.modelDir.value = info.path;
    els.modelDir.disabled = info.fixed;
    updateModelDirButtons(info.fixed);
    els.modelDirNote.textContent = info.fixed
      ? tx('modelDir.fixed')
      : tx('modelDir.note');
  } catch {
    els.modelDirNote.textContent = tx('modelDir.failed');
    updateModelDirButtons(true);
  }
}

async function browseModelDir() {
  els.modelDirError.textContent = '';
  updateModelDirButtons(true);
  try {
    const picked = await controlRequest('POST', '/model-dir/browse', { path: els.modelDir.value });
    if (picked.path) els.modelDir.value = picked.path;
  } catch (e) {
    els.modelDirError.textContent = e.message;
  }
  updateModelDirButtons();
}

async function applyModelDir() {
  if (isBusy() || btwState.controller) return;
  els.modelDirError.textContent = '';
  updateModelDirButtons(true);
  // 応答はサーバーの入れ替えが終わってから返る。その間の確認は止める
  state.server.restarting = true;
  state.server.ok = false; // 入れ替えの間に送信させない。失敗したら下の checkServer で元に戻る
  updateSendState();
  clearTimeout(serverTimer);
  try {
    const result = await controlRequest('POST', '/model-dir', { path: els.modelDir.value });
    clearModelCache();
    els.modelDir.value = result.path;
    state.server.requested = '';
    state.server.nCtx = 0;
    state.server.ok = false;
    renderCtx(0);
    showLoadingStatus(true);
    setLoading(true);
    state.server.restarting = false;
    closeSettings();
    refreshInventory(true);
    refreshImageStatus(true);
    checkServer();
  } catch (e) {
    state.server.restarting = false;
    els.modelDirError.textContent = e instanceof TypeError ? tx('error.launcher') : e.message;
    checkServer();
  }
  updateModelDirButtons();
}

async function switchModel() {
  const id = els.modelSelect.value;
  if (!state.serverModels.includes(id)) { // 置いたばかりのモデル: サーバーの一覧を作り直してから読み込む
    if (isBusy() || btwState.controller) return;
    state.server.restarting = true;
    state.server.ok = false;
    clearTimeout(serverTimer);
    els.status.textContent = tx('status.refreshing');
    setLoading(true);
    try {
      await controlRequest('POST', '/models/refresh');
    } catch (e) {
      showError(tx('error.refreshFailed') + (e instanceof TypeError ? tx('error.launcherConnect') : e.message));
    }
    state.server.restarting = false;
  }
  settings.model = id;
  applyChatSampling(id);

  state.server.requested = '';
  state.server.nCtx = 0;
  state.server.ok = false;
  renderCtx(0);
  showLoadingStatus(true);
  setLoading(true);
  checkServer();
}

// ---------------------------------------------------------------------------
// 設定画面
// ---------------------------------------------------------------------------

// ---- 起動設定 (start.ps1 が .run\launch.json に保存し、サーバーを起動し直す) ----
const LAUNCH_NUMBERS = { context: 0, ubatch: 0, fitMarginMiB: 0, moeCacheMiB: 0, cpuMoe: -1 }; // 空欄のときの値 (自動・既定)
const LAUNCH_KEYS = ['vision', ...Object.keys(LAUNCH_NUMBERS), 'tensorSplit', 'loadMode', 'cacheType'];
let launchDefaults = null;

function fillLaunch(v) {
  $('l-vision').checked = !!v.vision;
  for (const [k, auto] of Object.entries(LAUNCH_NUMBERS)) $('l-' + k).value = v[k] === auto ? '' : String(v[k]);
  $('l-tensorSplit').value = v.tensorSplit || '';
  $('l-loadMode').value = v.loadMode || 'auto';
  $('l-cacheType').value = v.cacheType || '';
}

// 画面の値を送る形にする。数でない値は、自動に読み替えずに知らせる
function readLaunch() {
  const out = { vision: $('l-vision').checked };
  for (const [k, auto] of Object.entries(LAUNCH_NUMBERS)) {
    const input = $('l-' + k);
    const text = input.value.trim();
    const n = text === '' ? auto : Number(text);
    if (!Number.isInteger(n)) throw new Error(tx('launch.integer', { name: input.parentNode.firstChild.textContent }));
    out[k] = n;
  }
  out.tensorSplit = $('l-tensorSplit').value.trim();
  out.loadMode = $('l-loadMode').value;
  out.cacheType = $('l-cacheType').value;
  return out;
}

function setLaunchButtons(busy) {
  const blocked = busy || !state.controlPort || isBusy() || !!btwState.controller;
  els.btnLaunchApply.disabled = blocked;
  els.btnLaunchReset.disabled = blocked || !launchDefaults;
}

async function loadLaunch() {
  els.launchError.textContent = '';
  setLaunchButtons(false);
  if (!state.controlPort) { els.launchNote.textContent = tx('launch.unavailable'); return; }
  try {
    const info = await controlRequest('GET', '/launch');
    launchDefaults = info.defaults;
    fillLaunch(info.saved);
    const fixed = info.fixed || [];
    for (const k of LAUNCH_KEYS) $('l-' + k).disabled = fixed.includes(k);
    els.launchNote.textContent = fixed.length ? tx('launch.fixedNote') : '';
  } catch (e) {
    els.launchError.textContent = e instanceof TypeError ? tx('error.launcher') : e.message;
  }
  setLaunchButtons(false);
}

async function applyLaunch(reset = false) {
  if (isBusy() || btwState.controller) return;
  els.launchError.textContent = '';
  let body;
  try { body = reset ? launchDefaults : readLaunch(); } catch (e) { els.launchError.textContent = e.message; return; }
  if (!body) return;
  setLaunchButtons(true);
  // 応答はサーバーの入れ替えが終わってから返る。その間の確認は止める (モデルのフォルダの適用と同じ)
  state.server.restarting = true;
  state.server.ok = false;
  updateSendState();
  clearTimeout(serverTimer);
  try {
    const info = await controlRequest('POST', '/launch', body);
    fillLaunch(info.saved);
    clearModelCache();
    state.server.requested = '';
    state.server.nCtx = 0;
    state.server.thinking = undefined;
    renderCtx(0);
    showLoadingStatus(true);
    setLoading(true);
    state.server.restarting = false;
    closeSettings();
    checkServer();
  } catch (e) {
    state.server.restarting = false;
    els.launchError.textContent = e instanceof TypeError ? tx('error.launcher') : e.message;
    checkServer();
  }
  setLaunchButtons(false);
}

// 表示言語を変える。文言は読み込み時に決まるので、覚えてから画面を読み込み直す (会話は保存済み)。
// 起動スクリプトにも伝えて、次回の起動と、起動スクリプトが出す文言 (エラーなど) に使う
let languageChanging = false; // 切り替えの途中 (受付への知らせと保存を待っている間) は、もう一度選べないようにする
let languageConfirm = { code: '', until: 0 }; // 会話が消える切り替えは、同じ言語を続けて 2 回選んだときだけ行う
async function changeLanguage() {
  const code = els.language.value;
  if (code === I18n.lang || languageChanging) return;
  const refuse = (text) => { els.language.value = I18n.lang; els.languageNote.textContent = text; els.languageNote.className = 'form-error'; };
  if (isBusy() || btwState.controller) { refuse(tx('settings.languageBusy')); return; }
  // 履歴を保存していない画面 (-NoBrowser など) では、読み込み直すと会話が消える
  if (!historyState.enabled && [...state.chats.values()].some((c) => c.messages.length)) {
    if (languageConfirm.code !== code || Date.now() > languageConfirm.until) {
      languageConfirm = { code, until: Date.now() + 20000 };
      refuse(tx('settings.languageLosesChats'));
      return;
    }
  }
  if (!I18n.remember(code)) { els.language.value = I18n.lang; return; }
  languageChanging = true;
  els.language.disabled = true;
  closeSettings(); // 設定画面で書き換えた内容 (システムプロンプトを含む) を確定する
  if (state.controlPort) { try { await controlRequest('POST', '/language', { lang: code }); } catch { /* この画面だけ切り替える */ } }
  // 書きかけの保存を済ませてから読み込み直す (閉じるときの保存は大きい会話を送れない)。保存できないままなら 3 秒で進む
  const deadline = Date.now() + 3000;
  while (historyState.enabled && (historyState.busy || historyState.dirty.size || settingsChange.dirty || projectsChange.dirty) && Date.now() < deadline) {
    await flushHistory();
    if (historyState.busy) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  location.reload();
}

function applyAdvanced() {
  document.body.classList.toggle('advanced', !!settings.advanced);
  renderCtx(ctxUsed);
  countTokens();
}

// 設定画面は、左の項目から 1 つを選んで右に表示する。最後に開いていた項目を覚えておく (この画面を開いている間だけ)
let settingsPane = 'general';
function showSettingsPane(name) {
  const panes = [...els.settingsPanes.children];
  if (!panes.some((p) => p.dataset.pane === name)) name = 'general';
  settingsPane = name;
  for (const p of panes) p.hidden = p.dataset.pane !== name;
  for (const b of els.settingsNav.children) {
    const on = b.dataset.pane === name;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  els.settingsPanes.scrollTop = 0;
  loadSettingsPane(name);
}

// 開いた項目に出すものだけを、受付に問い合わせる (設定画面を開くたびに 4 つとも問い合わせない)
function loadSettingsPane(name) {
  if (name === 'models') { loadModelDir(); refreshInventory(); refreshImageStatus(); }
  else if (name === 'launch') loadLaunch();
  else if (name === 'image') refreshImageStatus();
  else if (name === 'about') renderAbout();
}

// 動作を確かめた llama.cpp の版 (README の b11669 と合わせる)。これより古いと、使う引数や API が無いことがある
const LLAMA_TESTED_BUILD = 11669;
// 使っている llama.cpp の版。サーバーの /props の build_info ("b11669-620d2225c") から 1 度だけ読む
// (起動を遅くしないよう、llama-server --version は使わない)。null: まだ読めていない
let llamaBuild = null;
let llamaBuildRequest = null;
function checkLlamaBuild() {
  if (llamaBuild || llamaBuildRequest || !state.apiKey) return;
  llamaBuildRequest = (async () => {
    try {
      const res = await fetch('/props', { headers: authHeaders(), credentials: 'omit' });
      if (!res.ok) return;
      const text = String((await res.json()).build_info || '');
      const m = /^b(\d+)/.exec(text);
      llamaBuild = { text, number: m ? Number(m[1]) : 0 };
    } catch { return; } // 次にサーバーを確かめたときに読み直す
    finally { llamaBuildRequest = null; }
    renderAbout();
    if (llamaBuild.number && llamaBuild.number < LLAMA_TESTED_BUILD) showError(llamaOldText());
  })();
}

const llamaOldText = () => tx('about.llamaOld', { build: `b${llamaBuild.number}`, tested: `b${LLAMA_TESTED_BUILD}` });

function renderAbout() {
  els.aboutLlama.textContent = llamaBuild ? (llamaBuild.text || '?') : tx('about.llamaUnknown');
  els.aboutLlamaTested.textContent = tx('about.llamaTested', { build: `b${LLAMA_TESTED_BUILD}` });
  const old = !!(llamaBuild && llamaBuild.number && llamaBuild.number < LLAMA_TESTED_BUILD);
  els.aboutLlamaOld.hidden = !old;
  els.aboutLlamaOld.textContent = old ? llamaOldText() : '';
}

// pane: 開く項目の名前 (ボタンから呼ばれたときはイベントが渡るので、文字列のときだけ使う)
function openSettings(pane) {
  els.systemPrompt.value = current().system;
  renderPromptLib();
  showSettingsPane(typeof pane === 'string' ? pane : settingsPane);
  els.settings.hidden = false;
}

function closeSettings() {
  formToSettings();
  const chat = current();
  if (chat.system !== els.systemPrompt.value) {
    chat.system = els.systemPrompt.value;
    settings.system = chat.system; // この画面で新しく作るチャットへ引き継ぐ
    touchChat(chat);
  }
  els.settings.hidden = true;
}

// ---------------------------------------------------------------------------
// 画像の生成・編集
// 起動スクリプトの受付 (同じ API キーで認証) が sd-cli を 1 回ずつ動かす。
// 画像の依頼と結果は role: 'image' の 1 件として会話に残すが、AI に送る履歴には入れない (isChatTurn で除く)。
// 例外: 日本語の生成指示は、英訳のためだけに今の履歴の後ろへ付けてチャットのモデルに送る (履歴が同じなのでキャッシュは崩れない)
// ---------------------------------------------------------------------------

const IMAGE_SIZES = { square: [1024, 1024], landscape: [1216, 832], portrait: [832, 1216] };
const IMAGE_POLL_MS = 600;
const IMAGE_TRANSLATE_PROMPT = 'Rewrite the image request below as one concise English prompt for an image generation model. Keep every requested detail and add nothing. Reply with only the English prompt on a single line: no quotes, no notes, and no words left in the original language.';
const isChatTurn = (m) => m.role === 'user' || m.role === 'assistant';
const hasNonAscii = (s) => /[^\x00-\x7F]/.test(s);
// 英訳が要る指示か。英字だけでも英語とは限らない言語 (ドイツ語など) では、いつも英訳する
const needsEnglish = (s) => hasNonAscii(s) || tx('meta.asciiIsEnglish') !== 'yes';
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] % 2147483648;

function pause(ms, signal) { return Runtime.wait(ms, signal); }

function sanitizeImageMessage(m) {
  const g = m.gen && typeof m.gen === 'object' ? m.gen : {};
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  const w = int(g.w, 64, 4096);
  const h = int(g.h, 64, 4096);
  if (typeof m.content !== 'string' || (g.mode !== 'generate' && g.mode !== 'edit') || !w || !h) return null;
  const images = (Array.isArray(m.images) ? m.images : []).filter((s) => isStoredImage(s)).slice(0, 1);
  return {
    id: uid(), role: 'image', content: m.content.slice(0, 4000), images, files: [],
    gen: {
      mode: g.mode, w, h, seed: int(g.seed, 0, 2147483647) ?? 0,
      prompt: typeof g.prompt === 'string' ? g.prompt.slice(0, 4000) : '',
      source: isStoredImage(g.source) ? g.source : undefined,
      ms: typeof g.ms === 'number' && Number.isFinite(g.ms) ? g.ms : undefined,
      error: typeof g.error === 'string' ? g.error.slice(0, 2000) : undefined,
      cancelled: g.cancelled === true || undefined,
      unsaved: g.unsaved === true || undefined,
      model: typeof g.model === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(g.model) ? g.model : undefined,
      modelLabel: typeof g.modelLabel === 'string' ? g.modelLabel.slice(0, 80) : undefined,
      translate: typeof g.translate === 'boolean' ? g.translate : undefined,
    },
  };
}

// ---- 受付との通信 ----

function controlFetch(method, path, body, signal, headers = {}) {
  return fetch(`http://127.0.0.1:${state.controlPort}${path}`, {
    method, body, signal, credentials: 'omit',
    headers: { 'Authorization': `Bearer ${state.apiKey}`, ...headers },
  });
}

async function controlJson(res) {
  let data = {};
  try { data = await res.json(); } catch { /* 下で扱う */ }
  if (!res.ok) throw new Error(data.error || tx('error.status', { status: res.status }));
  return data;
}

function dataUrlBytes(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 本文: [JSON の長さ (4 バイト)][JSON][元画像]。大きな画像を base64 の JSON にしない (受付側の PowerShell が遅い)
function imageJobBody(g) {
  const json = new TextEncoder().encode(JSON.stringify({ mode: g.mode, model: g.model, prompt: g.prompt, width: g.w, height: g.h, seed: g.seed }));
  const image = g.mode === 'edit' ? dataUrlBytes(g.source) : new Uint8Array(0);
  const body = new Uint8Array(4 + json.length + image.length);
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4);
  body.set(image, 4 + json.length);
  return body;
}

const loadImageStatus = Runtime.refresh(() => controlRequest('GET', '/image/status'));
async function refreshImageStatus(force = false) {
  if (state.ended) return;
  const version = inventoryVersion;
  if (!state.controlPort) {
    state.image.status = null;
    state.image.statusError = tx('image.noControl');
  } else {
    try {
      const status = await loadImageStatus(force);
      if (state.ended || version !== inventoryVersion) return;
      state.image.status = status;
      state.image.statusError = '';
    } catch (e) {
      if (state.ended || version !== inventoryVersion) return;
      state.image.status = null;
      state.image.statusError = e instanceof TypeError ? tx('image.launcherConnect') : e.message;
    }
  }
  renderImageStatus();
}

// その処理に使える画像モデル (ファイルが揃っていて、定義がその処理に対応しているもの)
function imageModelsFor(mode) {
  const s = state.image.status;
  return s && s.models ? s.models.filter((m) => m.state === 'ok' && m.modes.includes(mode)) : [];
}

// 選択欄 → 前回選んだもの → 一覧の先頭 の順に決める
function selectedImageModel(mode) {
  const list = imageModelsFor(mode);
  const want = mode === state.image.mode && els.imgModel.value ? els.imgModel.value : (settings.imageModels || {})[mode];
  return list.find((m) => m.id === want) || list[0] || null;
}

function imageReady(mode) {
  const s = state.image.status;
  return !!(state.controlPort && s && s.engine && imageModelsFor(mode).length);
}

function imageUnavailableReason(mode) {
  const s = state.image.status;
  if (!s) return state.image.statusError || tx('common.checking');
  if (!s.engine) return tx('image.noEngine');
  if (imageModelsFor(mode).length) return '';
  if (mode === 'edit') {
    const excluded = (s.models || []).some((m) => m.state === 'ok' && !m.modes.includes('edit'));
    return tx('image.noEditModels') + (excluded ? tx('image.noEditModelsExcluded') : '');
  }
  return tx('image.noGenerateModels');
}

function renderImageStatus() {
  const s = state.image.status;
  const running = !!(state.generatingChat && state.image.running);
  els.imageState.hidden = !state.image.mode && !running;
  // 画像の生成・編集は、エンジンとモデルを用意したときだけ出す (理由は設定の「画像」で見られる)
  els.btnImage.hidden = !state.image.mode && !running && !imageReady('generate') && !imageReady('edit');
  els.imageState.textContent = running ? tx('image.stateRunning') : imageReady('generate') || imageReady('edit') ? tx('image.stateReady') : tx('image.stateUnavailable', { reason: imageUnavailableReason(state.image.mode || 'generate') });
  const mark = (ok) => (ok ? '✓' : '✗');
  els.imageModels.textContent = !s ? tx('image.featureStatus', { status: state.image.statusError || tx('common.checking') }) : [
    tx('image.engineLine', { mark: mark(s.engine) }),
    tx('image.generateModels', { list: imageModelsFor('generate').map((m) => m.label).join(tx('common.comma')) || tx('common.none') }),
    tx('image.editModels', { list: imageModelsFor('edit').map((m) => m.label).join(tx('common.comma')) || tx('common.none') }),
    s.gpu ? tx('image.gpu', { name: s.gpu }) : tx('image.gpuAuto'),
    tx('image.dirs', { dirs: s.dirs ? s.dirs.split('\n').join(' / ') : tx('image.dirsNone') }),
  ].join('\n');
  renderImageModelSelect();
  renderImageNote();
  updateSendState();
}

function renderImageModelSelect() {
  const mode = state.image.mode;
  const list = mode ? imageModelsFor(mode) : [];
  const chosen = mode ? selectedImageModel(mode) : null;
  const sig = list.map((m) => `${m.id}\t${m.label}\t${m.note}`).join('\n');
  if (els.imgModel.dataset.sig !== sig) {
    els.imgModel.replaceChildren(...list.map((m) => { const note = [m.note, m.verified || m.autoNote ? '' : tx('models.unverifiedShort')].filter(Boolean).join(tx('common.listSep')); const o = el('option', '', note ? tx('common.withNote', { label: m.label, note }) : m.label); o.value = m.id; return o; }));
    els.imgModel.dataset.sig = sig;
  }
  if (chosen) els.imgModel.value = chosen.id;
  els.imgModelField.hidden = list.length < 2;
}

function renderImageNote() {
  const mode = state.image.mode;
  if (!mode) return;
  const reason = imageReady(mode) ? '' : imageUnavailableReason(mode);
  const model = selectedImageModel(mode);
  const base = mode === 'edit'
    ? tx('image.noteEdit')
    : model && !model.translate
      ? tx('image.noteNative')
      : settings.imageTranslate !== false
        ? tx('image.noteTranslate')
        : tx('image.noteEnglishOnly');
  els.imgNote.textContent = reason ? tx('image.noteWithReason', { reason, base }) : base;
  els.imgNote.classList.toggle('warn', !!reason);
}

// ---- 画像モードの切り替え ----

function toggleImageMode() {
  if (state.image.mode) closeImageMode();
  else openImageMode('generate');
}

function openImageMode(mode) {
  if (!els.btw.hidden) toggleBtw();
  state.image.mode = mode;
  els.imgbar.hidden = false;
  els.btnImage.classList.add('on');
  applyImageMode();
  refreshImageStatus();
  els.input.focus();
}

function closeImageMode() {
  state.image.mode = null;
  state.image.source = null;
  els.imgbar.hidden = true;
  els.btnImage.classList.remove('on');
  applyImageMode();
  if (state.image.chatUnloaded && !isBusy()) {
    state.image.chatUnloaded = false;
    state.server.requested = '';
    state.server.backgroundLoading = true;
    checkServer();
  }
}

function setImageMode(mode) {
  state.image.mode = mode;
  applyImageMode();
}

function applyImageMode() {
  const mode = state.image.mode;
  els.btnImgGenerate.classList.toggle('on', mode === 'generate');
  els.btnImgEdit.classList.toggle('on', mode === 'edit');
  els.imgSize.disabled = mode === 'edit';
  for (const b of [els.btnThink, els.btnTools, els.btnBtw]) b.disabled = !!mode;
  els.input.placeholder = mode === 'generate' ? tx('image.placeholderGenerate')
    : mode === 'edit' ? tx('image.placeholderEdit') : tx('composer.placeholder');
  els.send.title = mode === 'generate' ? tx('image.modeGenerate') : mode === 'edit' ? tx('image.modeEdit') : tx('common.send');
  els.btnAttach.title = mode ? tx('image.attachTitle') : tx('composer.attachTitle');
  if (mode) els.fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
  else els.fileInput.removeAttribute('accept');
  renderImageStatus(); // renderImageNote も呼ぶ
  renderPending(); // 送信ボタンとトークン数の更新も行う
}

function imageSendable() {
  const mode = state.image.mode;
  if (!mode || isBusy() || btwState.controller || !imageReady(mode)) return false;
  if (!els.input.value.trim()) return false;
  return mode !== 'edit' || !!state.image.source;
}

// 画像エンジンの結果 (PNG) を data URL にする。デコードせず、文字のチャンク (tEXt / iTXt / zTXt) だけを落とす。
// --disable-image-metadata で指示文は埋め込まれないが、作り直していたときと同じく念のため残さない
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_TEXT_CHUNKS = new Set(['tEXt', 'iTXt', 'zTXt']);
function pngWithoutText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error(tx('image.badFormat'));
  const view = new DataView(buffer);
  const parts = [bytes.subarray(0, 8)];
  let ended = false;
  for (let pos = 8; pos + 12 <= bytes.length;) {
    const size = view.getUint32(pos);
    const end = pos + 12 + size;
    if (end > bytes.length) throw new Error(tx('image.truncated'));
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    if (!PNG_TEXT_CHUNKS.has(type)) parts.push(bytes.subarray(pos, end));
    pos = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended) throw new Error(tx('image.truncated'));
  return new Blob(parts, { type: 'image/png' });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function pngResultUrl(buffer) {
  const url = await blobToDataUrl(pngWithoutText(buffer));
  if (!SAFE_IMAGE_RE.test(url)) throw new Error(tx('image.badFormat'));
  return url;
}

// 編集入力は長辺 1024px まで縮める。PNG にして、再編集のたびの JPEG 圧縮による細部の劣化を避ける。
function imageSourceFrom(drawable, width, height) {
  const scale = Math.min(1, LIMITS.imageEdge / Math.max(width, height));
  const canvas = el('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(drawable, 0, 0, canvas.width, canvas.height);
  return { url: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height };
}

async function addImageModeFiles(fileList) {
  const file = [...fileList].find((f) => f.type.startsWith('image/'));
  if (!file) { flashHint(tx('hint.imageOnly')); return; }
  try {
    const bmp = await createImageBitmap(file);
    try { state.image.source = imageSourceFrom(bmp, bmp.width, bmp.height); } finally { bmp.close(); }
    if (state.image.mode !== 'edit') setImageMode('edit');
  } catch {
    showError(tx('image.fileLoadFailed', { name: file.name }));
  }
  renderPending(); // 送信ボタンの更新も行う
}

// 結果の画像を、この画像の元画像として編集モードに入れる
async function reeditImage(m) {
  if (isBusy() || !m.images[0]) return;
  try {
    const img = new Image();
    img.src = m.images[0];
    await img.decode();
    // 上限以内の大きさの PNG はそのまま使う: 描き直すと別のバイト列になり、同じ絵がもう 1 枚保存される (PNG の作り直しも重い)
    const fits = m.images[0].startsWith('data:image/png') && Math.max(img.naturalWidth, img.naturalHeight) <= LIMITS.imageEdge;
    state.image.source = fits ? { url: m.images[0], w: img.naturalWidth, h: img.naturalHeight } : imageSourceFrom(img, img.naturalWidth, img.naturalHeight);
  } catch {
    showError(tx('image.loadFailed'));
    return;
  }
  if (state.image.mode) setImageMode('edit'); else openImageMode('edit');
  els.input.focus();
}

// 編集では元画像の比率のまま、長辺 1024px の 64 の倍数にする
function editSize(w, h) {
  const scale = 1024 / Math.max(w, h);
  const fit = (v) => Math.min(1024, Math.max(256, Math.round((v * scale) / 64) * 64));
  return [fit(w), fit(h)];
}

// ---- 送信と実行 ----

function sendImage() {
  if (!imageSendable()) return;
  const chat = current();
  const mode = state.image.mode;
  const text = els.input.value.trim();
  const [w, h] = mode === 'edit' ? editSize(state.image.source.w, state.image.source.h) : IMAGE_SIZES[els.imgSize.value] || IMAGE_SIZES.square;
  const seedText = els.imgSeed.value.trim();
  const seed = /^\d{1,10}$/.test(seedText) && Number(seedText) <= 2147483647 ? Number(seedText) : randomSeed();
  const model = selectedImageModel(mode);
  if (!model) return;
  rememberImageModel(mode, model.id);

  const translate = mode === 'generate' && model.translate;
  const m = {
    id: uid(), role: 'image', content: text, images: [], files: [],
    gen: { mode, w, h, seed, prompt: mode === 'edit' || !translate ? text : '', source: mode === 'edit' ? state.image.source.url : undefined, model: model.id, modelLabel: model.label, translate },
  };
  chat.messages.push(m);
  autoTitle(chat);
  els.input.value = '';
  autosize();
  if (mode === 'edit') state.image.source = null;
  renderPending();
  ensureThread().append(imageView(chat, m).wrap);
  markLast();
  els.log.scrollTop = els.log.scrollHeight;
  renderSidebar();
  runImageJob(chat, m);
}

// 同じ指示でシードだけを変えて、もう 1 枚作る
function imageVariant(chat, m, prompt) {
  if (isBusy() || btwState.controller) return;
  const g = m.gen;
  if (g.mode === 'edit' && !g.source) { showError(tx('image.noSource')); return; }
  const edited = typeof prompt === 'string';
  const n = {
    id: uid(), role: 'image', content: edited && g.mode === 'edit' ? prompt : m.content, images: [], files: [],
    gen: { mode: g.mode, w: g.w, h: g.h, seed: edited ? g.seed : randomSeed(), prompt: edited ? prompt : g.prompt, source: g.source, model: g.model, modelLabel: g.modelLabel, translate: g.translate },
  };
  chat.messages.push(n);
  ensureThread().append(imageView(chat, n).wrap);
  markLast();
  els.log.scrollTop = els.log.scrollHeight;
  runImageJob(chat, n);
}

async function translateImagePrompt(chat, m, signal) {
  const list = chat.messages.slice(0, chat.messages.indexOf(m));
  const built = await buildContext(chat, list, signal, m.content.length + IMAGE_TRANSLATE_PROMPT.length, true);
  const res = await request({
    model: state.server.model,
    messages: built.messages.concat({ role: 'user', content: `${IMAGE_TRANSLATE_PROMPT}\n\n${m.content}` }),
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
    temperature: 0.2, top_p: 0.8, max_tokens: 400,
  }, signal);
  const j = await res.json();
  const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  const line = splitThink(raw).answer.replace(/```[a-z]*/gi, '').split(/\n+/).map((s) => s.trim()).find(Boolean) || '';
  const text = line.replace(/^(english prompt|prompt)\s*[:：]\s*/i, '').replace(/^["'“„«「『]+|["'”“»」』]+$/g, '').trim();
  if (!text) throw new Error(tx('image.translateFailed'));
  return text.slice(0, 1800);
}

async function unloadChatModel(signal) {
  state.server.ok = false;
  els.status.textContent = tx('status.unloading');
  const activeModels = async () => {
    const status = await fetch('/models', { headers: authHeaders(), credentials: 'omit', signal });
    if (!status.ok) throw new Error(tx('error.modelStatus', { status: status.status }));
    return (await status.json()).data.filter((x) => x.status.value !== 'unloaded');
  };
  // state.server.ok が false でも、サーバーではモデルを読み込み中のことがある。
  for (const model of await activeModels()) {
    const res = await fetch('/models/unload', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ model: model.id }), credentials: 'omit', signal });
    if (!res.ok) throw new Error(tx('error.unloadFailed', { status: res.status }));
  }
  for (let i = 0; i < 120; i++) {
    if (!(await activeModels()).length) {
      els.status.textContent = tx('status.unloaded');
      return;
    }
    await pause(500, signal);
  }
  throw new Error(tx('error.unloadTimeout'));
}

function imageProgressLabel(g, info) {
  const sec = tx('common.paren', { text: fmtSec(info.elapsedMs) });
  if (info.phase === 'sampling' && info.total) return tx(g.mode === 'edit' ? 'image.progressEdit' : 'image.progressGenerate', { done: info.done, total: info.total, time: sec });
  if (info.phase === 'decoding') return tx('image.progressDecoding', { time: sec });
  const pct = info.total ? ` ${Math.round((info.done / info.total) * 100)}%` : '';
  return tx('image.progressLoading', { pct, time: sec }) + (info.elapsedMs > 60000 ? tx('image.progressLoadingLong') : '');
}

// 英訳を終えてからチャットを解放し、画像処理後に読み込み直す。
async function runImageJob(chat, m) {
  if (isBusy() || btwState.controller) return;
  const g = m.gen;
  const controller = new AbortController();
  let finish = () => {};
  // 待つ前に処理中にする (画像の読み込みを待つ間に、別の生成や 2 つ目の画像処理を始めさせない)
  state.controller = controller;
  state.generation = new Promise((resolve) => { finish = resolve; });
  // 依頼した時点の会話を先に保存する。処理中 (画像の読み込みを待つ間も含む) に閉じたら、次回は「中止」のカード (再試行できる) として残る
  freezeChat(chat, (x) => (x === m ? { ...m, images: [], gen: { ...m.gen, cancelled: true } } : x));
  state.generatingChat = chat;
  // 編集の元画像が、保存した画像の参照のままだと送れない
  if (!(await ensureImages(chat, [{ gen: g }])) || !isStoredImageReady(g.source)) {
    state.controller = null;
    state.generation = null;
    state.generatingChat = null;
    historyState.frozen.delete(chat.id);
    finish();
    // カードに理由と「再試行」を出し、その状態で保存する (何も起きていないカードのまま残さない)
    g.error = IMAGES_NOT_READY;
    const v = state.views.get(m);
    if (v) fillImage(v);
    markDirty(chat);
    return;
  }
  state.image.running = true;
  delete g.error;
  delete g.cancelled;
  const view = state.views.get(m) || imageView(chat, m);
  view.running = true;
  fillImage(view);
  setBusy(true);
  renderImageStatus();
  let jobId = '';
  let unloaded = false;
  try {
    if (!g.model) { // モデルを選べるようになる前のカード: 今使えるものの先頭で作る
      if (!state.image.status) await refreshImageStatus();
      const fallback = imageModelsFor(g.mode)[0];
      if (!fallback) throw new Error(imageUnavailableReason(g.mode) || tx('image.noModels'));
      g.model = fallback.id;
      g.modelLabel = fallback.label;
      if (g.translate === undefined) g.translate = g.mode === 'generate' && fallback.translate;
    }
    if (!g.prompt) {
      const wantsTranslate = g.translate !== undefined ? g.translate : g.mode === 'generate';
      if (wantsTranslate && settings.imageTranslate !== false && needsEnglish(m.content)) {
        if (!state.server.ok && state.image.chatUnloaded) {
          // Translation needs the chat model; native/English prompts do not.
          state.image.running = false;
          state.server.requested = '';
          state.server.backgroundLoading = true; // 会話と処理中のカードを隠さない (チャットへ戻るときの読み戻しと同じ)
          await checkServer();
          const until = performance.now() + 600000;
          // 読み込みに失敗したら checkServer は試し直さない (loading が下りる)。そのときは待ち続けずに知らせる
          while (!state.server.ok && state.server.loading && performance.now() < until) await pause(250, controller.signal);
          state.image.running = true;
          state.image.chatUnloaded = false;
        }
        if (!state.server.ok) throw new Error(tx('image.translateNotReady'));
        setImageProgress(view, tx('image.translating'), null);
        g.prompt = await translateImagePrompt(chat, m, controller.signal);
      } else g.prompt = m.content;
      fillImagePrompt(view);
    }
    if (g.mode === 'edit' && !g.source) throw new Error(tx('image.noSource'));
    setImageProgress(view, tx('image.unloading'), null);
    unloaded = true; // 解放の失敗・中断後もチャットの状態を確認し直す
    await unloadChatModel(controller.signal);
    setImageProgress(view, tx('progress.preparing'), null);
    jobId = (await controlJson(await controlFetch('POST', '/image/jobs', imageJobBody(g), controller.signal, { 'Content-Type': 'application/octet-stream' }))).id;
    let info;
    for (;;) {
      await pause(IMAGE_POLL_MS, controller.signal);
      info = await controlJson(await controlFetch('GET', `/image/jobs/${jobId}`, undefined, controller.signal));
      setImageProgress(view, imageProgressLabel(g, info), info.total ? info.done / info.total : null);
      if (info.state === 'done') break;
      if (info.state !== 'running') {
        throw new Error(info.error || tx('image.failed'));
      }
    }
    const res = await controlFetch('GET', `/image/jobs/${jobId}/result`, undefined, controller.signal);
    if (!res.ok) await controlJson(res);
    jobId = ''; // 受け取った時点で受付側の一時ファイルは消えている
    // 届いた PNG をそのまま使う (画面側で一度ほどいて作り直すと、そのたびに画面が固まる)。
    // 文字のチャンク (指示文が埋め込まれうる) だけを取り除く
    m.images = [await pngResultUrl(await res.arrayBuffer())];
    g.ms = info.elapsedMs;
    delete g.unsaved;
  } catch (e) {
    if (e.name === 'AbortError') g.cancelled = true;
    else g.error = e instanceof TypeError ? tx('error.launcher') : String(e.message || e);
    if (jobId) controlFetch('POST', `/image/jobs/${jobId}/cancel`).catch(() => {});
  } finally {
    state.controller = null;
    state.generation = null;
    state.generatingChat = null;
    unfreezeChat(chat);
    state.image.running = false;
    finish();
  }
  view.running = false;
  fillImage(view);
  setBusy(false);
  renderImageStatus();
  if (unloaded && state.image.mode) {
    state.image.chatUnloaded = true;
  } else if (unloaded) { // チャットに戻るときだけ読み戻す
    state.server.requested = '';
    state.server.backgroundLoading = true;
    checkServer();
  }
  touchChat(chat);
  renderSidebar();
}

// ---- 表示 ----

function imageView(chat, m) {
  const g = m.gen;
  const wrap = el('div', 'msg image');
  const req = el('div', 'img-req');
  if (g.source) {
    const src = el('img');
    src.decoding = 'async';
    src.loading = 'lazy';
    setImageSrc(src, g.source);
    src.alt = tx('image.source');
    req.append(src);
  }
  const bubble = el('div', 'bubble');
  bubble.append(el('span', 'img-tag', g.mode === 'edit' ? tx('image.modeEdit') : tx('image.modeGenerate')), document.createTextNode(m.content));
  req.append(bubble);
  const card = el('div', 'img-card');
  const promptLine = el('div', 'img-prompt');
  const progress = el('div', 'progress');
  const pRow = el('div', 'img-progress-row');
  const pLabel = el('span', 'shimmer');
  pRow.append(pLabel, button(tx('common.stop'), () => { if (state.controller && state.generatingChat === chat) state.controller.abort(); }, 'pill'));
  const pBar = el('div', 'pbar indeterminate');
  const pFill = el('span');
  pBar.append(pFill);
  progress.append(pRow, pBar);
  progress.hidden = true;
  const figure = el('div', 'img-result');
  const status = el('div', 'notice');
  const meta = el('div', 'img-meta');
  const actions = el('div', 'actions');
  card.append(promptLine, progress, figure, status, meta, actions);
  wrap.append(req, card);
  const view = { chat, m, wrap, promptLine, progress, pLabel, pBar, pFill, figure, status, meta, actions, running: false };
  fillImage(view);
  state.views.set(m, view);
  return view;
}

function setImageProgress(view, label, ratio) {
  view.progress.hidden = false;
  view.pLabel.textContent = label;
  view.pBar.className = ratio === null ? 'pbar indeterminate' : 'pbar';
  view.pFill.style.transform = ratio === null ? '' : `scaleX(${Math.min(1, ratio).toFixed(3)})`;
}

function fillImagePrompt(view) {
  const { m } = view;
  const g = m.gen;
  view.promptLine.replaceChildren();
  view.promptLine.hidden = !(g.mode === 'generate' && g.prompt && g.prompt !== m.content);
  if (!view.promptLine.hidden) view.promptLine.append(el('span', 'img-prompt-label', tx('image.translatedLabel')), el('span', '', g.prompt));
}

function fillImage(view) {
  const { chat, m } = view;
  const g = m.gen;
  fillImagePrompt(view);
  view.progress.hidden = !view.running;
  view.actions.hidden = view.running;
  view.figure.replaceChildren();
  if (m.images[0]) {
    const img = el('img');
    img.decoding = 'async';
    setImageSrc(img, m.images[0]);
    img.alt = m.content;
    img.width = g.w;
    img.height = g.h;
    view.figure.append(img);
  }
  view.figure.hidden = !m.images[0];
  view.status.replaceChildren();
  const busy = () => isBusy() || !!btwState.controller;
  if (!view.running) {
    if (g.error) {
      view.status.append(el('span', 'img-error', g.error));
    } else if (g.cancelled) view.status.append(el('span', '', tx('image.cancelled')));
    else if (g.unsaved && !m.images[0]) view.status.append(el('span', 'dim', tx('image.unsaved')));
    if ((g.error || g.cancelled) && !m.images[0]) view.status.append(button(tx('common.retry'), () => { if (!busy()) runImageJob(chat, m); }, 'pill'));
  }
  view.status.hidden = !view.status.childNodes.length;
  view.meta.textContent = [
    g.mode === 'edit' ? tx('image.modeEdit') : tx('image.modeGenerate'), g.modelLabel || '', `${g.w}×${g.h}`, tx('image.seed', { seed: g.seed }), g.ms ? fmtSec(g.ms) : '', tx('image.notSent'),
  ].filter(Boolean).join(' · ');

  const del = iconButton('trash', tx('common.delete'));
  del.addEventListener('click', armed(del, () => deleteMessage(chat, m)));
  const list = [];
  if (m.images[0]) {
    const png = /^(data:image\/png;|simpllm-img:.*\.png$)/.test(m.images[0]);
    list.push(iconButton('download', png ? tx('image.savePng') : tx('image.saveJpeg'), () => withImages(chat, m, () => {
      const isPng = m.images[0].startsWith('data:image/png;');
      download(dataUrlBytes(m.images[0]), isPng ? 'image/png' : 'image/jpeg', `simpllm-${g.mode}-${g.seed}.${isPng ? 'png' : 'jpg'}`);
    })));
  }
  list.push(iconButton('regen', tx('image.variant'), () => imageVariant(chat, m)));
  if (m.images[0]) list.push(iconButton('image', tx('image.reedit'), () => withImages(chat, m, () => reeditImage(m))));
  list.push(iconButton('edit', tx('image.editPrompt'), () => startImagePromptEdit(view)), del);
  view.actions.replaceChildren(...list);
}

function startImagePromptEdit(view) {
  const { chat, m } = view;
  if (isBusy() || view.wrap.querySelector('.img-edit')) return;
  const g = m.gen;
  const box = el('div', 'edit img-edit');
  const ta = el('textarea');
  ta.autocomplete = 'off';
  ta.spellcheck = false;
  ta.rows = 3;
  ta.value = g.prompt || m.content;
  const row = el('div', 'row');
  row.append(
    el('small', 'dim', g.mode === 'generate' ? tx('image.editPromptNoteGenerate') : tx('image.editPromptNote')),
    button(tx('common.cancel'), () => { box.remove(); view.actions.hidden = false; }, 'pill'),
    button(tx('image.redo'), () => {
      const text = ta.value.trim();
      if (!text || isBusy() || btwState.controller) return;
      box.remove();
      view.actions.hidden = false;
      imageVariant(chat, m, text);
    }, 'pill light'),
  );
  box.append(ta, row);
  view.actions.hidden = true;
  view.actions.before(box);
  ta.focus();
}

function bindImage() {
  els.btnImage.addEventListener('click', toggleImageMode);
  els.btnImgClose.addEventListener('click', closeImageMode);
  els.btnImgGenerate.addEventListener('click', () => setImageMode('generate'));
  els.btnImgEdit.addEventListener('click', () => setImageMode('edit'));
  els.imgSize.addEventListener('change', () => {
    if (!IMAGE_SIZES[els.imgSize.value]) return;
    settings.imageSize = els.imgSize.value;
    els.imageSizeDefault.value = settings.imageSize;

  });
  els.imageTranslate.addEventListener('change', () => { settings.imageTranslate = els.imageTranslate.checked; renderImageNote(); });
  els.imgModel.addEventListener('change', () => {
    if (!state.image.mode) return;
    rememberImageModel(state.image.mode, els.imgModel.value);

    renderImageNote();
  });
}

// ---------------------------------------------------------------------------
// イベント
// ---------------------------------------------------------------------------

function bindEvents() {
  document.addEventListener('visibilitychange', () => {
    document.documentElement.classList.toggle('page-hidden', document.hidden);
    if (document.hidden) {
      cancelIdleCallback(lazyIdle);
      lazyIdle = 0;
      if (tokenRequest) tokenRequest.abort();
      tokenRequest = null;
    } else { scheduleLazy(); countTokens(); }
  });
  els.send.addEventListener('click', send);
  els.stop.addEventListener('click', () => { if (state.controller) state.controller.abort(); });
  els.input.addEventListener('input', () => { autosize(); updateSendState(); countTokens(); });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && !e.isComposing && !e.shiftKey && !els.input.value && !state.pending.images.length && !state.pending.files.length) {
      if (editLastUserMessage()) e.preventDefault();
      return;
    }
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return; // 日本語変換中の Enter は無視
    if (e.ctrlKey || e.metaKey || (settings.enterSend && !e.shiftKey)) {
      e.preventDefault();
      send();
    }
  });
  els.input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  els.btnThink.addEventListener('click', () => {
    settings.thinking = !settings.thinking;
    els.btnThink.classList.toggle('on', settings.thinking);

  });
  els.btnTools.addEventListener('click', () => {
    settings.tools = !settings.tools;
    els.btnTools.classList.toggle('on', settings.tools);

  });

  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; els.drop.hidden = false; } });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) els.drop.hidden = true; });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.drop.hidden = true;
    if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
  });

  els.btnAttach.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => { addFiles([...els.fileInput.files]); els.fileInput.value = ''; });

  const startNew = () => { if (!isBusy()) newChat(); };
  els.btnNew.addEventListener('click', startNew);
  els.btnNewTop.addEventListener('click', startNew);
  els.search.addEventListener('input', debounce(renderSidebar, 150));
  // 検索欄の Esc は欄の中だけで扱う (全体のショートカットに渡すと、生成まで止まる)
  els.search.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
  els.btnSideOpen.addEventListener('click', () => els.app.classList.remove('side-closed'));
  els.btnSideClose.addEventListener('click', () => els.app.classList.add('side-closed'));
  els.backdrop.addEventListener('click', () => els.app.classList.add('side-closed'));

  document.addEventListener('mousedown', (e) => { if (!els.menu.hidden && !els.menu.contains(e.target)) closeMenu(); });
  els.chatList.addEventListener('scroll', closeMenu);
  window.addEventListener('resize', closeMenu);

  els.btnSettings.addEventListener('click', openSettings);
  els.btnCloseSettings.addEventListener('click', closeSettings);
  els.settingsNav.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('[data-pane]') : null;
    if (b) showSettingsPane(b.dataset.pane);
  });
  // メッセージの「…」メニューを開いたままスクロールしたとき (位置がずれるので閉じる)。
  // サイドバーのメニューは、生成中の自動スクロールで閉じないよう対象にしない
  els.log.addEventListener('scroll', () => { if (menuAnchor && els.log.contains(menuAnchor)) closeMenu(); }, { passive: true });
  els.settings.addEventListener('mousedown', (e) => { if (e.target === els.settings) closeSettings(); });
  document.addEventListener('keydown', (e) => { if (!e.isComposing && e.keyCode !== 229) onShortcut(e); });
  els.log.addEventListener('scroll', updateBottomButton, { passive: true });
  els.btnBottom.addEventListener('click', () => scrollToBottom(true));
  els.modelSelect.addEventListener('change', switchModel);
  // ダウンロードを終えてこのウィンドウに戻ったときに、置いたモデルを一覧に出す
  window.addEventListener('focus', () => {
    refreshInventory();
    if (state.image.mode || !els.settings.hidden || els.btnImage.hidden) refreshImageStatus(); // 画像のモデルを置いて戻ったときもボタンを出す
  });
  els.btnModelRescan.addEventListener('click', () => { refreshInventory(true); refreshImageStatus(true); });
  $('btn-close-model-editor').addEventListener('click', closeModelEditor);
  $('model-editor').addEventListener('mousedown', (e) => { if (e.target === $('model-editor')) closeModelEditor(); });
  els.btnModelDirBrowse.addEventListener('click', browseModelDir);
  els.btnModelDirApply.addEventListener('click', applyModelDir);
  els.btnLaunchApply.addEventListener('click', () => applyLaunch());
  els.btnLaunchReset.addEventListener('click', () => applyLaunch(true));
  els.advanced.addEventListener('change', () => { settings.advanced = els.advanced.checked; applyAdvanced(); });
  const languages = I18n.available();
  els.language.replaceChildren(...languages.map((l) => { const o = el('option', '', l.name); o.value = l.code; return o; }));
  els.language.value = I18n.lang;
  $('language-row').hidden = languages.length < 2; // 選べる言語が 1 つだけなら、選択欄を出さない
  els.language.addEventListener('change', changeLanguage);
  els.btnModelSampling.addEventListener('click', () => { applyChatSampling(state.server.model, true); });
  window.addEventListener('hashchange', () => { if (takeKeyFromUrl()) checkServer(); }); // 開いているタブに URL を貼られたとき
  document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    const p = PRESETS[b.dataset.preset];
    for (const k of Object.keys(p)) if (k !== 'thinking') $('p-' + k).value = String(p[k]);
    settings.thinking = p.thinking;
    els.btnThink.classList.toggle('on', settings.thinking);
    formToSettings();
  }));

  // システムプロンプト集
  els.btnPromptApply.addEventListener('click', () => {
    const p = selectedPrompt();
    if (p) els.systemPrompt.value = p.text;
  });
  els.btnPromptSave.addEventListener('click', () => {
    const name = els.promptName.value.trim() || els.systemPrompt.value.trim().slice(0, 20);
    if (!name || !els.systemPrompt.value.trim()) return;
    const k = settings.prompts.findIndex((p) => p.name === name);
    const entry = { name: name.slice(0, 60), text: els.systemPrompt.value };
    if (k === -1) settings.prompts.push(entry); else settings.prompts[k] = entry; markMetaDirty();

    els.promptName.value = '';
    renderPromptLib();
    els.promptSelect.value = String(k === -1 ? settings.prompts.length - 1 : k);
  });
  els.btnPromptDelete.addEventListener('click', armed(els.btnPromptDelete, () => {
    const k = els.promptSelect.value;
    if (k === '') return;
    settings.prompts.splice(Number(k), 1); markMetaDirty();

    renderPromptLib();
  }, tx('common.pressAgainDelete')));

  els.btnExportAll.addEventListener('click', () => exportChats(sortedChats(), `simpllm-all-${Date.now()}.json`, [...state.projects.values()]));
  els.btnImport.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', async () => {
    const f = els.importFile.files[0];
    els.importFile.value = '';
    if (!f) return;
    try {
      await importFile(f);
      els.settings.hidden = true;
    } catch (e) { showError(tx('import.failed') + e.message); }
  });
  els.btnDeleteAll.addEventListener('click', armed(els.btnDeleteAll, () => {
    if (isBusy()) return;
    state.chats.clear();
    state.projects.clear(); markProjectsDirty();
    els.settings.hidden = true;
    newChat();
    renderSidebar();
  }, tx('data.pressAgainDeleteAll')));

  bindSelection();
  bindBtw();
  bindProject();
  bindImage();
}

// ---------------------------------------------------------------------------
// 開いている会話のプロジェクト表示
// ---------------------------------------------------------------------------

function renderChatBadges() {
  const chat = current();
  if (!chat) return;
  const project = projectOf(chat);
  els.projectChip.hidden = !project;
  els.projectName.textContent = project ? project.name : '';
  updateHint();
}

// ---------------------------------------------------------------------------
// 複数選択の一括操作
// ---------------------------------------------------------------------------

let lastSelected = null;

const selectedChats = () => [...(state.selection || [])].map((id) => state.chats.get(id)).filter(Boolean);

function updateBulk() {
  if (!state.selection) return;
  const n = state.selection.size;
  els.bulkCount.textContent = tx('bulk.count', { count: n });
  els.btnBulkAll.textContent = n > 0 && n === state.sideOrder.length ? tx('bulk.none') : tx('bulk.all');
  const off = n === 0 || !!state.controller;
  for (const b of [els.btnBulkPin, els.btnBulkFolder, els.btnBulkExport, els.btnBulkDelete]) b.disabled = off;
}

function setSelected(id, on) {
  if (on) state.selection.add(id); else state.selection.delete(id);
  const item = state.sideItems.get(id);
  if (!item) return;
  item.classList.toggle('selected', on);
  item.querySelector('.sel').checked = on;
}

function toggleSelect(id, e) {
  const on = !state.selection.has(id);
  const from = state.sideOrder.indexOf(lastSelected);
  const to = state.sideOrder.indexOf(id);
  if (e.shiftKey && from !== -1 && to !== -1) {
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) setSelected(state.sideOrder[i], on);
  } else {
    setSelected(id, on);
  }
  lastSelected = id;
  updateBulk();
}

function enterSelection() {
  state.selection = new Set();
  lastSelected = null;
  closeMenu();
  els.bulk.hidden = false;
  renderSidebar();
}

function exitSelection() {
  state.selection = null;
  els.bulk.hidden = true;
  els.bulkFolderInput.hidden = true;
  els.bulkActions.hidden = false;
  renderSidebar();
}

function bindSelection() {
  els.btnSelect.addEventListener('click', () => { if (state.selection) exitSelection(); else enterSelection(); });
  els.btnBulkClose.addEventListener('click', exitSelection);
  // 検索や折りたたみで見えているものだけを全選択する
  els.btnBulkAll.addEventListener('click', () => {
    const on = state.selection.size !== state.sideOrder.length;
    for (const id of state.sideOrder) setSelected(id, on);
    updateBulk();
  });
  els.btnBulkPin.addEventListener('click', () => {
    if (isBusy()) return;
    const list = selectedChats();
    const on = list.some((c) => !c.pinned);
    for (const c of list) { c.pinned = on; markDirty(c, true); }

    renderSidebar();
  });
  els.btnBulkFolder.addEventListener('click', () => {
    if (isBusy()) return;
    renderFolderList();
    els.bulkActions.hidden = true;
    els.bulkFolderInput.hidden = false;
    els.bulkFolderInput.value = '';
    els.bulkFolderInput.focus();
  });
  const closeFolderInput = () => {
    els.bulkFolderInput.hidden = true;
    els.bulkActions.hidden = false;
  };
  els.bulkFolderInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeFolderInput(); return; }
    if (e.key !== 'Enter' || isBusy()) return;
    const folder = els.bulkFolderInput.value.trim().slice(0, 60);
    const list = selectedChats();
    for (const c of list) { c.folder = folder; markDirty(c, true); }

    closeFolderInput();
    renderSidebar();
  });
  els.btnBulkExport.addEventListener('click', () => exportChats(selectedChats(), `simpllm-selected-${Date.now()}.json`));
  els.btnBulkDelete.addEventListener('click', armed(els.btnBulkDelete, () => {
    if (isBusy()) return;
    const ids = selectedChats().map((c) => c.id);
    for (const id of ids) state.chats.delete(id);
    if (!current()) newChat();
    exitSelection();
  }));
}

// ---------------------------------------------------------------------------
// AI の回答のコードブロックを編集する
// ---------------------------------------------------------------------------

function renderAnswer(view, m) {
  return Markdown.render(m.content, { onEditCode: (block) => startCodeEdit(view, m, block) });
}

function startCodeEdit(view, m, block) {
  const chat = view.chat;
  if (isBusy() || !chat || block.wrap.querySelector('.code-edit')) return;
  const box = el('div', 'code-edit-box');
  const ta = el('textarea', 'code-edit');
  ta.autocomplete = 'off';
  ta.spellcheck = false;
  ta.wrap = 'off';
  ta.rows = Math.min(30, block.src.split('\n').length + 1);
  ta.value = block.src;
  const cancel = () => {
    box.remove();
    block.pre.hidden = false;
  };
  const save = () => {
    if (isBusy()) return;
    if (ta.value === block.src) { cancel(); return; }
    commitCodeEdit(view, m, Markdown.replaceCode(m.content, block.start, block.end, ta.value));
  };
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
  });
  const row = el('div', 'code-edit-row');
  // 履歴の途中を変えると、サーバーのキャッシュが効かなくなる (実測: 3.4万トークンで約100秒)
  if (chat.messages.indexOf(m) < chat.messages.length - 1) {
    row.append(el('span', 'note', tx('code.editWarning')));
  }
  row.append(button(tx('common.cancel'), cancel, 'pill'), button(tx('common.save'), save, 'pill light'));
  box.append(ta, row);
  block.pre.hidden = true;
  block.wrap.append(box);
  ta.focus();
}

// 編集も版として残し、「‹ 1 / 2 ›」で元に戻せるようにする。後ろの会話はそのまま続ける
function commitCodeEdit(view, m, content) {
  const chat = view.chat;
  const idx = chat.messages.indexOf(m);
  if (idx === -1) return;
  const vs = m.variants && m.variants.length ? m.variants.slice() : [snapshot(m)];
  // 後ろの会話はこの版と今の会話の両方に残るので、複製する。その中の版の履歴まで複製すると編集のたびに膨らむので外す
  const tail = chat.messages.slice(idx + 1).map((x) => {
    const copy = copyData(x);
    delete copy.variants;
    delete copy.vi;
    return copy;
  });
  vs[m.vi || 0] = { ...snapshot(m), tail };
  if (chat.lastUsage) chat.lastUsage = Math.max(0, chat.lastUsage + Math.ceil((content.length - m.content.length) * 1.2)); // 0 は「数え直す」の意味なので保つ
  m.content = content;
  m.edited = true;
  m.variants = vs.concat(snapshot(m));
  m.vi = m.variants.length - 1;
  const fresh = assistantView(chat, m);
  view.wrap.replaceWith(fresh.wrap);
  markLast();
  renderCtx(chat.lastUsage);
  touchChat(chat);
  renderSidebar();
}

// ---------------------------------------------------------------------------
// btw: 本題の会話に残さず、横から質問する (メモリ上だけ。保存しない)
// サーバーのスロットは1つなので、本題の生成中は完了を待つ。キャッシュを壊さないよう、履歴・システムプロンプト・ツール定義は本題と揃える
// ---------------------------------------------------------------------------

const btwState = { entries: [], controller: null };

function setBtwBusy(busy) {
  els.btnBtwSend.hidden = busy;
  els.btnBtwStop.hidden = !busy;
  updateSendState();
}

function resetBtw() {
  if (btwState.controller) btwState.controller.abort();
  btwState.entries = [];
  els.btwLog.replaceChildren();
  els.btw.hidden = true;
  els.btnBtw.classList.remove('on');
}

function toggleBtw() {
  const open = els.btw.hidden;
  if (!open && btwState.controller) btwState.controller.abort();
  els.btw.hidden = !open;
  els.btnBtw.classList.toggle('on', open);
  if (open) els.btwInput.focus();
}

function btwView(chat, entry) {
  const wrap = el('div', 'btw-item');
  const body = el('div', 'md');
  const wait = el('div', 'btw-wait');
  wait.append(el('span', 'shimmer', tx('btw.waiting')), button(tx('btw.interrupt'), () => { if (state.controller) state.controller.abort(); }, 'pill'));
  wait.hidden = true;
  const actions = el('div', 'btw-actions');
  actions.hidden = true;
  const copy = iconButton('copy', tx('common.copy'), () => copyText(entry.answer, copy));
  actions.append(copy, button(tx('btw.add'), () => addBtwToChat(chat, entry, wrap), 'pill'));
  wrap.append(el('div', 'btw-q', entry.question), wait, body, actions);
  return { wrap, body, wait, actions };
}

// 選んだときだけ、質問と回答を本題の会話に入れる
function addBtwToChat(chat, entry, wrap) {
  if (isBusy() || btwState.controller || current() !== chat) return;
  chat.messages.push(
    { id: uid(), role: 'user', content: entry.question, images: [], files: [] },
    { id: uid(), role: 'assistant', content: entry.answer, reasoning: '', images: [], files: [], stats: null, finish: 'stop', thinkMs: 0, tools: [] },
  );
  autoTitle(chat);
  chat.lastUsage = 0; // 増えた分は使用量に含まれていないので、次の送信では数え直す
  btwState.entries = btwState.entries.filter((x) => x !== entry);
  wrap.remove();
  touchChat(chat);
  renderLog();
  renderSidebar();
}

async function askBtw() {
  const question = els.btwInput.value.trim();
  if (!question || btwState.controller || !state.server.ok) return;
  const chat = current();
  const entry = { question, answer: '' };
  const view = btwView(chat, entry);
  els.btwInput.value = '';
  els.btwLog.append(view.wrap);
  els.btwLog.scrollTop = els.btwLog.scrollHeight;
  const controller = new AbortController();
  const signal = controller.signal;
  btwState.controller = controller;
  setBtwBusy(true);
  let raw = '';
  try {
    if (state.generation) {
      view.wait.hidden = false;
      const aborted = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      while (state.generation && !signal.aborted) await Promise.race([state.generation, aborted]);
      view.wait.hidden = true;
    }
    signal.throwIfAborted();
    // 本題と同じ履歴を送る (違うとキャッシュが効かない)。待ったあとで次の本題が始まっていたら、作りかけの回答だけ除く
    const pending = state.generatingChat === chat ? chat.messages[chat.messages.length - 1] : null;
    const list = chat.messages.filter((m) => m !== pending);
    const earlier = btwState.entries.flatMap((x) => [{ role: 'user', content: x.question }, { role: 'assistant', content: x.answer }]);
    const upcoming = question.length + earlier.reduce((sum, x) => sum + x.content.length, 0);
    const built = await buildContext(chat, list, signal, upcoming, true);
    const payload = {
      model: state.server.model,
      messages: built.messages.concat(earlier, { role: 'user', content: question }),
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
      ...samplingParams(),
    };
    payload.max_tokens = Math.min(payload.max_tokens || BTW_MAX_TOKENS, BTW_MAX_TOKENS);
    // 定義が違うと履歴全体の再処理になるので本題と揃え、呼び出しだけを止める
    if (settings.tools) Object.assign(payload, { tools: Tools.DEFS, tool_choice: 'none' });
    const res = await request(payload, signal);
    const stream = new StreamMarkdown(view.body);
    let timer = null;
    const paint = () => {
      timer = null;
      stream.update(splitThink(raw).answer);
      els.btwLog.scrollTop = els.btwLog.scrollHeight;
    };
    try {
      for await (const obj of Runtime.events(res.body)) {
          const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
          if (d && d.content) raw += d.content;
        if (!timer && !document.hidden) timer = frameAfter(PAINT_MIN_MS * 2, paint);
      }
    } finally {
      if (timer) timer();
    }
    entry.answer = splitThink(raw).answer;
  } catch (err) {
    view.wait.hidden = true;
    entry.answer = splitThink(raw).answer;
    if (err.name !== 'AbortError') view.wrap.append(el('div', 'note', String(err.message || err)));
  } finally {
    if (btwState.controller === controller) btwState.controller = null;
    setBtwBusy(false);
  }
  view.body.replaceChildren(Markdown.render(entry.answer));
  if (entry.answer && !signal.aborted) {
    btwState.entries.push(entry);
    view.actions.hidden = false;
  }
  els.btwLog.scrollTop = els.btwLog.scrollHeight;
}

function bindBtw() {
  els.btnBtw.addEventListener('click', toggleBtw);
  els.btnBtwClose.addEventListener('click', toggleBtw);
  els.btnBtwSend.addEventListener('click', askBtw);
  els.btnBtwStop.addEventListener('click', () => { if (btwState.controller) btwState.controller.abort(); });
  els.btwInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 日本語変換中の Esc と Enter は変換のためのもの
    if (e.key === 'Escape') { // 本題の生成を止めないよう、ここで受け止める
      e.stopPropagation();
      if (btwState.controller) btwState.controller.abort(); else toggleBtw();
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.ctrlKey || e.metaKey || (settings.enterSend && !e.shiftKey)) {
      e.preventDefault();
      askBtw();
    }
  });
}

// ---------------------------------------------------------------------------
// プロジェクト: フォルダに共通の指示と常時参照するファイルを持たせる
// プロジェクトは会話と同じく、この画面のMapだけで管理する。
// ---------------------------------------------------------------------------

let projectDraft = null;
let projectTokenRequest = null;
let disarmProjectRemove = null;

const projectOf = (chat) => (chat && chat.folder && state.projects.get(chat.folder)) || null;

// 「プロジェクトの指示 → ファイル → チャットの指示」の順で先頭に置く (内容が同じならサーバーのキャッシュが効く)
function systemFor(chat) {
  const project = projectOf(chat);
  if (!project) return chat.system;
  return [project.system, composeText('', project.files), chat.system].filter((s) => s && s.trim()).join('\n\n');
}

function sanitizeProject(p) {
  if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name.trim()) return null;
  const files = (Array.isArray(p.files) ? p.files : [])
    .filter((f) => f && typeof f.name === 'string' && typeof f.text === 'string')
    .map((f) => ({ name: f.name.slice(0, 255), text: f.text }));
  return { name: p.name.trim().slice(0, 60), system: typeof p.system === 'string' ? p.system : '', files };
}

function renderProjectFiles() {
  els.projectFiles.replaceChildren(...projectDraft.files.map((f, k) => {
    const att = el('span', 'att');
    att.append(fileChip(f), iconButton('x', tx('common.remove'), () => {
      projectDraft.files.splice(k, 1);
      renderProjectFiles();
      updateProjectNote();
    }));
    return att;
  }));
}

// 指示とファイルは毎回の送信に含まれるので、どれくらい使うかを見せる
async function updateProjectNote() {
  if (!projectDraft) return;
  projectTokenRequest?.abort();
  const request = new AbortController();
  projectTokenRequest = request;
  const draft = projectDraft;
  const system = els.projectSystem.value;
  // 添付があれば見出しが付くので空にならない。全文の連結は概算が必要なときだけ行う
  const hasText = !!system.trim() || draft.files.length > 0;
  // ファイルは 1 件ずつ一度だけ数えて覚えておく (指示を打つたびに、添付の全文を数え直さない)
  let counted = null;
  if (hasText && state.server.ok) {
    const parts = await Promise.all([system.trim() ? tokenize(system, request.signal) : 0, ...draft.files.map((f) => fileTokenCount(f, request.signal))]);
    if (!parts.includes(null)) counted = parts.reduce((a, b) => a + b, 0);
  }
  if (draft !== projectDraft || projectTokenRequest !== request || request.signal.aborted) return;
  const tokens = counted !== null ? counted
    : Math.ceil(composedLength(system, draft.files) * 1.2);
  const n = state.server.nCtx;
  els.projectNote.textContent = tx(counted !== null ? 'project.tokens' : 'project.tokensApprox', {
    tokens: tokens.toLocaleString(I18n.locale), percent: n ? tx('project.tokensPercent', { percent: Math.round((tokens / n) * 100) }) : '',
  });
}

function openProject(name) {
  const existing = name ? state.projects.get(name) : null;
  if (disarmProjectRemove) disarmProjectRemove(); // 別のプロジェクトを1回押しで解除しないように
  projectDraft = {
    originalName: name || '',
    files: existing ? existing.files.slice() : [],
  };
  els.projectNameInput.value = name || '';
  els.projectSystem.value = existing ? existing.system : '';
  els.projectError.textContent = '';
  els.btnProjectRemove.hidden = !existing;
  renderProjectFiles();
  updateProjectNote();
  els.project.hidden = false;
  els.projectNameInput.focus();
}

function closeProject() {
  projectTokenRequest?.abort();
  projectTokenRequest = null;
  projectDraft = null;
  els.project.hidden = true;
}

// 名前を変えると、所属するチャットと折りたたみの状態も引き継ぐ
function renameFolder(from, to) {
  for (const c of state.chats.values()) if (c.folder === from) { c.folder = to; markDirty(c, true); }
  if (settings.collapsed.includes('folder:' + from)) {
    settings.collapsed = settings.collapsed.map((k) => (k === 'folder:' + from ? 'folder:' + to : k));
  }
}

function saveProject() {
  const draft = projectDraft;
  const name = els.projectNameInput.value.trim().slice(0, 60);
  if (!name) { els.projectError.textContent = tx('project.nameRequired'); return; }
  if (name !== draft.originalName && state.projects.has(name)) { els.projectError.textContent = tx('project.duplicate'); return; }
  if (draft.originalName && name !== draft.originalName) renameFolder(draft.originalName, name);
  state.projects.delete(draft.originalName);
  const project = { name, system: els.projectSystem.value, files: draft.files };
  state.projects.set(name, project); markProjectsDirty();
  closeProject();
  renderSidebar();
}

function bindProject() {
  els.btnNewProject.addEventListener('click', () => openProject(''));
  els.btnCloseProject.addEventListener('click', closeProject);
  els.project.addEventListener('mousedown', (e) => { if (e.target === els.project) closeProject(); });
  els.btnProjectSave.addEventListener('click', saveProject);
  els.projectSystem.addEventListener('input', debounce(updateProjectNote, 500));
  els.btnProjectAdd.addEventListener('click', () => els.projectFileInput.click());
  els.projectFileInput.addEventListener('change', async () => {
    const files = [...els.projectFileInput.files];
    els.projectFileInput.value = '';
    const draft = projectDraft;
    els.projectError.textContent = '';
    for (const file of files) {
      try {
        if (file.type.startsWith('image/')) throw new Error(tx('project.noImages'));
        const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
        draft.files.push(isPdf ? await readPdfFile(file) : await readTextFile(file));
      } catch (e) {
        els.projectError.textContent = `${file.name}: ${e.message}`;
      }
    }
    if (draft !== projectDraft) return;
    renderProjectFiles();
    updateProjectNote();
  });
  const removeHandler = armed(els.btnProjectRemove, () => {
    const draft = projectDraft;
    if (!draft) return;
    state.projects.delete(draft.originalName); markProjectsDirty();
    closeProject();
    renderSidebar();
  }, tx('project.pressAgainRemove'));
  disarmProjectRemove = removeHandler.disarm;
  els.btnProjectRemove.addEventListener('click', removeHandler);
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

async function init() {
  window.addEventListener('pagehide', discardSession);
  window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
  // テンプレートに文言を入れてから、アイコンを足す (文言を入れると中身が置き換わるため)
  I18n.apply(document);
  I18n.apply($('welcome-template').content);
  document.querySelectorAll('[data-icon]').forEach((b) => b.prepend(icon(b.dataset.icon)));
  if (isNarrow()) els.app.classList.add('side-closed');
  els.splash.append($('welcome-template').content.cloneNode(true));
  setLoading(true);
  loadApiKey();
  const preload = preloadModel(); // UIの準備と並行してモデルを読み込む
  await loadHistory(); // 保存した会話・設定・プロジェクト (history\)。復号などはないので軽い
  // 既定のシステムプロンプトのまま (どの言語の既定でも) なら、今の表示言語の既定に合わせる。書き換えてあれば触らない
  if (settings.system !== tx('model.defaultSystem') && I18n.inAllLanguages('model.defaultSystem').includes(settings.system)) settings.system = tx('model.defaultSystem');
  settingsToForm();
  bindEvents();

  newChat(); // ChatGPT と同じく、起動時は新しいチャットを開く (過去の会話はサイドバーから)
  renderSidebar(); // 空の新しいチャットを開くだけでは一覧を描き直さない (markActive) ので、保存してある会話をここで出す
  await preload; // 読み込みの指示が届いてから確かめる (届く前だと、読み込みに失敗したと見なしてしまう)
  checkServer();
  refreshInventory(); // 表示名と、置いたばかりのモデルを一覧に出す (モデルの読み込みとは並行して進む)
  refreshImageStatus(); // 画像の生成・編集を用意してあれば、入力欄に「画像」ボタンを出す
  showStartNotices();
}

// 起動スクリプトからの知らせ (保存した起動設定を読めなかった、など)。起動は続いているので、画面の中に出す
async function showStartNotices() {
  if (!state.controlPort) return;
  try {
    const data = await controlRequest('GET', '/notices');
    for (const text of Array.isArray(data.notices) ? data.notices : []) if (typeof text === 'string' && text) showError(text);
  } catch { /* 知らせを取れなくても、使うのに支障はない */ }
}

function discardSession() {
  flushHistoryOnExit();
  historyState.enabled = false; // 下で state を空にするので、以後は何も書かない (書きかけの保存も止まる)
  clearTimeout(historyState.timer);
  state.ended = true;
  projectTokenRequest?.abort();
  sidebarSearch.controller?.abort();
  clearTimeout(sidebarSearch.timer);
  historyState.release.clear();
  historyState.unload.clear();
  clearTimeout(serverTimer);
  clearTimeout(hintTimer);
  countTokens.cancel();
  if (tokenRequest) tokenRequest.abort();
  lazyObserver.disconnect();
  cancelIdleCallback(lazyIdle);
  lazyIdle = 0;
  if (state.controlPort && state.apiKey) {
    // 閉じる/再読み込みの際は作業中の画像も停止依頼。正常終了時はランチャーも停止する。
    fetch(`http://127.0.0.1:${state.controlPort}/image/session/clear`, {
      method: 'POST', headers: authHeaders(), credentials: 'omit', keepalive: true,
    }).catch(() => {});
  }
  if (state.controller) state.controller.abort();
  if (btwState.controller) btwState.controller.abort();
  state.chats.clear(); state.projects.clear();
  state.sideItems.clear(); state.sideOrder = []; state.selection = null;
  sidebarRows.clear();
  state.generatingChat = null; state.generation = null;
  btwState.entries = []; projectDraft = null; lazyQueue = [];
  state.pending = { images: [], files: [] };
  state.image.source = null;
  state.thread = null; state.views = new WeakMap();
  messageTokenCache = new WeakMap(); fileTokens = new WeakMap();
  systemTokenCache = { text: null, model: '', n: 0 };
  typedTokenCache = { text: null, model: '', n: 0 };
  settings.system = ''; settings.prompts = [];
  document.querySelectorAll('textarea,input').forEach((node) => { node.value = ''; });
  for (const node of Object.values(els)) { if (node && typeof node.replaceChildren === 'function') node.replaceChildren(); }
}

// 選択肢が1つだけなら、UIの準備と並行して読み込みを始める。
async function preloadModel() {
  if (!state.apiKey) return;
  let requested = '';
  try {
    const res = await fetch('/models', { headers: authHeaders(), credentials: 'omit' });
    if (!res.ok) return;
    const models = (await res.json()).data;
    if (models.length !== 1 || models[0].status.value !== 'unloaded') return;
    requested = models[0].id;
    state.server.requested = requested;
    const load = await fetch('/models/load', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ model: requested }), credentials: 'omit' });
    if (!load.ok) throw new Error(tx('error.preload'));
  } catch {
    if (requested && state.server.requested === requested) state.server.requested = ''; // checkServerが再試行する
  }
}

init();
