// 純粋ロジック（DOM・TTS・storageに依存しない）
export const MAX_TIMERS = 6;
export const MAX_HISTORY = 20;
export const MAX_FAVORITES = 30;
export const MAX_MINUTES = 1440;
export const SCHEMA_VERSION = 1;
export const DEFAULT_TEXT = 'タイマーです';

export function remainingMs(timer, now) {
  return Math.max(0, timer.endAt - now);
}

export function isRinging(timer, now) {
  return timer.endAt <= now;
}

// 秒は切り上げ（0秒が早く出ないように）
export function formatRemaining(ms) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatClock(epochMs) {
  const d = new Date(epochMs);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 経過（期限超過）を「3分前」のように表現
export function formatOverdue(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${Math.max(sec, 0)}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  return `${h}時間${min % 60}分前`;
}

// 時間入力の検証。unit: 'min' | 'sec'。成功時 {ok:true, ms}
export function validateDuration(value, unit = 'min') {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n)) {
    return { ok: false, error: '時間を数字で入力してください' };
  }
  if (!Number.isInteger(n)) return { ok: false, error: '整数で入力してください' };
  if (unit === 'sec') {
    if (n < 1 || n > 3600) return { ok: false, error: '秒は1〜3600で入力してください' };
    return { ok: true, ms: n * 1000 };
  }
  if (unit === 'hour') {
    if (n < 1 || n > MAX_MINUTES / 60) return { ok: false, error: `時間は1〜${MAX_MINUTES / 60}で入力してください` };
    return { ok: true, ms: n * 60 * 60 * 1000 };
  }
  if (n < 1 || n > MAX_MINUTES) return { ok: false, error: `分は1〜${MAX_MINUTES}で入力してください` };
  return { ok: true, ms: n * 60 * 1000 };
}

export function normalizeText(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : DEFAULT_TEXT;
}

export const WARN_PRESETS_MS = [60_000, 180_000, 300_000, 600_000];
export const DEFAULT_BREAK_END_TEXT = '休憩おわり。再開しましょう';
export const BREAK_END_LABEL = '休憩が終わります';
const LATE_WARN_MS = 30_000; // これ以上遅れた予告は、読み上げず記録だけする

// 予告の候補を整える（重複排除・降順・時間より短いものだけ）
export function normalizeWarns(warns, limitMs) {
  return [...new Set((warns || []).filter((w) => Number.isFinite(w) && w > 0 && w < limitMs))].sort((a, b) => b - a);
}

// warns: 予告（ms前）の配列 / repeat: {breakMs, breakText, total(null=止めるまで)} または null
export function createTimer({ text, durationMs, now, id, warns = [], repeat = null }) {
  const timer = {
    id, text: normalizeText(text), createdAt: now, durationMs, endAt: now + durationMs,
    warns: normalizeWarns(warns, Math.max(durationMs, repeat?.breakMs || 0)), warned: [],
  };
  if (repeat) {
    timer.repeat = {
      workMs: durationMs, breakMs: repeat.breakMs || 0, breakText: String(repeat.breakText ?? '').trim(),
      total: repeat.total ?? null, done: 0, phase: 'work',
    };
  }
  return timer;
}

// 鳴動時に読み上げる言葉（休憩の終わりは休憩用のセリフ）
export function phaseText(timer) {
  return timer.repeat?.phase === 'break' ? (timer.repeat.breakText || DEFAULT_BREAK_END_TEXT) : timer.text;
}

// 予告で「あと〇分で、◯◯」の◯◯に入る言葉
export function warnLabel(timer) {
  return timer.repeat?.phase === 'break' ? BREAK_END_LABEL : timer.text;
}

export function phaseLabel(timer) {
  const r = timer.repeat;
  if (!r) return '';
  if (r.phase === 'break') return '☕ 休憩中';
  return r.total ? `🔁 ${r.done + 1}/${r.total}回目` : `🔁 ${r.done + 1}回目`;
}

// 今読み上げるべき予告を返す。{fire: 読み上げるms or null, mark: 記録するms[]} / なければ null
export function dueWarning(timer, now) {
  if (isRinging(timer, now)) return null;
  const remaining = timer.endAt - now;
  const warned = timer.warned || [];
  const due = (timer.warns || []).filter((w) => w < timer.durationMs && !warned.includes(w) && remaining <= w);
  if (due.length === 0) return null;
  const onTime = due.filter((w) => w - remaining <= LATE_WARN_MS);
  return { fire: onTime.length ? Math.min(...onTime) : null, mark: due };
}

export function markWarned(timer, mark) {
  return { ...timer, warned: [...(timer.warned || []), ...mark] };
}

function startPhase(timer, now, ms, repeat) {
  return { ...timer, createdAt: now, durationMs: ms, endAt: now + ms, warned: [], repeat };
}

// 鳴動を止めたあと、次の段階へ。繰り返しがない/最後の回なら null（タイマー終了）
export function advanceTimer(timer, now) {
  const r = timer.repeat;
  if (!r) return null;
  if (r.phase === 'work') {
    const done = r.done + 1;
    if (r.total !== null && done >= r.total) return null;
    if (r.breakMs > 0) return startPhase(timer, now, r.breakMs, { ...r, done, phase: 'break' });
    return startPhase(timer, now, r.workMs, { ...r, done, phase: 'work' });
  }
  return startPhase(timer, now, r.workMs, { ...r, phase: 'work' });
}

