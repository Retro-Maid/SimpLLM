'use strict';

// ---------------------------------------------------------------------------
// モデルが呼び出せるローカルツール (すべてブラウザ内で完結し、外部へは通信しない)
// - get_current_datetime: 現在の日時
// - calculate: 数式の計算 (eval は使わず、自前の構文解析で計算する)
// - search_conversations: このブラウザに保存された過去の会話の検索
// ---------------------------------------------------------------------------

const Tools = (() => {
  const DEFS = [
    {
      type: 'function',
      function: {
        name: 'get_current_datetime',
        description: tx('model.tool.datetime'),
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: tx('model.tool.calculate'),
        parameters: {
          type: 'object',
          properties: { expression: { type: 'string', description: tx('model.tool.calculateArg') } },
          required: ['expression'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_conversations',
        description: tx('model.tool.search'),
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: tx('model.tool.searchArg') } },
          required: ['query'],
        },
      },
    },
  ];

  // ---- 計算機 (再帰下降構文解析) -----------------------------------------

  const FN = {
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    log: Math.log10, log10: Math.log10, ln: Math.log, log2: Math.log2, exp: Math.exp,
  };
  const CONST = { pi: Math.PI, e: Math.E };

  function calculate(expr) {
    const src = String(expr).replace(/[×✕]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').replace(/\*\*/g, '^').replace(/,/g, '');
    if (src.length > 500) throw new Error(tx('model.calc.tooLong'));
    const toks = src.match(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+|[A-Za-z_]\w*|[-+*/%^()]|\S/g) || [];
    let p = 0;
    const peek = () => toks[p];
    const eat = (t) => { if (toks[p] !== t) throw new Error(tx('model.calc.expected', { token: t })); p++; };

    function expression() {
      let v = term();
      while (peek() === '+' || peek() === '-') v = toks[p++] === '+' ? v + term() : v - term();
      return v;
    }
    function term() {
      let v = unary();
      while (peek() === '*' || peek() === '/' || peek() === '%') {
        const op = toks[p++];
        const r = unary();
        v = op === '*' ? v * r : op === '/' ? v / r : v % r;
      }
      return v;
    }
    function unary() {
      if (peek() === '-') { p++; return -unary(); }
      if (peek() === '+') { p++; return unary(); }
      return power();
    }
    function power() {
      const base = primary();
      if (peek() === '^') { p++; return Math.pow(base, unary()); }
      return base;
    }
    function primary() {
      const t = toks[p++];
      if (t === undefined) throw new Error(tx('model.calc.incomplete'));
      if (t === '(') { const v = expression(); eat(')'); return v; }
      if (/^(\d|\.\d)/.test(t)) return Number(t);
      const name = t.toLowerCase();
      // 自分の項目だけを見る (constructor や __proto__ のような、どのオブジェクトにもある名前を関数や定数として扱わない)
      if (Object.hasOwn(FN, name)) { eat('('); const v = expression(); eat(')'); return FN[name](v); }
      if (Object.hasOwn(CONST, name)) return CONST[name];
      throw new Error(tx('model.calc.badSymbol', { token: t }));
    }

    const v = expression();
    if (p < toks.length) throw new Error(tx('model.calc.unparsed', { rest: toks.slice(p).join(' ') }));
    if (!Number.isFinite(v)) throw new Error(tx('model.calc.notNumber'));
    return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(15)));
  }

  function datetime() {
    // 日付・曜日・時刻は、画面の言語の書き方にする
    const date = new Intl.DateTimeFormat(I18n.locale, { dateStyle: 'full', timeStyle: 'medium' }).format(new Date());
    return tx('model.datetime', { date, zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  }

  function search(query, chats, excludeId) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return tx('model.search.empty');
    const hits = [];
    for (const chat of chats) {
      if (chat.id === excludeId) continue;
      for (const m of chat.messages) {
        if (m.role === 'image') continue; // 画像の指示は AI に渡さない
        const low = m.content.toLowerCase();
        if (!words.every((w) => low.includes(w))) continue;
        const at = Math.max(0, low.indexOf(words[0]) - 80);
        const snippet = m.content.slice(at, at + 300).replace(/\s+/g, ' ');
        const date = new Date(chat.updatedAt).toLocaleDateString(I18n.locale);
        hits.push(tx('model.search.hit', { title: chat.title, date, role: tx(m.role === 'user' ? 'model.search.user' : 'model.search.ai'), snippet }));
        if (hits.length >= 8) break;
      }
      if (hits.length >= 8) break;
    }
    return hits.length ? tx('model.search.found', { count: hits.length, hits: hits.join('\n') }) : tx('model.search.none');
  }

  // 引数は JSON 文字列で届く。失敗してもエラー文をモデルに返して続行させる
  function run(name, argsJson, ctx) {
    let args = {};
    try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { return tx('model.tool.badArgs'); }
    try {
      if (name === 'get_current_datetime') return datetime();
      if (name === 'calculate') return calculate(args.expression);
      if (name === 'search_conversations') return search(args.query || '', ctx.chats, ctx.currentId);
      return tx('model.tool.unknown', { name });
    } catch (e) {
      return tx('model.tool.errorPrefix') + e.message;
    }
  }

  return { DEFS, run };
})();
