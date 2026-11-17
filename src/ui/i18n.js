'use strict';

// ---------------------------------------------------------------------------
// 表示言語の切り替え (外部ライブラリなし)
// - 文言は src\lang\<言語>.json にあり、ビルド時に id="lang-<言語>" のデータ用の要素 (type="application/json") として
//   埋め込まれる (実行されないデータなので CSP のスクリプトの制限は受けない)。使う言語の分だけを読み込む
// - tx('キー', { 名前: 値 }) で文言を取り出す。文言の中の {名前} が値に置き換わる。語順は言語ごとに変えてよい
// - 言語は起動スクリプトが URL の #...&lang=xx で渡す (無ければブラウザの言語)。変更は再読み込みで反映する
// - 選んだ言語に無いキーは日本語の文言を使う
// ---------------------------------------------------------------------------

const I18n = (() => {
  // 対応する言語と、言語の選択欄に出す名前 (その言語での呼び名)
  const NAMES = { ja: '日本語', en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ko: '한국어', de: 'Deutsch' };
  const FALLBACK = 'ja';
  const STORE_KEY = 'simpllm.lang';

  // 事前に渡された表 (テスト用) か、ページに埋め込まれた表を読む。無ければ null
  const tables = {}; // 読んだ表 (同じ言語を 2 回解析しない)
  function read(code) {
    if (code in tables) return tables[code];
    const given = globalThis.SIMPLLM_LANG;
    let found = null;
    if (given && given[code]) found = given[code];
    else {
      const node = typeof document !== 'undefined' && document.getElementById ? document.getElementById('lang-' + code) : null;
      if (node && node.textContent) { try { found = JSON.parse(node.textContent); } catch { found = null; } }
    }
    tables[code] = found;
    return found;
  }

  // ブラウザや OS の言語の書き方 (ja-JP, zh-Hant-TW など) を、対応する言語の名前にそろえる。対応していなければ空
  // (src\lang.ps1 の ConvertTo-LanguageCode と同じ決め方。画面と起動スクリプトで同じ言語になるようにする)
  function normalize(code) {
    const c = String(code || '').trim().replace(/_/g, '-').toLowerCase();
    if (!c) return '';
    const short = c.split('-')[0];
    if (short === 'zh') return !/hans/.test(c) && /hant|-tw|-hk|-mo/.test(c) ? 'zh-TW' : 'zh-CN'; // 文字の指定 (Hans / Hant) が地域より優先
    return Object.keys(NAMES).find((k) => k.toLowerCase() === short) || '';
  }

  // 使う言語: 起動スクリプトが URL で渡したもの (設定画面で選んだ言語か Windows の表示言語) → 再読み込みの前に覚えたもの
  // → ブラウザの言語 → 英語 → 日本語。文言を用意してある最初のものにする (src\lang.ps1 の Resolve-Language と同じ)
  function detect() {
    const candidates = [];
    let fromUrl = null;
    try {
      fromUrl = String(location.hash || '').match(/[#&]lang=([A-Za-z0-9-]{2,20})/);
      if (fromUrl) candidates.push(fromUrl[1]);
      candidates.push(sessionStorage.getItem(STORE_KEY));
    } catch { /* 無効でも続行 */ }
    // 起動スクリプトが言語を渡したときは、ブラウザの言語は見ない (起動スクリプトも見ないので、見ると言語が食い違うことがある)
    if (!fromUrl && typeof navigator !== 'undefined') candidates.push(navigator.language);
    candidates.push('en');
    let code = FALLBACK;
    for (const candidate of candidates) {
      const c = normalize(candidate);
      if (c && read(c)) { code = c; break; }
    }
    // URL からはすぐ消えるので、再読み込みの後のために覚える
    if (fromUrl) { try { sessionStorage.setItem(STORE_KEY, code); } catch { /* 無効でも続行 */ } }
    return code;
  }

  const lang = detect();
  const table = read(lang) || {};
  const fallback = lang === FALLBACK ? table : (read(FALLBACK) || {});
  const locale = table['meta.locale'] || fallback['meta.locale'] || 'ja-JP';
  let plural = null;

  function lookup(key) {
    const s = table[key];
    return s !== undefined ? s : fallback[key];
  }

  // vars.count があり、文言が { one, other } の形なら、数に合うほうを使う (英語・ドイツ語の単数と複数)
  function tx(key, vars) {
    let s = lookup(key);
    if (s === undefined) return key;
    if (typeof s === 'object') {
      if (!plural) plural = new Intl.PluralRules(locale);
      const form = vars && typeof vars.count === 'number' ? plural.select(vars.count) : 'other';
      s = s[form] !== undefined ? s[form] : s.other;
    }
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] !== undefined ? String(vars[name]) : whole));
  }

  // テンプレートの data-i18n (中身) と data-i18n-title などの属性に文言を入れる。アイコンを足す前に呼ぶ
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  function apply(root) {
    if (!root || !root.querySelectorAll) return;
    for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = tx(node.getAttribute('data-i18n'));
    for (const attr of ATTRS) {
      for (const node of root.querySelectorAll(`[data-i18n-${attr}]`)) node.setAttribute(attr, tx(node.getAttribute(`data-i18n-${attr}`)));
    }
  }

  // 言語の選択欄に出す一覧 (文言を用意してある言語だけ)
  // (あるかどうかだけを見る。使わない言語の表まで解析しない)
  function has(code) {
    if (code in tables) return !!tables[code];
    const given = globalThis.SIMPLLM_LANG;
    if (given && given[code]) return true;
    return typeof document !== 'undefined' && !!document.getElementById && !!document.getElementById('lang-' + code);
  }
  function available() {
    return Object.keys(NAMES).filter((code) => code === lang || has(code)).map((code) => ({ code, name: NAMES[code] }));
  }

  // 選んだ言語を覚える (反映は呼び出し側が再読み込みで行う)
  function remember(code) {
    if (!NAMES[code]) return false;
    try { sessionStorage.setItem(STORE_KEY, code); } catch { /* 無効でも続行 */ }
    return true;
  }

  // ほかの言語での同じキーの文言 (既定のシステムプロンプトが、どれかの言語の既定のままかを調べるのに使う)
  function inAllLanguages(key) {
    return Object.keys(NAMES).map((code) => (code === lang ? table : read(code) || {})[key]).filter((s) => typeof s === 'string');
  }

  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = lang;
  return { tx, apply, available, remember, inAllLanguages, get lang() { return lang; }, get locale() { return locale; } };
})();

const tx = I18n.tx;
