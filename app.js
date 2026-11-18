import {
  createTimer, canAddTimer, addHistory, ringingTimers, runningTimers, remainingMs, progress,
  formatRemaining, formatClock, formatOverdue, validateDuration, normalizeText,
  parseStore, serializeStore, msToNextSecond, MAX_TIMERS,
} from './core.js';
import { createSpeaker } from './speaker.js';
import { createKeepAwake } from './keepawake.js';

const STORE_KEY = 'serifu-timer:v1';
const BACKUP_KEY = 'serifu-timer:corrupt';
const RATE_KEY = 'serifu-timer:rate';
const A2HS_KEY = 'serifu-timer:a2hs-dismissed';
const DEFAULT_CHIPS = ['薬を飲む', '水を飲む', '休憩する'];
const $ = (id) => document.getElementById(id);

// ---------- 状態 ----------
let timers = [];
let history = [];
let speakingId = null;
let noticeMsg = '';

const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };

function loadState() {
  const raw = safeGet(STORE_KEY);
  const parsed = parseStore(raw);
  if (parsed === null) {
    safeSet(BACKUP_KEY, raw ?? '');
    setNotice('保存データが壊れていたため、初期化しました。');
    timers = []; history = [];
    return;
  }
  timers = parsed.timers;
  history = parsed.history;
}

function saveState() {
  if (!safeSet(STORE_KEY, serializeStore(timers, history))) {
    setNotice('保存できませんでした（プライベートブラウズ等）。再読込するとタイマーが消えます。');
  }
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const getRate = () => { const r = parseFloat(safeGet(RATE_KEY)); return Number.isFinite(r) && r >= 0.5 && r <= 2 ? r : 1; };

// ---------- Speaker / KeepAwake ----------
const speaker = createSpeaker({
  getRinging: () => (document.visibilityState === 'visible' ? ringingTimers(timers, Date.now()) : []),
  onSpeaking: (id) => { speakingId = id; markSpeaking(); },
  onBlocked: (b) => { $('speechBlocked').hidden = !b && !speaker.needsTap; },
  getRate,
});

const keepAwake = createKeepAwake({ onChange: () => renderBanner() });

// ---------- 通知 ----------
function setNotice(msg) { noticeMsg = msg; renderBanner(); }

function renderBanner() {
  const el = $('keepAwake');
  const hasTimers = timers.length > 0;
  const st = keepAwake.status;
  el.className = 'banner';
  if (hasTimers && (st === 'failed' || st === 'unsupported')) {
    el.classList.add('warn');
    el.textContent = '⚠ 画面を消さない設定が効いていません。画面が消えると鳴りません。自動ロックを「なし」にするか、低電力モードをオフにしてください。';
  } else {
    el.classList.add('ok');
    el.textContent = hasTimers
      ? '📱 画面をつけたまま、このアプリを開いておいてください（別アプリに切り替えると鳴りません）'
      : '📱 タイマー中は画面をつけたまま、このアプリを開いておいてください';
  }
  const n = $('notice');
  n.hidden = !noticeMsg;
  n.textContent = noticeMsg;
}

// ---------- 描画（キー付き更新: 毎秒の再構築でタップが失われないように） ----------
const runEls = new Map();
const ringEls = new Map();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function buildRunning(t) {
  const li = el('li', 'card');
  const row1 = el('div', 'row');
  const say = el('span', 'say', t.text);
  const del = el('button', 'del', '削除');
  del.type = 'button';
  del.addEventListener('click', () => removeTimer(t.id, true));
  row1.append(say, del);
  const row2 = el('div', 'row');
  const time = el('span', 'time');
  const at = el('span', 'at', `${formatClock(t.endAt)} に鳴ります`);
  row2.append(time, at);
  const bar = el('div', 'bar');
  const fill = document.createElement('i');
  bar.append(fill);
  li.append(row1, row2, bar);
  return { li, time, fill };
}

function buildRinging(t) {
  const li = el('li', 'card ringing');
  const tag = el('div', 'tag', '🔔 時間です');
  const say = el('div', 'say', t.text);
  const at = el('div', 'at');
  const stop = el('button', 'stop-btn', '止める');
  stop.type = 'button';
  stop.addEventListener('click', () => removeTimer(t.id, false));
  li.append(tag, say, at, stop);
  return { li, at, tag };
}

function syncKeyed(map, ul, items, build) {
  const ids = new Set(items.map((t) => t.id));
  for (const [id, v] of map) if (!ids.has(id)) { v.li.remove(); map.delete(id); }
  items.forEach((t, i) => {
    let v = map.get(t.id);
    if (!v) { v = build(t); map.set(t.id, v); }
    if (ul.children[i] !== v.li) ul.insertBefore(v.li, ul.children[i] || null);
  });
}

function markSpeaking() {
  for (const [id, v] of ringEls) {
    const on = id === speakingId;
    v.li.classList.toggle('speaking', on);
    v.tag.textContent = on ? '🔊 読み上げ中' : '🔔 時間です';
  }
}

function render() {
  const now = Date.now();
  const running = runningTimers(timers, now);
  const ringing = ringingTimers(timers, now);

  syncKeyed(runEls, $('runningList'), running, buildRunning);
  syncKeyed(ringEls, $('ringingList'), ringing, buildRinging);

  for (const t of running) {
    const v = runEls.get(t.id);
    const rem = remainingMs(t, now);
    v.time.textContent = formatRemaining(rem);
    v.time.classList.toggle('soon', rem < 60_000);
    v.fill.style.width = `${Math.round(progress(t, now) * 100)}%`;
  }
  for (const t of ringing) {
    const v = ringEls.get(t.id);
    const over = now - t.endAt;
    v.at.textContent = over > 5000 ? `${formatOverdue(over)}に鳴る予定でした` : '';
  }

  $('ringingZone').hidden = ringing.length === 0;
  $('stopAll').hidden = ringing.length < 2;
  $('empty').hidden = timers.length > 0;
  $('speechBlocked').hidden = !(ringing.length > 0 && (speaker.needsTap || !$('speechBlocked').hidden));
  $('limitMsg').hidden = canAddTimer(timers);
  $('limitMsg').textContent = `同時に設定できるのは${MAX_TIMERS}件までです。どれかを止めるか削除してください。`;
  document.title = ringing.length ? `🔔 ${ringing[0].text}` : 'セリフタイマー';

  keepAwake.want(timers.length > 0);
  speaker.sync();
  markSpeaking();
  renderBanner();
}

function renderChips() {
  const box = $('chips');
  box.textContent = '';
  const items = (history.length ? history : DEFAULT_CHIPS).slice(0, 5);
  for (const text of items) {
    const b = el('button', 'chip', text);
    b.type = 'button';
    b.addEventListener('click', () => { $('text').value = text; });
    box.append(b);
  }
}

// ---------- 操作 ----------
let undoTimer = null;
let undoItem = null;

function removeTimer(id, withUndo) {
  const t = timers.find((x) => x.id === id);
  if (!t) return;
  timers = timers.filter((x) => x.id !== id);
  saveState();
  if (withUndo) showUndo(t); else hideUndo();
  render();
}

function showUndo(t) {
  undoItem = t;
  $('undoText').textContent = `「${t.text}」を削除しました`;
  $('undoBar').hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndo, 5000);
}
function hideUndo() { $('undoBar').hidden = true; undoItem = null; clearTimeout(undoTimer); }

