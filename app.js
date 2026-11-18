import {
  createTimer, canAddTimer, addHistory, ringingTimers, runningTimers, remainingMs, progress,
  formatRemaining, formatClock, formatOverdue, validateDuration, normalizeText,
  parseStore, serializeStore, msToNextSecond, MAX_TIMERS,
  addFavorite, removeFavorite, moveFavorite, formatDuration,
  stopTimer, stopAllRinging, phaseText, warnLabel, phaseLabel, dueWarning, markWarned, describeOpts, normalizeWarns,
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
let favorites = [];
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
    timers = []; history = []; favorites = [];
    return;
  }
  timers = parsed.timers;
  history = parsed.history;
  favorites = parsed.favorites;
}

function saveState() {
  if (!safeSet(STORE_KEY, serializeStore(timers, history, favorites))) {
    setNotice('保存できませんでした（プライベートブラウズ等）。再読込するとタイマーが消えます。');
  }
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const getRate = () => { const r = parseFloat(safeGet(RATE_KEY)); return Number.isFinite(r) && r >= 0.5 && r <= 2 ? r : 1; };

// ---------- Speaker / KeepAwake ----------
const speaker = createSpeaker({
  getRinging: () => (document.visibilityState === 'visible'
    ? ringingTimers(timers, Date.now()).map((t) => ({ id: t.id, text: phaseText(t) }))
    : []),
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
  const badge = el('span', 'badge');
  const row2 = el('div', 'row');
  const time = el('span', 'time');
  const at = el('span', 'at');
  row2.append(time, at);
  const bar = el('div', 'bar');
  const fill = document.createElement('i');
  bar.append(fill);
  li.append(row1, badge, row2, bar);
  return { li, time, at, fill, badge };
}

function buildRinging(t) {
  const li = el('li', 'card ringing');
  const isBreak = t.repeat?.phase === 'break';
  const idle = isBreak ? '☕ 休憩おわり' : '🔔 時間です';
  const tag = el('div', 'tag', idle);
  const say = el('div', 'say', phaseText(t));
  const badge = el('span', 'badge', isBreak ? '' : phaseLabel(t));
  badge.hidden = isBreak || !t.repeat;
  const at = el('div', 'at');
  const stop = el('button', 'stop-btn', t.repeat ? (isBreak ? '止める（次の作業へ）' : '止める（休憩/次へ）') : '止める');
  stop.type = 'button';
  stop.addEventListener('click', () => stopOne(t.id));
  li.append(tag, say, badge, at, stop);
  if (t.repeat) {
    const quit = el('button', 'more', '🔁 繰り返しをやめる');
    quit.type = 'button';
    quit.addEventListener('click', () => removeTimer(t.id, false));
    li.append(quit);
  }
  return { li, at, tag, idle };
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
    v.tag.textContent = on ? '🔊 読み上げ中' : v.idle;
  }
}

// 予告（あとN分で…）。読み上げは一度だけ。画面が見えている間だけ行う
function checkWarnings(now) {
  if (document.visibilityState !== 'visible') return;
  let changed = false;
  timers = timers.map((t) => {
    const d = dueWarning(t, now);
    if (!d) return t;
    changed = true;
    if (d.fire !== null) speaker.announce(`あと${formatDuration(d.fire)}で、${warnLabel(t)}`);
    return markWarned(t, d.mark);
  });
  if (changed) saveState();
}

function render() {
  const now = Date.now();
  checkWarnings(now);
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
    v.badge.hidden = !t.repeat;
    v.badge.textContent = phaseLabel(t);
    v.at.textContent = `${formatClock(t.endAt)} に${t.repeat?.phase === 'break' ? '休憩おわり' : '鳴ります'}`;
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

// 鳴動中の1件を止める。繰り返しなら休憩/次の作業へ進み、それ以外は終了
function stopOne(id) {
  timers = stopTimer(timers, id, Date.now());
  saveState();
  hideUndo();
  render();
}

$('stopAll').addEventListener('click', () => {
  timers = stopAllRinging(timers, Date.now());
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

// フォームの予告・繰り返しの設定を読む。どちらも未設定なら null
function buildOpts(durationMs) {
  const checked = [...document.querySelectorAll('input[name=warn]:checked:not(:disabled)')].map((i) => Number(i.value));
  let repeat = null;
  if ($('repeatOn').checked) {
    repeat = {
      breakMs: Number($('breakMin').value) * 60_000,
      breakText: $('breakText').value.trim(),
      total: Number($('repeatTimes').value) || null,
    };
  }
  const warns = normalizeWarns(checked, Math.max(durationMs, repeat?.breakMs || 0));
  return warns.length || repeat ? { warns, repeat } : null;
}

// 作業時間より長い予告は選べないようにする
function updateWarnAvailability() {
  const d = selectedDuration();
  let blocked = [];
  document.querySelectorAll('input[name=warn]').forEach((i) => {
    const off = d.ok && Number(i.value) >= d.ms;
    i.disabled = off;
    if (off) { i.checked = false; blocked.push(formatDuration(Number(i.value))); }
  });
  const hint = $('warnHint');
  hint.hidden = blocked.length === 0;
  hint.textContent = blocked.length ? `時間が短いため、${blocked.reverse().join('・')}前の予告は選べません` : '';
}

// タイマーを開始する共通処理（フォーム送信・お気に入りの「▶」から使う）
function startTimer(rawText, durationMs, opts = null) {
  const err = $('formError');
  err.hidden = true;
  if (!canAddTimer(timers)) { err.textContent = `同時に設定できるのは${MAX_TIMERS}件までです。`; err.hidden = false; return false; }
  // ユーザー操作の内側で音声と画面保持を準備する（iOSの自動再生制限対策）
  speaker.unlock();
  keepAwake.want(true);
  timers.push(createTimer({
    text: normalizeText(rawText), durationMs, now: Date.now(), id: newId(),
    warns: opts?.warns ?? [], repeat: opts?.repeat ?? null,
  }));
  history = addHistory(history, rawText);
  saveState();
  renderChips();
  render();
  return true;
}

$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const err = $('formError');
  err.hidden = true;
  const d = selectedDuration();
  if (!d.ok) { err.textContent = d.error; err.hidden = false; return; }
  if (startTimer($('text').value, d.ms, buildOpts(d.ms))) $('text').value = '';
});

$('repeatOn').addEventListener('change', () => { $('repeatBox').hidden = !$('repeatOn').checked; });
$('breakMin').addEventListener('change', () => { $('breakTextRow').hidden = $('breakMin').value === '0'; });
document.querySelectorAll('input[name=mins]').forEach((r) => r.addEventListener('change', updateWarnAvailability));
$('otherValue').addEventListener('input', updateWarnAvailability);
$('otherUnit').addEventListener('change', updateWarnAvailability);

// ---------- お気に入り ----------
function renderFavs() {
  const box = $('favs');
  box.textContent = '';
  for (const f of favorites) {
    const timed = f.durationMs !== null;
    const marks = `${f.opts?.repeat ? '🔁' : ''}${f.opts?.warns?.length ? '🔔' : ''}`;
    const b = el('button', timed ? 'chip fav timed' : 'chip fav', timed ? `▶ ${f.text}（${formatDuration(f.durationMs)}）${marks}` : `⭐ ${f.text}`);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (timed) startTimer(f.text, f.durationMs, f.opts ?? null); // 時間つきはワンタップで開始
      else $('text').value = f.text;               // セリフだけは入力欄へ
    });
    box.append(b);
  }
  const list = $('favList');
  list.textContent = '';
  $('favEmpty').hidden = favorites.length > 0;
  favorites.forEach((f, i) => {
    const li = el('li');
    const name = el('span', 'name', f.durationMs !== null ? `${f.text}（${formatDuration(f.durationMs)}）` : f.text);
    const detail = describeOpts(f.opts);
    if (detail) name.append(el('small', 'hint', ` ${detail}`));
    li.append(name);
    const up = el('button', '', '↑'); up.type = 'button'; up.disabled = i === 0; up.setAttribute('aria-label', '上へ');
    const down = el('button', '', '↓'); down.type = 'button'; down.disabled = i === favorites.length - 1; down.setAttribute('aria-label', '下へ');
    const rm = el('button', 'rm', '削除'); rm.type = 'button';
    up.addEventListener('click', () => { favorites = moveFavorite(favorites, f.id, -1); saveState(); renderFavs(); });
    down.addEventListener('click', () => { favorites = moveFavorite(favorites, f.id, 1); saveState(); renderFavs(); });
    rm.addEventListener('click', () => { favorites = removeFavorite(favorites, f.id); saveState(); renderFavs(); });
    li.append(up, down, rm);
    list.append(li);
  });
}

