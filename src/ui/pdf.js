'use strict';

// ---------------------------------------------------------------------------
// PDF からテキストだけを取り出す軽量な抽出器 (外部ライブラリなし)
// - FlateDecode の展開はブラウザ内蔵の DecompressionStream を使う
// - フォントの ToUnicode CMap を読んで文字コードを Unicode に戻す (日本語 PDF の多くはこれで読める)
// - 対応外: 暗号化 PDF、画像だけの PDF (スキャン)、ToUnicode を持たない特殊なフォント
// - PDF の中身は表示せず文字列としてだけ扱うので、PDF 内のスクリプト等が実行されることはない
// ---------------------------------------------------------------------------

const PdfText = (() => {
  function createExtraction(options) {
  const maxChars = options.maxChars || 512 * 1024;
  const maxExpanded = options.maxExpanded || 64 * 1024 * 1024;
  const MAX_PARTS = 100000; // オブジェクトの数
  const MAX_PAGES = 5000;
  const MAX_ARRAY = 1000000; // 1 つの配列 (TJ など) の要素の数
  const MAX_CMAP_ENTRIES = 250000; // フォント 1 つの対応表の項目の数
  const MAX_CMAP_RANGES = 1024; // 範囲のまま持つ bfrange の数
  let expanded = 0;
  // 上限を超えたときの例外。文言は原因ごとに分ける (取り出した文字が多い / 展開した中身が大きい / 要素が多い / フォントの対応表が大きい)
  const limitError = (message) => Object.assign(new Error(message), { name: 'PdfLimitError' });
  const tooLong = () => limitError(tx('attach.textTooLong', { count: maxChars.toLocaleString(I18n.locale) }));
  const tooMuchData = () => limitError(tx('pdf.tooMuchData', { mb: Math.max(1, Math.round(maxExpanded / 1024 / 1024)) }));
  const tooManyParts = () => limitError(tx('pdf.tooManyParts'));
  const fontMapTooBig = () => limitError(tx('pdf.fontMapTooBig'));
  const check = () => options.signal?.throwIfAborted();
  // TextDecoder('latin1') は実際には windows-1252 で、0x80-0x9F が別の文字になるため使わない。1バイト = 1文字に変換する
  const latin1 = {
    decode(u8) {
      let s = '';
      for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
      return s;
    },
  };
  const utf16 = new TextDecoder('utf-16be');
  const MAX_OUTPUT = 50 * 1024 * 1024;
  const OPERAND_RE = /[^\s/<>\[\]()%{}]*/y;

  // 大きな PDF の処理中も画面が固まらないよう、ときどき処理を譲る
  let lastBreath = 0;
  async function breathe() {
    check();
    if (performance.now() - lastBreath < 32) return;
    // setTimeout は裏のタブだと約1秒に間引かれるので、使えるなら scheduler.yield を使う
    await (globalThis.scheduler && scheduler.yield ? scheduler.yield() : new Promise((r) => setTimeout(r)));
    lastBreath = performance.now();
  }

  async function decodeBytes(bytes) {
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 65536) {
      chunks.push(latin1.decode(bytes.subarray(i, i + 65536)));
      await breathe();
    }
    return chunks.join('');
  }

  // count: 展開した量を、全体の上限 (maxExpanded) に数えるか。同じストリームを展開し直すときは数えない
  async function inflate(bytes, count) {
    // 末尾にゴミが付いた圧縮データでも、展開できたところまでは使う
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    let finished = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { finished = true; break; }
        if (total + value.length > MAX_OUTPUT || (count && expanded + value.length > maxExpanded)) throw tooMuchData();
        if (count) expanded += value.length;
        chunks.push(value);
        total += value.length;
      }
    } catch (e) { if (e?.name === 'PdfLimitError' || e?.name === 'AbortError') throw e; /* truncated compressed stream */ }
    finally {
      if (!finished) await reader.cancel().catch(() => {}); // 上限を超えたとき・途中で壊れていたときは、展開も止める
      reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  // ---- オブジェクトの読み取り ---------------------------------------------

  async function readObjects(bytes) {
    const s = await decodeBytes(bytes);
    const objects = new Map();
    const re = /(\d+)\s+\d+\s+obj\b/g;
    let m;
    while ((m = re.exec(s))) {
      const num = Number(m[1]);
      const start = m.index + m[0].length;
      const end = s.indexOf('endobj', start);
      if (end === -1) break;
      let body = s.slice(start, end);
      let stream = null;
      const sk = body.search(/\bstream\r?\n/);
      if (sk !== -1) {
        const dataStart = start + sk + body.slice(sk).match(/^stream\r?\n/)[0].length;
        let dataEnd = s.indexOf('endstream', dataStart);
        if (dataEnd === -1 || dataEnd > end) dataEnd = end;
        // データの終わり: 辞書の /Length (数で書いてあるとき) が endstream の直前を指していれば、それに従う。
        // そうでなければ endstream の前の改行を 1 つだけ外す。いくつでも外すと、データの最後のバイトが 0x0A / 0x0D のとき
        // (圧縮データの末尾の検査値など) に欠ける
        const length = body.slice(0, sk).match(/\/Length\s+(\d+)\b(?!\s+\d+\s+R)/);
        const byLength = length ? dataStart + Number(length[1]) : -1;
        if (byLength >= dataStart && byLength <= dataEnd && dataEnd - byLength <= 2 && /^[\r\n]*$/.test(s.slice(byLength, dataEnd))) dataEnd = byLength;
        else {
          if (dataEnd > dataStart && s[dataEnd - 1] === '\n') dataEnd--;
          if (dataEnd > dataStart && s[dataEnd - 1] === '\r') dataEnd--;
        }
        stream = bytes.subarray(dataStart, dataEnd);
        body = body.slice(0, sk);
      }
      if (objects.size >= MAX_PARTS) throw tooManyParts();
      objects.set(num, { dict: body, raw: stream, data: null });
      re.lastIndex = end;
      await breathe();
    }
    // 圧縮オブジェクトストリーム (PDF 1.5 以降) の中身も展開して登録する
    for (const obj of [...objects.values()]) {
      if (!/\/Type\s*\/ObjStm\b/.test(obj.dict)) continue;
      await breathe();
      const data = await decodeBytes(await streamData(obj));
      obj.data = null;
      const n = Number((obj.dict.match(/\/N\s+(\d+)/) || [])[1] || 0);
      const first = Number((obj.dict.match(/\/First\s+(\d+)/) || [])[1] || 0);
      if (n > MAX_PARTS || objects.size + n > MAX_PARTS) throw tooManyParts();
      const nums = data.slice(0, first).trim().split(/\s+/).map(Number);
      for (let k = 0; k < n; k++) {
        if ((k & 1023) === 0) await breathe();
        const num = nums[k * 2];
        const off = first + nums[k * 2 + 1];
        const nextOff = k + 1 < n ? first + nums[k * 2 + 3] : data.length;
        if (!objects.has(num)) objects.set(num, { dict: data.slice(off, nextOff), raw: null, data: null });
      }
    }
    return { s, objects };
  }

  async function streamData(obj) {
    if (obj.data) return obj.data;
    if (!obj.raw) return new Uint8Array(0);
    const filter = (obj.dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/) || [])[1] || '';
    if (/DCTDecode|JPXDecode|CCITTFax|JBIG2/.test(filter)) obj.data = new Uint8Array(0); // 画像は不要
    else if (/FlateDecode/.test(filter)) obj.data = await inflate(obj.raw, !obj.counted);
    else if (!filter) {
      if (!obj.counted) { expanded += obj.raw.length; if (expanded > maxExpanded) throw tooMuchData(); }
      obj.data = obj.raw;
    } else obj.data = new Uint8Array(0);
    // 展開した量を数えるのは、オブジェクトごとに 1 度だけ。使い終わると data を手放すので、何ページもが同じストリームを使うと
    // そのたびに展開し直す。そのたびに数えると、小さな PDF でも上限を超える
    obj.counted = true;
    return obj.data;
  }

  const refs = (str) => [...str.matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => Number(x[1]));

  // ---- ToUnicode CMap -----------------------------------------------------

  function hexToStr(hex) {
    const h = hex.length % 4 === 0 ? hex : hex.padStart(Math.ceil(hex.length / 4) * 4, '0');
    const b = new Uint8Array(h.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
    return utf16.decode(b);
  }

  // codeLen: codespacerange に書かれた 1 文字のバイト数 (書かれていなければ 0)。
  // keyLen: 対応表に出てくる文字コードのバイト数 (codespacerange が無いときの手がかり)
  // map: 文字コード → 文字。ranges: 256 個を超える bfrange (仕様では 1 つの範囲は 256 個までだが、<0000> <FFFF> と書く PDF がある)。
  // 大きな範囲を 1 字ずつ map に入れると、そういうフォントが数個あるだけで何十万項目にもなるので、範囲のまま持って読むときに計算する。
  // map に無い文字コードだけを ranges で探す (後ろに書かれた範囲が優先)
  async function parseCMap(src) {
    if (src.length > 8 * 1024 * 1024) throw fontMapTooBig();
    const map = new Map();
    const ranges = [];
    let entries = 0;
    const put = (key, value) => {
      if (++entries > MAX_CMAP_ENTRIES) throw fontMapTooBig();
      map.set(key, value);
    };
    let codeLen = 0;
    let keyLen = 0;
    const key = (hex) => { keyLen = Math.max(keyLen, Math.ceil(hex.length / 2)); return parseInt(hex, 16); };
    for (const m of src.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
      const h = m[1].match(/<([0-9a-fA-F]+)>/);
      if (h) codeLen = Math.max(1, h[1].length / 2);
    }
    for (const m of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) { put(key(p[1]), hexToStr(p[2])); if ((entries & 4095) === 0) await breathe(); }
    }
    for (const m of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
        const lo = key(p[1]);
        const hi = Math.min(parseInt(p[2], 16), lo + 65535);
        if (p[3].startsWith('[')) {
          const items = [...p[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexToStr(x[1]));
          for (let c = lo; c <= hi && c - lo < items.length; c++) { put(c, items[c - lo]); if ((entries & 4095) === 0) await breathe(); }
        } else {
          const base = p[3].slice(1, -1);
          const start = hexToStr(base);
          const prefix = start.slice(0, -1);
          const last = start.charCodeAt(start.length - 1);
          if (hi - lo >= 256) {
            if (ranges.length >= MAX_CMAP_RANGES) throw fontMapTooBig();
            ranges.push({ lo, hi, prefix, last });
            continue;
          }
          for (let c = lo; c <= hi; c++) { put(c, prefix + String.fromCharCode(last + (c - lo))); if ((entries & 4095) === 0) await breathe(); }
        }
      }
    }
    return { map, ranges, codeLen, keyLen };
  }

  // 文字コードに対応する文字 (無ければ undefined)
  function mapped(font, code) {
    const u = font.map.get(code);
    if (u !== undefined) return u;
    for (let k = font.ranges.length - 1; k >= 0; k--) {
      const r = font.ranges[k];
      if (code >= r.lo && code <= r.hi) return r.prefix + String.fromCharCode(r.last + (code - r.lo));
    }
    return undefined;
  }

  // フォントの名前 (/F1 など) はページごとの Resources の中だけで有効。別のページでは同じ名前が別のフォントを指しうる
  async function loadFonts(objects) {
    const cmapByObj = new Map();
    const cmapByRef = new Map(); // ToUnicode のオブジェクト番号 → 読んだ対応表 (いくつものフォントが同じ対応表を指すことがある。1 度だけ読む)
    const fontInfo = async (num) => {
      if (cmapByObj.has(num)) return cmapByObj.get(num);
      const obj = objects.get(num);
      let info = { map: null, ranges: null, codeLen: 1 };
      if (obj) {
        const type0 = /\/Subtype\s*\/Type0/.test(obj.dict); // 2 バイトで 1 文字 (日本語のフォントの多く)
        const tu = obj.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
        if (tu && objects.get(Number(tu[1]))) {
          const ref = Number(tu[1]);
          let cmap = cmapByRef.get(ref);
          if (!cmap) {
            const cmapObj = objects.get(ref);
            cmap = await parseCMap(await decodeBytes(await streamData(cmapObj)));
            cmapObj.data = null;
            cmapByRef.set(ref, cmap);
          }
          // codespacerange が無い CMap もある。そのときは Type0 なら 2 バイト、それ以外は対応表の文字コードの長さで読む
          info = { map: cmap.map, ranges: cmap.ranges, codeLen: cmap.codeLen || (type0 ? 2 : Math.max(1, cmap.keyLen)) };
        } else if (type0) info.codeLen = 2;
      }
      cmapByObj.set(num, info);
      return info;
    };
    // 辞書の中の /Font (直接 << >> か、参照) から 名前 → フォント を作る
    const fontsIn = async (dict) => {
      const byName = new Map();
      for (const fm of dict.matchAll(/\/Font\s*(<<[\s\S]*?>>|\d+\s+\d+\s+R)/g)) {
        let inner = fm[1];
        if (!inner.startsWith('<<')) {
          const ref = objects.get(refs(inner)[0]);
          if (!ref) continue;
          inner = ref.dict;
        }
        for (const e of inner.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) byName.set(e[1], await fontInfo(Number(e[2])));
      }
      return byName;
    };
    // 予備: ファイル全体から集めたもの (ページの Resources を見つけられないとき・そこに無い名前のとき)
    const all = new Map();
    for (const obj of objects.values()) {
      await breathe();
      for (const [name, info] of await fontsIn(obj.dict)) all.set(name, info);
    }
    const byResources = new Map(); // 同じ Resources を使うページで作り直さない
    // そのページで有効なフォント。Resources はページか、親の Pages から受け継ぐ
    const forPage = async (page) => {
      let node = page;
      let res = null;
      for (let depth = 0; node && depth < 50 && res === null; depth++) {
        const r = node.dict.match(/\/Resources\s*(\d+\s+\d+\s+R|<<)/);
        if (r) { res = r[1] === '<<' ? node.dict : ((objects.get(refs(r[1])[0]) || {}).dict || ''); break; }
        const parent = node.dict.match(/\/Parent\s+(\d+)\s+\d+\s+R/);
        node = parent ? objects.get(Number(parent[1])) : null;
      }
      if (!res) return all;
      if (byResources.has(res)) return byResources.get(res);
      const own = await fontsIn(res);
      const merged = own.size ? new Map([...all, ...own]) : all;
      byResources.set(res, merged);
      return merged;
    };
    return { all, forPage };
  }

  // ---- ページ順に並べる ----------------------------------------------------

  function pageOrder(s, objects) {
    const roots = [...s.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)];
    const pages = [];
    const seen = new Set();
    // ページが多すぎるときは、途中までで黙って打ち切らずに、読み込めないと知らせる
    const add = (obj) => { if (pages.length >= MAX_PAGES) throw tooManyParts(); pages.push(obj); };
    const walk = (num) => {
      if (seen.has(num)) return;
      seen.add(num);
      const obj = objects.get(num);
      if (!obj) return;
      if (/\/Type\s*\/Page\b/.test(obj.dict)) { add(obj); return; }
      const kids = obj.dict.match(/\/Kids\s*\[([^\]]*)\]/);
      if (kids) for (const k of refs(kids[1])) walk(k);
    };
    if (roots.length) {
      const cat = objects.get(Number(roots[roots.length - 1][1]));
      const p = cat && cat.dict.match(/\/Pages\s+(\d+)\s+\d+\s+R/);
      if (p) walk(Number(p[1]));
    }
    if (pages.length) return pages;
    for (const o of objects.values()) if (/\/Type\s*\/Page\b/.test(o.dict)) add(o); // 見つからなければ出現順
    return pages;
  }

  // ---- コンテンツストリームから文字を取り出す -------------------------------

  const LITERAL_ESC = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
  // /\s/ と同じ判定を、1文字ごとの正規表現なしで行う
  const isSpace = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\v' || c === ' '; // 中身は 1 バイト = 1 文字なので、0xFF までの空白 (最後は U+00A0) だけを見る

  // 文字列 1 つごとに await すると、1 文字ずつ文字列を分けて書く PDF (よくある) で待ちの回数が文字数の何倍にもなる
  // (20 万個の文字列で 約 320ms → 約 740ms。実測)。長さに上限があるので、文字列の読み取りは途中で譲らずに済ませる
  const LITERAL_RUN = /[^()\\]{1,8192}/y;
  function readLiteral(src, i) {
    let depth = 1, chars = 0;
    const parts = [];
    const append = (part) => { chars += part.length; if (chars > maxChars * 4) throw tooLong(); parts.push(part); };
    i++;
    while (i < src.length && depth > 0) {
      LITERAL_RUN.lastIndex = i;
      const run = LITERAL_RUN.exec(src);
      if (run) { append(run[0]); i += run[0].length; continue; }
      const c = src[i];
      if (c === '\\') {
        const n = src[i + 1];
        if (n in LITERAL_ESC) { append(LITERAL_ESC[n]); i += 2; continue; }
        if (/[0-7]/.test(n)) {
          const oct = src.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
          append(String.fromCharCode(parseInt(oct, 8) & 255));
          i += 1 + oct.length;
          continue;
        }
        if (n === '\r' || n === '\n') { i += 2; if (n === '\r' && src[i] === '\n') i++; continue; }
        i += 2;
        continue;
      }
      if (c === '(') depth++;
      if (c === ')' && --depth === 0) { i++; break; }
      append(c);
      i++;
    }
    return { str: parts.join(''), next: i };
  }

  // bin の from 〜 to を、フォントの対応表で文字に直す
  function decodeRange(bin, font, from, to) {
    let out = '';
    const len = font.codeLen;
    for (let i = from; i + len <= to; i += len) {
      let code = 0;
      for (let k = 0; k < len; k++) code = code * 256 + bin.charCodeAt(i + k);
      const u = mapped(font, code);
      out += u !== undefined ? u : (len === 1 ? bin[i] : '');
    }
    return out;
  }

  async function decodeLong(bin, font, step) {
    const parts = [];
    for (let i = 0; i < bin.length; i += step) {
      if (i) await breathe();
      parts.push(decodeRange(bin, font, i, Math.min(bin.length, i + step)));
    }
    return parts.join('');
  }

  // 文字列をそのまま返す。長い文字列だけ、途中で処理を譲る Promise を返す (呼び出し側は、Promise のときだけ await する)
  function decodeString(bin, font) {
    if (!font || !font.map) {
      if (font && font.codeLen === 2) return ''; // CMap 無しの2バイトフォントは復元できない
      return bin.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    }
    const step = 8192 * font.codeLen; // 文字の途中で区切らない
    return bin.length <= step ? decodeRange(bin, font, 0, bin.length) : decodeLong(bin, font, step);
  }

  async function extractContent(src, fonts, out) {
    let font = null;
    let stack = [];
    let open = 0; // 閉じていない [ の数
    let lastY = null;
    const nl = () => { if (out.length && out[out.length - 1] !== '\n') out.push('\n'); };
    // 文字列を文字に直して出す。長い文字列のときだけ Promise を返す (そのときだけ await する)
    const show = (s) => {
      const piece = decodeString(s, font);
      if (typeof piece === 'string') { out.push(piece); return null; }
      return piece.then((t) => { out.push(t); });
    };
    let i = 0, yieldAt = 0;
    while (i < src.length) {
      if (i >= yieldAt) { await breathe(); yieldAt = i + 8192; }
      // 演算子の無いまま値が溜まり続けるとき: 配列の外なら、文字を出す演算子が使うのは最後の数個だけなので古い値を捨てる。
      // 配列の中 (1 行ぶんの文字列と字間を並べた TJ など) は捨てられないので、要素の数に上限を置く
      if (stack.length > 100000) {
        if (!open) stack = stack.slice(-16);
        else if (stack.length > MAX_ARRAY) throw tooManyParts();
      }
      const c = src[i];
      if (c === '%') { const lf = src.indexOf('\n', i), cr = src.indexOf('\r', i); i = Math.min(lf < 0 ? src.length : lf, cr < 0 ? src.length : cr); continue; }
      if (isSpace(c)) { i++; continue; }
      if (c === '(') { const r = readLiteral(src, i); stack.push({ s: r.str }); i = r.next; continue; }
      if (c === '<' && src[i + 1] !== '<') {
        const end = src.indexOf('>', i);
        const hex = src.slice(i + 1, end === -1 ? src.length : end).replace(/\s+/g, '');
        if (hex.length > maxChars * 8) throw tooLong();
        let bin = '';
        for (let k = 0; k < hex.length; k += 2) { if (k && (k & 8191) === 0) await breathe(); bin += String.fromCharCode(parseInt((hex.substr(k, 2) + '0').slice(0, 2), 16)); }
        stack.push({ s: bin });
        i = end === -1 ? src.length : end + 1;
        continue;
      }
      if (c === '<' || c === '>') { i += 2; continue; } // 辞書 << >> は無視
      if (c === '[') { stack.push('['); open++; i++; continue; }
      if (c === ']') {
        const arr = [];
        while (stack.length && stack[stack.length - 1] !== '[') arr.push(stack.pop());
        arr.reverse();
        stack.pop();
        if (open) open--;
        stack.push({ a: arr });
        i++;
        continue;
      }
      if (c === '/') {
        OPERAND_RE.lastIndex = i + 1;
        const m = OPERAND_RE.exec(src)[0];
        stack.push({ n: m });
        i += 1 + m.length;
        continue;
      }
      OPERAND_RE.lastIndex = i;
      const word = OPERAND_RE.exec(src)[0];
      if (!word) { i++; continue; }
      i += word.length;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { stack.push(Number(word)); continue; }
      switch (word) {
        case 'Tf': {
          const name = stack.find((x) => x && x.n !== undefined);
          font = name ? fonts.get(name.n) || null : null;
          break;
        }
        case 'Tj': {
          const str = stack[stack.length - 1];
          if (str && str.s !== undefined) { const wait = show(str.s); if (wait) await wait; }
          break;
        }
        case "'": case '"': {
          nl();
          const str = stack[stack.length - 1];
          if (str && str.s !== undefined) { const wait = show(str.s); if (wait) await wait; }
          break;
        }
        case 'TJ': {
          const arr = stack[stack.length - 1];
          if (arr && arr.a) {
            let n = 0;
            for (const item of arr.a) {
              if ((++n & 8191) === 0) await breathe();
              if (item && item.s !== undefined) { const wait = show(item.s); if (wait) await wait; }
              else if (typeof item === 'number' && item < -250) out.push(' ');
            }
          }
          break;
        }
        case 'Td': case 'TD': {
          const ty = stack[stack.length - 1];
          if (typeof ty === 'number' && Math.abs(ty) > 0.01) nl();
          break;
        }
        case 'Tm': {
          const y = stack[stack.length - 1];
          if (typeof y === 'number') { if (lastY !== null && Math.abs(y - lastY) > 0.01) nl(); lastY = y; }
          break;
        }
        case 'T*': nl(); break;
        case 'ET': nl(); break;
        default: break;
      }
      stack = [];
      open = 0;
    }
    nl();
  }

  async function extract(buffer) {
    const bytes = new Uint8Array(buffer);
    if (latin1.decode(bytes.subarray(0, 1024)).indexOf('%PDF') === -1) throw new Error(tx('pdf.notPdf'));
    const { s, objects } = await readObjects(bytes);
    if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(s)) throw new Error(tx('pdf.encrypted'));
    const fonts = await loadFonts(objects);
    const out = [];
    let outputChars = 0;
    out.push = (...parts) => {
      for (const part of parts) { outputChars += part.length; if (outputChars > maxChars) throw tooLong(); Array.prototype.push.call(out, part); }
      return out.length;
    };
    const separators = new Set(); // ページの区切り (言語ごとに文言が違うので、本文と見分けるために覚えておく)
    let pageNo = 0;
    for (const page of pageOrder(s, objects)) {
      await breathe();
      pageNo++;
      const contents = page.dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/);
      if (!contents) continue;
      if (pageNo > 1) { const sep = tx('model.pdfPage', { n: pageNo }); separators.add(sep); out.push(sep); }
      const pageFonts = await fonts.forPage(page);
      for (const ref of refs(contents[1])) {
        const obj = objects.get(ref);
        if (obj) {
          await extractContent(await decodeBytes(await streamData(obj)), pageFonts, out);
          obj.data = null;
        }
      }
      check();
    }
    // 行末の空白を外す。replace(/[ \t]+\n/g) だと、改行の付かない長い空白の並びで後戻りが増えて固まる (空白 4 万個で 約 1.1 秒。実測)
    const lines = out.join('').split('\n');
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k];
      let end = line.length;
      while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
      if (end < line.length) lines[k] = line.slice(0, end);
    }
    const textOut = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!out.some((piece) => !separators.has(piece) && piece.trim())) throw new Error(tx('pdf.noText'));
    return textOut;
  }

  return { extract };
  }
  return { extract: (buffer, options = {}) => createExtraction(options).extract(buffer) };
})();