$('undoBtn').addEventListener('click', () => {
  if (undoItem && canAddTimer(timers) && undoItem.endAt > Date.now()) { timers.push(undoItem); saveState(); }
  hideUndo();
  render();
});

$('stopAll').addEventListener('click', () => {
  const now = Date.now();
  timers = timers.filter((t) => !(t.endAt <= now));
  saveState();
  speaker.stop();
  render();
});

$('resumeSpeech').addEventListener('click', () => { speaker.resume(); render(); });

function selectedDuration() {
  const v = document.querySelector('input[name=mins]:checked')?.value;
  if (v === 'other') return validateDuration($('otherValue').value, $('otherUnit').value);
  return validateDuration(v, 'min');
}

document.querySelectorAll('input[name=mins]').forEach((r) => r.addEventListener('change', () => {
  $('otherBox').hidden = document.querySelector('input[name=mins]:checked').value !== 'other';
  if (!$('otherBox').hidden) $('otherValue').focus();
}));

$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const err = $('formError');
  err.hidden = true;
  if (!canAddTimer(timers)) { err.textContent = `同時に設定できるのは${MAX_TIMERS}件までです。`; err.hidden = false; return; }
  const d = selectedDuration();
  if (!d.ok) { err.textContent = d.error; err.hidden = false; return; }

  // ユーザー操作の内側で音声と画面保持を準備する（iOSの自動再生制限対策）
  speaker.unlock();
  keepAwake.want(true);

  const text = normalizeText($('text').value);
  timers.push(createTimer({ text, durationMs: d.ms, now: Date.now(), id: newId() }));
  history = addHistory(history, $('text').value);
  saveState();
  $('text').value = '';
  renderChips();
  render();
});

$('testBtn').addEventListener('click', () => {
  const ok = speaker.test(normalizeText($('text').value));
  setNotice(ok ? '' : 'この端末（ブラウザ）は音声読み上げに対応していません。');
});

$('a2hsClose').addEventListener('click', () => { safeSet(A2HS_KEY, '1'); $('a2hs').hidden = true; });

// ---------- tick ----------
let tickTimer = null;
function tick() {
  clearTimeout(tickTimer);
  render();
  tickTimer = setTimeout(tick, msToNextSecond(Date.now()));
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') tick();
  else speaker.stop(); // 非表示のタブは読み上げない（二重読み上げ防止）
});
window.addEventListener('pageshow', tick);

// 複数タブ: 他タブの変更を取り込む
window.addEventListener('storage', (e) => {
  if (e.key !== STORE_KEY) return;
  const p = parseStore(e.newValue);
  if (p) { timers = p.timers; history = p.history; renderChips(); render(); }
});

// ---------- 起動 ----------
loadState();
const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
$('a2hs').hidden = standalone || safeGet(A2HS_KEY) === '1';
if (!speaker.supported) setNotice('このブラウザは音声読み上げに対応していません。Safariで開いてください。');

// 再読込時にすでに期限切れのものがあれば、無言で鳴らさずタップを待つ
if (ringingTimers(timers, Date.now()).length > 0) speaker.setNeedsTap(true);

renderChips();
tick();
