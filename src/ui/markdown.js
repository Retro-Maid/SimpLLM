'use strict';

// ---------------------------------------------------------------------------
// 安全な Markdown レンダラ (数式・コード色分け付き)
// - 文字列を HTML として解釈しない。DOM ノードを組み立て、テキストは必ず textContent / TextNode で入れる
// - リンクは <a> にせず文字のまま表示する (クリックで外部サイトへ移動できないように)
// - Markdown の画像は読み込まず、代替テキストだけ表示する (外部への通信を発生させない)
// - 数式 ($...$, $$...$$, \(...\), \[...\]) は TeX のよく使う記法だけを Unicode と DOM で表示する
// ---------------------------------------------------------------------------

const Markdown = (() => {
  const MAX_DEPTH = 12;
  const HIGHLIGHT_LIMIT = 30000;
  // 行の残りは (.*) ではなく ([^\n]*) で受ける。「.」は U+2028 / U+2029 に一致しないので、その文字を含む行が見出しや箇条書きにならず、
  // 手前に空白が長く続くと後戻りで極端に遅くなる (空白 4 万個で 約 1.1 秒。実測)
  const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+([^\n]*)$/;
  // コードブロックの始まり・見出し・表の区切りは、行全体を 1 つの正規表現で確かめると、空白が長く続く行 (モデルが空白を出し続けたとき) で
  // 後戻りが増えて極端に遅くなる (見出しは空白 1600 個で 約 0.9 秒。実測)。前半だけを正規表現で見て、残りは別に確かめる
  const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;
  const SPACE_RE = /\s/;
  // コードブロックの始まり・終わりの行なら [行の先頭部分, 記号, 言語名]。記号の後ろは ` を含まない文字列で、その最初の 1 語が言語名
  // (```js title="a.js" のように語が続く書き方もコードブロックの始まり。始まりと認めないと、閉じの ``` が始まりになって後ろの表示が入れ替わる)
  function matchFence(line) {
    const m = FENCE_OPEN_RE.exec(line);
    if (!m) return null;
    const info = line.slice(m[0].length).trim();
    if (info.includes('`')) return null;
    const space = info.search(SPACE_RE);
    return [m[0], m[1], space === -1 ? info : info.slice(0, space)];
  }
  const HEADING_RE = /^\s{0,3}(#{1,6})\s+([^\n]*)$/;
  // 見出しの本文: 末尾の空白と、閉じの # を除く
  function headingText(rest) {
    const t = rest.trimEnd();
    let end = t.length;
    while (end > 0 && t[end - 1] === '#') end--;
    return t.slice(0, end).trimEnd();
  }
  const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const QUOTE_RE = /^\s{0,3}>\s?([^\n]*)$/;
  const TABLE_SEP_CELL_RE = /^:?-+:?$/;
  const MATH_BLOCK_RE = /^\s*(\$\$|\\\[)/;
  // inline() で特別な意味を持たない文字の並び (一気に読み飛ばす)。h は URL (http://・https://) の始まりでなければ、! は画像 (![) の始まりでなければ、ここに含める
  // (h で必ず区切ると、英語の文章が 1 語ごとに細切れになる。200KB で 約 7ms → 約 1ms。実測)
  const PLAIN_RE = /(?:[^\\\n$`!\[hH*_~]|[hH](?![tT][tT][pP][sS]?:\/\/)|!(?!\[))+/y;
  const BACKTICKS_RE = /`+/y;
  // リンク・画像の「](」の後ろ: URL (空白と ) を含まない並び) と、あれば題名
  const LINK_URL_RE = /[^)\s]*/y;
  const LINK_TITLE_RE = /\s+"[^"]*"\)/y;
  const URL_RE = /https?:\/\/[^\s<>()\[\]「」『』（）【】《》、。，；！？]+/iy;
  const URL_TAIL = '.,;:!?\'"';
  const CHUNK_CHARS = 4096;

  let opts = { highlight: true };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const text = (s) => document.createTextNode(s);

  function indentOf(line) {
    return line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
  }

  const isBlank = (line) => /^\s*$/.test(line);

  function isBlockStart(line) {
    return matchFence(line) !== null || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line) || MATH_BLOCK_RE.test(line);
  }

  // 生成中の描画 (app.js の StreamMarkdown) が、行の切れ目で確定してよいかを決めるための行の種類:
  //   'blank' 空行 / 'pipe' 表の見出しになりうる行 (| を含み、見出し・引用などではない) / 'ul'・'ol' 行頭から始まる箇条書きの項目 /
  //   'plain' 段落の続きになる行 / 'other' それ以外 (見出し・数式など)
  function lineKind(line) {
    if (isBlank(line)) return 'blank';
    // 表かどうかは箇条書きより先に確かめる (parseBlocks と同じ順)
    if (line.includes('|') && matchFence(line) === null && !HEADING_RE.test(line) && !HR_RE.test(line) && !QUOTE_RE.test(line) && !MATH_BLOCK_RE.test(line)) return 'pipe';
    const m = line.match(LIST_RE);
    if (m) return m[1] !== '' ? 'other' : (m[2].length > 1 ? 'ol' : 'ul'); // 字下げした項目は入れ子。番号付きは「1.」のように 2 文字以上
    if (isBlockStart(line) || line.includes('|') || line.includes('$$')) return 'other';
    return 'plain';
  }

  // 表の見出しの次の行 (|---|---| の形) か。行全体を 1 つの正規表現で確かめると、「-」の後ろに空白が長く続く行で後戻りが増えて
  // 極端に遅くなる (空白 4 万個で 約 1 秒。実測) ので、| で分けて 1 つずつ確かめる
  function isTableSep(line) {
    if (!line.includes('-')) return false;
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    for (const cell of s.split('|')) if (!TABLE_SEP_CELL_RE.test(cell.trim())) return false;
    return true;
  }

  // その行から表が始まるか (見出しの行に | があり、次の行が区切り)
  const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]);

  function dedent(lines) {
    let min = Infinity;
    for (const l of lines) if (!isBlank(l)) min = Math.min(min, indentOf(l));
    if (!Number.isFinite(min) || min === 0) return lines;
    return lines.map((l) => l.replace(/\t/g, '    ').slice(Math.min(min, indentOf(l))));
  }

  // ==== 数式 (TeX の簡易表示) ===============================================

  const SYM = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
    iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', sigma: 'σ', tau: 'τ',
    upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '•', oplus: '⊕', otimes: '⊗',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅',
    propto: '∝', ll: '≪', gg: '≫', lt: '<', gt: '>', perp: '⊥', parallel: '∥', mid: '∣',
    infty: '∞', partial: '∂', nabla: '∇', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', emptyset: '∅', varnothing: '∅',
    sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', bigcup: '⋃', bigcap: '⋂',
    to: '→', rightarrow: '→', leftarrow: '←', gets: '←', Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔',
    implies: '⟹', iff: '⟺', mapsto: '↦', uparrow: '↑', downarrow: '↓', longrightarrow: '⟶', longleftarrow: '⟵',
    in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖',
    forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨',
    angle: '∠', triangle: '△', square: '□', degree: '°', prime: '′', therefore: '∴', because: '∵',
    ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…',
    langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', vert: '|', Vert: '‖', lvert: '|', rvert: '|',
    quad: ' ', qquad: '  ', ',': ' ', ':': ' ', ';': ' ', ' ': ' ', '!': '',
    '{': '{', '}': '}', '%': '%', '$': '$', '&': '&', '#': '#', '_': '_', '|': '‖', backslash: '∖',
  };
  const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
    'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd', 'arg', 'mod', 'Pr']);
  const ACCENTS = { hat: '̂', widehat: '̂', bar: '̄', vec: '⃗', tilde: '̃', widetilde: '̃', dot: '̇', ddot: '̈' };
  const BB = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', E: '𝔼', H: 'ℍ' };
  const SIZERS = new Set(['left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'middle', 'displaystyle', 'textstyle', 'limits', 'nolimits']);

  const TEX_NAME_RE = /[A-Za-z]+/y;

  function texTokens(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        TEX_NAME_RE.lastIndex = i + 1;
        const m = TEX_NAME_RE.exec(src);
        if (m) { out.push('\\' + m[0]); i += 1 + m[0].length; while (src[i] === ' ') i++; continue; }
        out.push('\\' + (src[i + 1] || ''));
        i += 2;
        continue;
      }
      if (/\s/.test(c)) { i++; continue; } // TeX では空白は無視
      out.push(c);
      i++;
    }
    return out;
  }

  function renderTex(src, display) {
    const toks = texTokens(src);
    let p = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];

    function readGroupText() { // \text{...} の中身を文字列として読む
      if (peek() !== '{') return next() || '';
      next();
      let depth = 1;
      let s = '';
      while (p < toks.length) {
        const t = next();
        if (t === '{') depth++;
        if (t === '}' && --depth === 0) break;
        s += t.startsWith('\\') ? (SYM[t.slice(1)] !== undefined ? SYM[t.slice(1)] : t.slice(1)) + ' ' : t;
      }
      return s;
    }

    function parseExpr(stop) {
      const frag = document.createDocumentFragment();
      while (p < toks.length && peek() !== stop) {
        if (stop === '}' && peek() === '\\end') break;
        const atom = parseAtom();
        if (atom) frag.append(withScripts(atom));
      }
      return frag;
    }

    function withScripts(base) {
      let node = base;
      while (peek() === '^' || peek() === '_') {
        const kind = next() === '^' ? 'sup' : 'sub';
        const s = el(kind);
        const a = parseAtom();
        if (a) s.append(a);
        const wrap = el('span');
        wrap.append(node, s);
        node = wrap;
      }
      return node;
    }

    function parseEnv() {
      const name = readGroupText();
      const table = el('span', 'mx');
      let row = el('span', 'mx-row');
      let cell = el('span', 'mx-cell');
      while (p < toks.length) {
        if (peek() === '\\end') { next(); readGroupText(); break; }
        if (peek() === '&') { next(); row.append(cell); cell = el('span', 'mx-cell'); continue; }
        if (peek() === '\\\\') { next(); row.append(cell); table.append(row); row = el('span', 'mx-row'); cell = el('span', 'mx-cell'); continue; }
        const a = parseAtom();
        if (a) cell.append(withScripts(a));
      }
      row.append(cell);
      table.append(row);
      const brackets = { pmatrix: ['(', ')'], bmatrix: ['[', ']'], vmatrix: ['|', '|'], Bmatrix: ['{', '}'], cases: ['{', ''] }[name];
      if (!brackets) return table;
      const wrap = el('span', 'mx-wrap');
      wrap.append(el('span', 'mx-br', brackets[0]), table, el('span', 'mx-br', brackets[1]));
      return wrap;
    }

    function parseAtom() {
      const t = next();
      if (t === undefined) return null;
      if (t === '{') {
        const g = el('span');
        g.append(parseExpr('}'));
        next();
        return g;
      }
      if (t === '}') return null;
      if (!t.startsWith('\\')) {
        if (/[A-Za-z]/.test(t)) return el('i', '', t);
        if (t === '&') return text(' ');
        return text(t === '-' ? '−' : t === '*' ? '∗' : t === "'" ? '′' : t);
      }
      const cmd = t.slice(1);
      if (cmd === '\\') return el('br');
      if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac' || cmd === 'cfrac') {
        const f = el('span', 'frac');
        const num = el('span', 'num');
        const den = el('span', 'den');
        const a = parseAtom();
        const b = parseAtom();
        if (a) num.append(a);
        if (b) den.append(b);
        f.append(num, den);
        return f;
      }
      if (cmd === 'sqrt') {
        const s = el('span', 'sqrt');
        if (peek() === '[') {
          next();
          const idx = el('sup', 'root');
          while (p < toks.length && peek() !== ']') { const a = parseAtom(); if (a) idx.append(a); }
          next();
          s.append(idx);
        }
        const rad = el('span', 'rad');
        const a = parseAtom();
        if (a) rad.append(a);
        s.append(text('√'), rad);
        return s;
      }
      if (cmd === 'text' || cmd === 'textrm' || cmd === 'mathrm' || cmd === 'operatorname' || cmd === 'textit' || cmd === 'mbox') {
        return el('span', 'mtext', readGroupText());
      }
      if (cmd === 'mathbf' || cmd === 'boldsymbol' || cmd === 'textbf' || cmd === 'bm') {
        const b = el('b');
        const a = parseAtom();
        if (a) b.append(a);
        return b;
      }
      if (cmd === 'mathbb') {
        const s = readGroupText();
        return text([...s].map((ch) => BB[ch] || ch).join(''));
      }
      if (cmd === 'mathcal' || cmd === 'mathit' || cmd === 'mathsf' || cmd === 'mathtt') {
        const a = parseAtom();
        return a || null;
      }
      if (cmd === 'overline' || cmd === 'underline') {
        const s = el('span', cmd === 'overline' ? 'over' : 'under');
        const a = parseAtom();
        if (a) s.append(a);
        return s;
      }
      if (ACCENTS[cmd]) {
        const a = parseAtom();
        const s = el('span');
        if (a && a.textContent.length === 1) {
          s.append(el('i', '', a.textContent + ACCENTS[cmd]));
        } else if (a) {
          s.className = 'over';
          s.append(a);
        }
        return s;
      }
      if (cmd === 'begin') return parseEnv();
      if (SIZERS.has(cmd)) {
        if (cmd === 'left' || cmd === 'right' || cmd.startsWith('big') || cmd.startsWith('Big') || cmd === 'middle') {
          const d = next();
          if (!d || d === '.') return null;
          return text(d.startsWith('\\') ? (SYM[d.slice(1)] || d.slice(1)) : d);
        }
        return null;
      }
      if (FUNCS.has(cmd)) return el('span', 'mfn', cmd);
      if (SYM[cmd] !== undefined) return text(SYM[cmd]);
      return el('span', 'mtext', cmd);
    }

    const root = el(display ? 'div' : 'span', display ? 'math math-block' : 'math');
    root.title = src;
    try {
      root.append(parseExpr(undefined));
    } catch {
      root.replaceChildren(text(src));
    }
    return root;
  }

  // ==== コードの色分け (軽量な字句解析) =====================================

  const KEYWORDS = new Set(('abstract and as assert async await break case catch class const continue def default defer del delete do elif else enum '
    + 'except export extends extern false final finally fn for foreach from func function global go goto if impl implements import in '
    + 'instanceof interface is lambda let loop match mod module mut namespace new nil none not null of operator or override package pass '
    + 'private protected pub public raise readonly ref return select self static struct super switch this throw throws trait true try '
    + 'type typedef typeof undefined union unsafe use using var virtual void volatile where while with yield True False None '
    + 'echo fi then done esac local function param begin end process '
    + 'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT AS AND OR NOT NULL '
    + 'int long short char float double bool boolean string str byte void auto unsigned signed size_t').split(' '));
  const HASH_COMMENT = new Set(['python', 'py', 'sh', 'bash', 'zsh', 'shell', 'ruby', 'rb', 'yaml', 'yml', 'toml', 'r', 'perl', 'pl', 'powershell', 'ps1', 'ps', 'dockerfile', 'makefile', 'make', 'conf', 'ini', 'nim', 'elixir', 'ex']);
  const DASH_COMMENT = new Set(['sql', 'lua', 'haskell', 'hs', 'elm', 'ada']);
  const NO_HIGHLIGHT = new Set(['text', 'txt', 'plain', 'plaintext', 'md', 'markdown', 'log', 'output', 'console']);
  const tokenRes = new Map(); // コメントの書式ごとに正規表現を使い回す

  function tokenRe(comment) {
    let re = tokenRes.get(comment);
    if (!re) {
      re = new RegExp(`(${comment})|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(\\b0x[0-9a-fA-F]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)|([A-Za-z_$][\\w$]*)(?=\\s*\\()|([A-Za-z_][\\w]*)`, 'g');
      tokenRes.set(comment, re);
    }
    re.lastIndex = 0;
    return re;
  }

  function highlight(src, lang) {
    const l = (lang || '').toLowerCase();
    const frag = document.createDocumentFragment();
    if (NO_HIGHLIGHT.has(l) || src.length > HIGHLIGHT_LIMIT) { frag.append(text(src)); return frag; }
    const re = tokenRe(HASH_COMMENT.has(l) ? '#[^\\n]*' : DASH_COMMENT.has(l) ? '--[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/');
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      const [all, c, s, n, fn, word] = m;
      const cls = c ? 'tk-c' : s ? 'tk-s' : n ? 'tk-n' : fn ? (KEYWORDS.has(fn) ? 'tk-k' : 'tk-f') : KEYWORDS.has(word) ? 'tk-k' : '';
      if (!cls) continue; // 色を付けない語は前後の文字とまとめて1つのテキストノードにする
      if (m.index > last) frag.append(text(src.slice(last, m.index)));
      frag.append(el('span', cls, all));
      last = m.index + all.length;
    }
    if (last < src.length) frag.append(text(src.slice(last)));
    return frag;
  }

  // ==== ブロック ============================================================

  function parseBlocks(lines, parent, depth) {
    if (depth > MAX_DEPTH) {
      parent.append(el('div', 'plain', lines.join('\n')));
      return;
    }
    let i = 0;
    let notMath = -1; // 数式の始まりの形だが、閉じ記号が無いので数式にしない行
    const mathDead = { '$$': -1, '\\]': -1 }; // 閉じ記号ごとに、「この行 (空行) まで閉じ記号が無い」と分かっている位置
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }

      let m = matchFence(line);
      if (m) {
        const fence = m[1];
        const start = i;
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
        // 最上位のブロックだけ、原文の行番号がそのまま使える (リストや引用の中は字下げや記号を外した後の行)
        const range = depth === 0 ? { start, end: i < lines.length ? i : -1 } : null;
        i++;
        parent.append(codeBlock(buf.join('\n'), m[2], range));
        continue;
      }

      m = i === notMath ? null : MATH_BLOCK_RE.exec(line);
      if (m) {
        // 数式のブロックは空行をまたがない。閉じ記号が無いまま空行に来たら数式にせず、段落として描く
        // (閉じ忘れた $$ が、回答の残りをすべて数式にしてしまわないように)。文末まで空行が無ければ、書きかけの数式として描く
        const close = m[1] === '$$' ? '$$' : '\\]';
        const body = [line.slice(m[0].length)]; // 行を配列に溜めて、最後に 1 度だけつなぐ
        let end = i < mathDead[close] ? -1 : body[0].indexOf(close); // 閉じ記号は改行をまたがないので、行ごとに探す
        let j = i + 1;
        if (i < mathDead[close]) j = mathDead[close]; // 手前の同じ記号が、この空行まで閉じ記号が無いことを確かめてある
        else while (end === -1 && j < lines.length && !isBlank(lines[j])) { body.push(lines[j]); end = lines[j].indexOf(close); j++; }
        if (end === -1 && j < lines.length) {
          mathDead[close] = j;
          notMath = i; // この行は下で段落 (または表) として読む
        } else {
          const last = body.length - 1;
          const after = end === -1 ? '' : body[last].slice(end + close.length).trim();
          if (end !== -1) body[last] = body[last].slice(0, end);
          parent.append(renderTex(body.join('\n').trim(), true));
          i = j;
          if (after) {
            const p = el('p');
            inline(after, p, depth);
            parent.append(p);
          }
          continue;
        }
      }

      if (HR_RE.test(line)) { parent.append(el('hr')); i++; continue; }

      m = line.match(HEADING_RE);
      if (m) {
        const h = el('h' + m[1].length);
        inline(headingText(m[2]), h, depth);
        parent.append(h);
        i++;
        continue;
      }

      if (QUOTE_RE.test(line)) {
        const buf = [];
        while (i < lines.length && !isBlank(lines[i])) {
          const q = lines[i].match(QUOTE_RE);
          buf.push(q ? q[1] : lines[i]);
          i++;
        }
        const bq = el('blockquote');
        parseBlocks(buf, bq, depth + 1);
        parent.append(bq);
        continue;
      }

      if (isTableStart(lines, i)) {
        i = parseTable(lines, i, parent, depth);
        continue;
      }

      if (LIST_RE.test(line)) {
        i = parseList(lines, i, parent, depth);
        continue;
      }

      const buf = [line];
      i++;
      // 空行を挟まずに表が続くこともある (「以下の表：」の次の行から表、など)。表の見出しの行で段落を終える
      while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines[i]) && !isTableStart(lines, i)) buf.push(lines[i++]);
      const p = el('p');
      inline(buf.map((l) => l.trim()).join('\n'), p, depth);
      parent.append(p);
    }
  }

  function codeShell(getSrc, lang, onEdit) {
    const wrap = el('div', 'codeblock');
    const bar = el('div', 'bar');
    bar.append(el('span', '', lang || 'code'));
    const copy = el('button', '', tx('common.copy'));
    copy.type = 'button';
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(getSrc()).then(() => {
        copy.textContent = tx('md.copied');
        setTimeout(() => { copy.textContent = tx('common.copy'); }, 1500);
      }).catch(() => { copy.textContent = tx('md.copyFailed'); });
    });
    const pre = el('pre');
    if (onEdit) {
      const edit = el('button', '', tx('common.edit'));
      edit.type = 'button';
      edit.addEventListener('click', () => onEdit(wrap, pre));
      const btns = el('span', 'bar-btns');
      btns.append(edit, copy);
      bar.append(btns);
    } else {
      bar.append(copy);
    }
    const code = el('code');
    pre.append(code);
    wrap.append(bar, pre);
    return { wrap, code };
  }

  function codeBlock(src, lang, range) {
    const handler = range && opts.onEditCode;
    const onEdit = handler ? (wrap, pre) => handler({ wrap, pre, src, start: range.start, end: range.end }) : null;
    const { wrap, code } = codeShell(() => src, lang, onEdit);
    if (opts.highlight) code.append(highlight(src, lang));
    else code.textContent = src;
    return wrap;
  }

  // 追記専用のテキスト。行の区切りで数KBごとに別のブロックへ分け、追記のたびに全文を組み直さずに済むようにする
  class TextChunks {
    constructor(parent) {
      this.parent = parent;
      this.node = null;
      this.len = 0;
    }

    open(s) {
      const block = el('div');
      this.node = text(s);
      this.len = s.length;
      block.append(this.node);
      this.parent.append(block);
    }

    append(s) {
      if (!s) return;
      if (!this.node) { this.open(s); return; }
      const nl = this.len >= CHUNK_CHARS ? s.indexOf('\n') : -1;
      if (nl === -1) {
        this.node.appendData(s);
        this.len += s.length;
        return;
      }
      this.node.appendData(s.slice(0, nl + 1));
      this.open(s.slice(nl + 1));
    }
  }

  // 生成中のコードブロック。完成するまで色分けせず、末尾に追記していく
  function liveCode(lang) {
    let src = '';
    const { wrap, code } = codeShell(() => src, lang);
    code.className = 'live';
    const chunks = new TextChunks(code);
    return {
      wrap,
      append(s) {
        src += s;
        chunks.append(s);
      },
    };
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let k = 0; k < s.length; k++) {
      if (s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
      if (s[k] === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += s[k];
    }
    cells.push(cur.trim());
    return cells;
  }

  function parseTable(lines, i, parent, depth) {
    const header = splitRow(lines[i]);
    const aligns = splitRow(lines[i + 1]).map((c) => {
      const l = c.startsWith(':');
      const r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    i += 2;
    const table = el('table');
    const thead = el('thead');
    const htr = el('tr');
    header.forEach((c, k) => {
      const th = el('th');
      if (aligns[k]) th.style.textAlign = aligns[k];
      inline(c, th, depth);
      htr.append(th);
    });
    thead.append(htr);
    const tbody = el('tbody');
    while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
      const tr = el('tr');
      const cells = splitRow(lines[i]);
      for (let k = 0; k < header.length; k++) {
        const td = el('td');
        if (aligns[k]) td.style.textAlign = aligns[k];
        inline(cells[k] || '', td, depth);
        tr.append(td);
      }
      tbody.append(tr);
      i++;
    }
    table.append(thead, tbody);
    const wrap = el('div', 'table-wrap');
    wrap.append(table);
    parent.append(wrap);
    return i;
  }

  function parseList(lines, i, parent, depth) {
    const first = lines[i].match(LIST_RE);
    const indent = indentOf(first[1]);
    const ordered = /\d/.test(first[2]);
    const list = el(ordered ? 'ol' : 'ul');
    if (ordered) {
      const n = parseInt(first[2], 10);
      if (n !== 1) list.start = n;
    }
    while (i < lines.length) {
      const m = lines[i].match(LIST_RE);
      if (!m || indentOf(m[1]) !== indent || /\d/.test(m[2]) !== ordered) break;
      const body = [m[3]];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (isBlank(l)) {
          if (i + 1 < lines.length && !isBlank(lines[i + 1]) && indentOf(lines[i + 1]) > indent) { body.push(''); i++; continue; }
          break;
        }
        const lm = l.match(LIST_RE);
        if (lm && indentOf(lm[1]) <= indent) break;
        if (!lm && indentOf(l) <= indent && isBlockStart(l)) break;
        body.push(l);
        i++;
      }
      const li = el('li');
      parseBlocks([body[0]].concat(dedent(body.slice(1))), li, depth + 1);
      if (li.childNodes.length === 1 && li.firstChild.tagName === 'P') {
        const p = li.firstChild; // 1行だけの項目は <p> を外して詰める
        while (p.firstChild) li.append(p.firstChild);
        p.remove();
      }
      list.append(li);
    }
    parent.append(list);
    return i;
  }

  // ==== インライン ==========================================================

  // noClose: 閉じ記号が見つからなかった位置を記号ごとに覚える。それより後ろから探しても見つからないので、
  // 閉じていない記号が大量にあっても文末までの検索を繰り返さない
  function findClose(s, delim, from, noClose) {
    if (from >= noClose.get(delim)) return -1;
    let k = s.indexOf(delim, from);
    while (k !== -1) {
      if (k > from && s[k - 1] !== ' ' && s[k - 1] !== '\\') return k;
      k = s.indexOf(delim, k + 1);
    }
    noClose.set(delim, from);
    return -1;
  }

  function link(label, url, parent, depth) {
    if (label === url) { parent.append(text(url)); return; }
    inline(label, parent, depth);
    parent.append(text(` (${url})`));
  }

  // $...$ をインライン数式として扱うか ("$5 と $10" のような金額は数式にしない)
  // seen: 直前に探した範囲 { from, at }。from 以降で最初の「\ の付かない $」が at (無ければ -1)。
  // その範囲の中から探しても同じ $ に行き着くので、\$ が大量に並んでいても検索を繰り返さない
  function inlineMathEnd(s, i, seen) {
    if (s[i + 1] === undefined || /[\s$]/.test(s[i + 1]) || /[A-Za-z0-9]/.test(s[i - 1] || '')) return -1;
    let k = seen.at;
    if (i + 1 < seen.from || (k !== -1 && i + 1 > k)) {
      k = i + 1;
      while ((k = s.indexOf('$', k)) !== -1 && s[k - 1] === '\\') k++;
      seen.from = i + 1;
      seen.at = k;
    }
    if (k === -1 || /\s/.test(s[k - 1]) || /\d/.test(s[k + 1] || '')) return -1;
    return k;
  }

  function inline(s, parent, depth) {
    depth = (depth || 0) + 1;
    if (depth > MAX_DEPTH) { parent.append(text(s)); return; }
    let buf = '';
    const flush = () => {
      if (buf) { parent.append(text(buf)); buf = ''; }
    };
    const matchAt = (re) => {
      re.lastIndex = i;
      return re.exec(s);
    };
    let i = 0;
    const noClose = new Map();
    // リンクと画像は、次の「]」の直後に「(」があるときだけ正規表現を試す。
    // 同じ「]」で失敗したら、その手前のどの「[」から試しても同じ結果なので試さない
    let closeBracket = -2;
    const deadClose = { image: -1, link: -1 };
    // 「](」の後ろの URL の範囲も覚える。空白も「)」も無いまま「](」が繰り返されると (URL の中で同じ文を繰り返す出力)、
    // そのたびに文末まで読むことになる (80KB で 約 1.8 秒。実測)。同じ並びの中から始まる URL は、同じ位置で終わる
    let urlFrom = -1;
    let urlTo = -1;
    // 画像 ![代替](URL "題名") / リンク [文字](URL "題名") なら { label, url, end }。画像は代替と URL が空でもよい
    const matchBracket = (kind) => {
      if (closeBracket !== -1 && closeBracket < i) closeBracket = s.indexOf(']', i);
      const close = closeBracket;
      if (close === -1 || s[close + 1] !== '(' || deadClose[kind] === close) return null;
      const image = kind === 'image';
      const labelFrom = i + (image ? 2 : 1);
      const from = close + 2;
      if (from < urlFrom || from > urlTo) {
        LINK_URL_RE.lastIndex = from;
        LINK_URL_RE.test(s);
        urlFrom = from;
        urlTo = LINK_URL_RE.lastIndex;
      }
      let end = urlTo;
      let ok = image || (close > labelFrom && end > from);
      if (ok) {
        if (s[end] === ')') end++;
        else {
          LINK_TITLE_RE.lastIndex = end;
          ok = LINK_TITLE_RE.test(s);
          end = LINK_TITLE_RE.lastIndex;
        }
      }
      if (!ok) { deadClose[kind] = close; return null; }
      return { label: s.slice(labelFrom, close), url: s.slice(from, urlTo), end };
    };
    const mathSeen = { from: Infinity, at: -1 };
    const deadEm = { '*': -1, _: -1 }; // 斜体の閉じ記号として見つけたが、後ろの文字のせいで使えなかった位置
    while (i < s.length) {
      PLAIN_RE.lastIndex = i;
      if (PLAIN_RE.test(s)) {
        buf += s.slice(i, PLAIN_RE.lastIndex);
        i = PLAIN_RE.lastIndex;
        continue;
      }
      const c = s[i];
      let m;

      if (c === '\\' && (s[i + 1] === '(' || s[i + 1] === '[')) {
        const close = s[i + 1] === '(' ? '\\)' : '\\]';
        const end = i + 2 >= noClose.get(close) ? -1 : s.indexOf(close, i + 2);
        if (end === -1) noClose.set(close, i + 2);
        if (end !== -1) {
          flush();
          parent.append(renderTex(s.slice(i + 2, end), s[i + 1] === '['));
          i = end + 2;
          continue;
        }
      }

      if (c === '\\' && i + 1 < s.length && /[!-\/:-@\[-`{-~]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }

      if (c === '\n') { flush(); parent.append(el('br')); i++; continue; }

      if (c === '$') {
        if (s[i + 1] === '$') {
          const end = s.indexOf('$$', i + 2);
          if (end !== -1) {
            flush();
            parent.append(renderTex(s.slice(i + 2, end), false));
            i = end + 2;
            continue;
          }
        } else {
          const end = inlineMathEnd(s, i, mathSeen);
          if (end !== -1) {
            flush();
            parent.append(renderTex(s.slice(i + 1, end), false));
            i = end + 1;
            continue;
          }
        }
      }

      if (c === '`') {
        const run = matchAt(BACKTICKS_RE)[0];
        const end = s.indexOf(run, i + run.length);
        if (end !== -1) {
          flush();
          parent.append(el('code', '', s.slice(i + run.length, end).replace(/^ (.+) $/, '$1')));
          i = end + run.length;
          continue;
        }
        buf += run;
        i += run.length;
        continue;
      }

      if (c === '!' && s[i + 1] === '[' && (m = matchBracket('image'))) {
        flush();
        parent.append(el('span', 'img-alt', tx('md.imageAlt', { alt: m.label || m.url })));
        i = m.end;
        continue;
      }

      if (c === '[' && (m = matchBracket('link'))) {
        flush();
        link(m.label, m.url, parent, depth);
        i = m.end;
        continue;
      }

      if ((c === 'h' || c === 'H') && !/[A-Za-z0-9]/.test(s[i - 1] || '') && (m = matchAt(URL_RE))) {
        // 末尾の句読点は URL に含めない。後ろから 1 字ずつ外す (正規表現の $ で外すと、句読点が長く続くときに後戻りが増える)
        let urlEnd = m[0].length;
        while (urlEnd > 0 && URL_TAIL.includes(m[0][urlEnd - 1])) urlEnd--;
        const url = m[0].slice(0, urlEnd);
        flush();
        link(url, url, parent, depth);
        i += url.length;
        continue;
      }

      if ((c === '*' || c === '_') && s[i + 1] === c && s[i + 2] && s[i + 2] !== ' ') {
        const end = findClose(s, c + c, i + 2, noClose);
        if (end !== -1) {
          flush();
          const strong = el('strong');
          inline(s.slice(i + 2, end), strong, depth);
          parent.append(strong);
          i = end + 2;
          continue;
        }
      }

      if (c === '~' && s[i + 1] === '~' && s[i + 2] && s[i + 2] !== ' ') {
        const end = findClose(s, '~~', i + 2, noClose);
        if (end !== -1) {
          flush();
          const del = el('del');
          inline(s.slice(i + 2, end), del, depth);
          parent.append(del);
          i = end + 2;
          continue;
        }
      }

      // deadEm より手前から探すと、同じ閉じ記号に行き着いて同じ理由で使えないので、探さない
      if ((c === '*' || c === '_') && s[i + 1] && s[i + 1] !== ' ' && s[i + 1] !== c && !(c === '_' && /[A-Za-z0-9]/.test(s[i - 1] || '')) && i + 1 >= deadEm[c]) {
        const end = findClose(s, c, i + 1, noClose);
        if (end !== -1) {
          if (s[end + 1] !== c && !(c === '_' && /[A-Za-z0-9]/.test(s[end + 1] || ''))) {
            flush();
            const em = el('em');
            inline(s.slice(i + 1, end), em, depth);
            parent.append(em);
            i = end + 1;
            continue;
          }
          deadEm[c] = end;
        }
      }

      buf += c;
      i++;
    }
    flush();
  }

  // コードブロックの中身だけを置き換えた原文を返す。start / end は render が渡す行番号 (end = -1 は閉じていないブロック)
  // 新しい中身に閉じ記号と同じ行があるとブロックがそこで切れるので、そのときは記号を長くする
  function replaceCode(src, start, end, code) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const m = matchFence(lines[start]);
    const body = code.replace(/\r\n?/g, '\n').split('\n');
    let fence = m[1];
    while (body.some((l) => l.trim().startsWith(fence))) fence += fence[0];
    const indent = lines[start].match(/^\s*/)[0];
    const after = end === -1 ? [] : lines.slice(end + 1);
    const info = lines[start].slice(m[0].length).trim(); // 言語名の後ろに続く語 (title="a.js" など) も残す
    return [...lines.slice(0, start), indent + fence + info, ...body, indent + fence, ...after].join('\n');
  }

  // options.highlight = false: 生成中の末尾など、頻繁に描き直す部分では色分けを省いて軽くする
  // options.onEditCode: 最上位のコードブロックに編集ボタンを付ける。押されると { wrap, pre, src, start, end } を渡す
  function render(src, options) {
    const prev = opts;
    opts = { highlight: true, ...(options || {}) };
    try {
      const frag = document.createDocumentFragment();
      parseBlocks(String(src).replace(/\r\n?/g, '\n').split('\n'), frag, 0);
      return frag;
    } finally {
      opts = prev;
    }
  }

  return { render, replaceCode, liveCode, TextChunks, matchFence, lineKind, isTableSep, QUOTE_RE };
})();