function closeFavPanel() { $('favPanel').hidden = true; $('favError').hidden = true; }

$('favOpen').addEventListener('click', () => {
  const err = $('favError');
  err.hidden = true;
  const d = selectedDuration();
  const detail = d.ok ? describeOpts(buildOpts(d.ms)) : '';
  $('favTimeLabel').textContent = d.ok ? `（${formatDuration(d.ms)}${detail ? `・${detail}` : ''}）` : '（時間を選んでください）';
  document.querySelector('input[name=favKind][value=text]').checked = true;
  $('favPanel').hidden = false;
});
$('favCancel').addEventListener('click', closeFavPanel);

$('favSave').addEventListener('click', () => {
  const err = $('favError');
  const kind = document.querySelector('input[name=favKind]:checked').value;
  let durationMs = null;
  let opts = null;
  if (kind === 'time') {
    const d = selectedDuration();
    if (!d.ok) { err.textContent = d.error; err.hidden = false; return; }
    durationMs = d.ms;
    opts = buildOpts(d.ms); // 予告・繰り返しの設定もいっしょに登録
  }
  const r = addFavorite(favorites, { text: $('text').value, durationMs, opts, id: newId() });
  if (!r.ok) { err.textContent = r.error; err.hidden = false; return; }
  favorites = r.favorites;
  saveState();
  renderFavs();
  closeFavPanel();
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
  if (p) { timers = p.timers; history = p.history; favorites = p.favorites; renderChips(); renderFavs(); render(); }
});

// ---------- 起動 ----------
loadState();
const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
$('a2hs').hidden = standalone || safeGet(A2HS_KEY) === '1';
if (!speaker.supported) setNotice('このブラウザは音声読み上げに対応していません。Safariで開いてください。');

// 再読込時にすでに期限切れのものがあれば、無言で鳴らさずタップを待つ
if (ringingTimers(timers, Date.now()).length > 0) speaker.setNeedsTap(true);

renderChips();
renderFavs();
updateWarnAvailability();
tick();