export function stopTimer(timers, id, now) {
  return timers.flatMap((t) => {
    if (t.id !== id || !isRinging(t, now)) return [t];
    const n = advanceTimer(t, now);
    return n ? [n] : [];
  });
}

export function stopAllRinging(timers, now) {
  return timers.flatMap((t) => {
    if (!isRinging(t, now)) return [t];
    const n = advanceTimer(t, now);
    return n ? [n] : [];
  });
}

// 設定の説明（お気に入り表示用）
export function describeOpts(opts) {
  if (!opts) return '';
  const parts = [];
  if (opts.warns?.length) {
    parts.push(`予告 ${[...opts.warns].sort((a, b) => b - a).map((w) => `${formatDuration(w)}前`).join('・')}`);
  }
  if (opts.repeat) {
    const r = opts.repeat;
    const brk = r.breakMs > 0 ? `休憩${formatDuration(r.breakMs)}` : '休憩なし';
    parts.push(`繰り返し(${brk}・${r.total ? `${r.total}回` : '止めるまで'})`);
  }
  return parts.join(' / ');
}

export function canAddTimer(timers) {
  return timers.length < MAX_TIMERS;
}

// 履歴: 重複排除（新しい順・先頭が最新）
export function addHistory(history, text, max = MAX_HISTORY) {
  const t = String(text ?? '').trim();
  if (!t || t === DEFAULT_TEXT) return history;
  return [t, ...history.filter((h) => h !== t)].slice(0, max);
}

// 鳴動中のタイマー（古い順）
export function ringingTimers(timers, now) {
  return timers.filter((t) => isRinging(t, now)).sort((a, b) => a.endAt - b.endAt);
}

// 実行中（未発火）のタイマー（作成順で固定表示）
export function runningTimers(timers, now) {
  return timers.filter((t) => !isRinging(t, now)).sort((a, b) => a.createdAt - b.createdAt);
}

// 次に読み上げるタイマーを選ぶ（lastId の次。末尾なら先頭へ循環）
export function pickNext(ringing, lastId) {
  if (ringing.length === 0) return null;
  const i = ringing.findIndex((t) => t.id === lastId);
  return ringing[(i + 1) % ringing.length];
}

// 進捗（0〜1: 経過割合）
export function progress(timer, now) {
  if (!timer.durationMs) return 1;
  return Math.min(1, Math.max(0, (now - timer.createdAt) / timer.durationMs));
}

// 次のtickまでの待ち時間（秒境界に合わせる）
export function msToNextSecond(now) {
  return 1000 - (now % 1000) + 5;
}

// 保存データの読み出し（壊れていたら null を返す）
export function parseStore(raw) {
  if (raw == null) return { timers: [], history: [], favorites: [] };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || data.version !== SCHEMA_VERSION || !Array.isArray(data.timers) || !Array.isArray(data.history)) {
    return null;
  }
  const timers = data.timers.filter(
    (t) => t && typeof t.id === 'string' && typeof t.text === 'string' && Number.isFinite(t.endAt) && Number.isFinite(t.createdAt)
  );
  const history = data.history.filter((h) => typeof h === 'string');
  const favorites = (Array.isArray(data.favorites) ? data.favorites : []).filter(
    (f) => f && typeof f.id === 'string' && typeof f.text === 'string' && (f.durationMs === null || Number.isFinite(f.durationMs))
  );
  return { timers, history, favorites };
}

export function serializeStore(timers, history, favorites = []) {
  return JSON.stringify({ version: SCHEMA_VERSION, timers, history, favorites });
}

// 時間の表示用（例: 30分 / 1時間30分 / 45秒）
export function formatDuration(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return sec % 60 ? `${min}分${sec % 60}秒` : `${min}分`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h}時間${min % 60}分` : `${h}時間`;
}

// お気に入り。durationMs が null なら「セリフだけ」、数値なら「セリフ＋時間」
export function addFavorite(favorites, { text, durationMs = null, opts = null, id }) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, error: 'セリフを入力してください', favorites };
  const o = durationMs === null ? null : opts;
  const key = JSON.stringify(o ?? null);
  if (favorites.some((f) => f.text === t && f.durationMs === durationMs && JSON.stringify(f.opts ?? null) === key)) {
    return { ok: false, error: 'すでに登録されています', favorites };
  }
  if (favorites.length >= MAX_FAVORITES) {
    return { ok: false, error: `お気に入りは${MAX_FAVORITES}件までです。不要なものを削除してください`, favorites };
  }
  return { ok: true, favorites: [...favorites, { id, text: t, durationMs, ...(o ? { opts: o } : {}) }] };
}

export function removeFavorite(favorites, id) {
  return favorites.filter((f) => f.id !== id);
}

// dir: -1(上へ) / 1(下へ)
export function moveFavorite(favorites, id, dir) {
  const i = favorites.findIndex((f) => f.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= favorites.length) return favorites;
  const next = favorites.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

// 発話の推定時間（onend不発時のウォッチドッグ用）
export function estimateSpeechMs(text, rate = 1) {
  const chars = String(text).length;
  return Math.round((chars * 250) / rate + 2000);
}
