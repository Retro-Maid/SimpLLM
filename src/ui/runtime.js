'use strict';

// DOMに依存しない通信・待機処理。チャット、画像、設定で共用する。
const Runtime = (() => {
  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException(tx('common.aborted'), 'AbortError')); };
      let timer;
      if (signal?.aborted) { abort(); return; }
      timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  // Waiting work does not allocate request bodies until a slot is available.
  function limit(concurrency) {
    let active = 0;
    const queue = [];
    const pump = () => {
      while (active < concurrency && queue.length) {
        const task = queue.shift();
        task.signal?.removeEventListener('abort', task.abort);
        if (task.signal?.aborted) { task.resolve(null); continue; }
        active++;
        let result;
        try { result = task.run(); } catch (e) { result = Promise.reject(e); }
        Promise.resolve(result).then(task.resolve, task.reject).finally(() => { active--; pump(); });
      }
    };
    return (run, signal) => new Promise((resolve, reject) => {
      const task = { run, signal, resolve, reject, abort: () => {
        const i = queue.indexOf(task);
        if (i !== -1) { queue.splice(i, 1); resolve(null); }
      } };
      if (signal?.aborted) { resolve(null); return; }
      queue.push(task);
      signal?.addEventListener('abort', task.abort, { once: true });
      pump();
    });
  }

  const yieldTask = () => globalThis.scheduler?.yield ? scheduler.yield() : wait(0);
  const workerUrls = new Set();
  let workerPolicy;
  function smallJson(value) {
    const stack = [value];
    let chars = 0, nodes = 0;
    while (stack.length) {
      const item = stack.pop();
      if (++nodes > 1024) return false;
      if (typeof item === 'string') chars += item.length;
      else if (item && typeof item === 'object') {
        const keys = Object.keys(item);
        if (keys.length + stack.length > 1024) return false;
        for (const key of keys) { chars += key.length; stack.push(item[key]); }
      } else chars += 8;
      if (chars > 32768) return false;
    }
    return true;
  }
  // 大きな JSON の解析・生成は Worker で行う (画面のスレッドを止めない)。Worker は 1 つを使い回し、しばらく使わなければ手放す。
  // Worker が使えない・応答しないときは、その場で処理する (待っている依頼を止めたままにしない)
  const JSON_WORKER = 'onmessage=({data})=>{try{postMessage({id:data.id,value:data.stringify?JSON.stringify(data.value):JSON.parse(data.value)})}catch(e){postMessage({id:data.id,error:e.message})}}';
  const JSON_IDLE_MS = 30000;
  const JSON_STALL_MS = 120000;
  const jsonPending = new Map(); // 依頼の番号 → { resolve, reject, direct, timer }
  let jsonWorker = null, jsonUrl = '', jsonSeq = 0, jsonIdle = 0, jsonBroken = false;
  // Worker を手放す。待っている依頼は、その場で処理して答える
  function dropJsonWorker() {
    clearTimeout(jsonIdle);
    if (jsonWorker) jsonWorker.terminate();
    jsonWorker = null;
    if (jsonUrl) { workerUrls.delete(jsonUrl); URL.revokeObjectURL(jsonUrl); jsonUrl = ''; }
    const waiting = [...jsonPending.values()];
    jsonPending.clear();
    for (const p of waiting) { clearTimeout(p.timer); p.direct(); }
  }
  // Only this fixed worker's generated URL can become a TrustedScriptURL.
  function startJsonWorker() {
    jsonUrl = URL.createObjectURL(new Blob([JSON_WORKER], { type: 'text/javascript' }));
    workerUrls.add(jsonUrl);
    if (globalThis.trustedTypes && !workerPolicy) workerPolicy = trustedTypes.createPolicy('simpllm-worker', {
      createScriptURL: (s) => { if (!workerUrls.has(s)) throw new TypeError(); return s; },
    });
    jsonWorker = new Worker(workerPolicy ? workerPolicy.createScriptURL(jsonUrl) : jsonUrl);
    jsonWorker.onmessage = ({ data }) => {
      const p = jsonPending.get(data.id);
      if (!p) return;
      jsonPending.delete(data.id);
      clearTimeout(p.timer);
      if (!jsonPending.size) jsonIdle = setTimeout(dropJsonWorker, JSON_IDLE_MS);
      if (data.error !== undefined) p.reject(new SyntaxError(data.error)); else p.resolve(data.value);
    };
    jsonWorker.onerror = () => { jsonBroken = true; dropJsonWorker(); };
  }
  function json(value, stringify = false) {
    const convert = () => (stringify ? JSON.stringify(value) : JSON.parse(value));
    if (jsonBroken || typeof Worker === 'undefined' || (stringify ? smallJson(value) : value.length <= 32768)) {
      try { return Promise.resolve(convert()); } catch (e) { return Promise.reject(e); }
    }
    return new Promise((resolve, reject) => {
      const direct = () => { try { resolve(convert()); } catch (e) { reject(e); } };
      if (!jsonWorker) {
        try { startJsonWorker(); } catch { jsonBroken = true; dropJsonWorker(); direct(); return; }
      }
      clearTimeout(jsonIdle);
      const id = ++jsonSeq;
      const timer = setTimeout(() => { jsonBroken = true; dropJsonWorker(); }, JSON_STALL_MS);
      jsonPending.set(id, { resolve, reject, direct, timer });
      try { jsonWorker.postMessage({ id, value, stringify }); } catch {
        // 写せない値 (この依頼だけの問題) は、その場で処理する
        jsonPending.delete(id);
        clearTimeout(timer);
        if (!jsonPending.size) jsonIdle = setTimeout(dropJsonWorker, JSON_IDLE_MS);
        direct();
      }
    });
  }

  // 同時更新は1要求へまとめ、直後のfocus/設定操作による再走査も省く。失敗はキャッシュしない。
  function refresh(load, ttl = 1500, now = Date.now) {
    let pending = null, value, expires = 0, epoch = 0;
    const run = (force = false) => {
      if (pending) return pending;
      if (!force && now() < expires) return Promise.resolve(value);
      const generation = epoch;
      const task = Promise.resolve().then(load).then((result) => {
        if (generation === epoch) { value = result; expires = now() + ttl; }
        return result;
      }).finally(() => { if (pending === task) pending = null; });
      pending = task;
      return pending;
    };
    run.clear = () => { epoch++; pending = null; value = undefined; expires = 0; };
    return run;
  }

  // llama-serverのSSEを増分で読む。分割されたUTF-8、CRLF、末尾の改行なしにも対応。
  async function* events(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', scan = 0, completed = false;
    const parse = (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let event;
      try { event = JSON.parse(data); } catch { return; }
      if (event.error) throw new Error(event.error.message || tx('error.server'));
      return event;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let start = 0, end;
        while ((end = buffer.indexOf('\n', scan)) !== -1) {
          const event = parse(buffer.slice(start, end));
          start = scan = end + 1;
          if (event !== undefined) yield event;
        }
        scan = buffer.length - start;
        buffer = buffer.slice(start);
        if (done) { completed = true; const event = parse(buffer); if (event !== undefined) yield event; break; }
      }
    } finally {
      if (!completed) { try { await reader.cancel(); } catch { } }
      reader.releaseLock();
    }
  }
  return { wait, refresh, events, limit, yieldTask, json };
})();
