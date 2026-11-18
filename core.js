// 純粋ロジック（DOM・TTS・storageに依存しない）
export const MAX_TIMERS = 6;
export const MAX_HISTORY = 20;
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
  if (n < 1 || n > MAX_MINUTES) return { ok: false, error: `分は1〜${MAX_MINUTES}で入力してください` };
  return { ok: true, ms: n * 60 * 1000 };
}

export function normalizeText(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : DEFAULT_TEXT;
}

export function createTimer({ text, durationMs, now, id }) {
  return { id, text: normalizeText(text), createdAt: now, durationMs, endAt: now + durationMs };
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
  if (raw == null) return { timers: [], history: [] };
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
  return { timers, history };
}

export function serializeStore(timers, history) {
  return JSON.stringify({ version: SCHEMA_VERSION, timers, history });
}

// 発話の推定時間（onend不発時のウォッチドッグ用）
export function estimateSpeechMs(text, rate = 1) {
  const chars = String(text).length;
  return Math.round((chars * 250) / rate + 2000);
}
