import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  remainingMs, isRinging, formatRemaining, formatOverdue, validateDuration, normalizeText,
  createTimer, canAddTimer, addHistory, ringingTimers, runningTimers, pickNext, progress,
  parseStore, serializeStore, estimateSpeechMs, msToNextSecond, MAX_TIMERS, DEFAULT_TEXT,
  formatDuration, addFavorite, removeFavorite, moveFavorite, MAX_FAVORITES,
} from './core.js';

const T = (id, endAt, createdAt = 0, durationMs = 1000) => ({ id, text: id, endAt, createdAt, durationMs });

test('remainingMs / isRinging', () => {
  const t = T('a', 5000);
  assert.equal(remainingMs(t, 1000), 4000);
  assert.equal(remainingMs(t, 9000), 0);
  assert.equal(isRinging(t, 4999), false);
  assert.equal(isRinging(t, 5000), true);
});

test('formatRemaining は秒を切り上げる', () => {
  assert.equal(formatRemaining(0), '00:00');
  assert.equal(formatRemaining(1), '00:01');
  assert.equal(formatRemaining(59_001), '01:00');
  assert.equal(formatRemaining(3_600_000), '1:00:00');
});

test('formatOverdue', () => {
  assert.equal(formatOverdue(30_000), '30秒前');
  assert.equal(formatOverdue(180_000), '3分前');
  assert.equal(formatOverdue(3_900_000), '1時間5分前');
});

test('validateDuration', () => {
  assert.deepEqual(validateDuration('5'), { ok: true, ms: 300_000 });
  assert.deepEqual(validateDuration(30, 'sec'), { ok: true, ms: 30_000 });
  for (const bad of ['', null, undefined, 'abc', 0, -1, 1.5, 1441]) {
    assert.equal(validateDuration(bad).ok, false, String(bad));
  }
  assert.equal(validateDuration(3601, 'sec').ok, false);
  assert.deepEqual(validateDuration(2, 'hour'), { ok: true, ms: 7_200_000 });
  assert.equal(validateDuration(24, 'hour').ok, true);
  assert.equal(validateDuration(25, 'hour').ok, false);
  assert.equal(validateDuration(0, 'hour').ok, false);
});

test('normalizeText は空なら既定文', () => {
  assert.equal(normalizeText('  薬  を  飲む '), '薬 を 飲む');
  assert.equal(normalizeText('   '), DEFAULT_TEXT);
  assert.equal(normalizeText(undefined), DEFAULT_TEXT);
});

test('createTimer / canAddTimer', () => {
  const t = createTimer({ text: '洗濯', durationMs: 60_000, now: 1000, id: 'x' });
  assert.deepEqual(t, { id: 'x', text: '洗濯', createdAt: 1000, durationMs: 60_000, endAt: 61_000 });
  assert.equal(canAddTimer(Array(MAX_TIMERS - 1).fill(t)), true);
  assert.equal(canAddTimer(Array(MAX_TIMERS).fill(t)), false);
});

test('addHistory は重複排除・新しい順・上限', () => {
  assert.deepEqual(addHistory(['a', 'b'], 'b'), ['b', 'a']);
  assert.deepEqual(addHistory(['a'], 'c'), ['c', 'a']);
  assert.deepEqual(addHistory(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b']);
  assert.deepEqual(addHistory(['a'], '  '), ['a']);
  assert.deepEqual(addHistory(['a'], DEFAULT_TEXT), ['a']);
});

test('ringingTimers は古い順、runningTimers は作成順', () => {
  const ts = [T('late', 300, 1), T('early', 100, 2), T('run1', 900, 5), T('run2', 800, 3)];
  assert.deepEqual(ringingTimers(ts, 400).map((t) => t.id), ['early', 'late']);
  assert.deepEqual(runningTimers(ts, 400).map((t) => t.id), ['run2', 'run1']);
});

test('pickNext は循環する', () => {
  const r = [T('a', 1), T('b', 2), T('c', 3)];
  assert.equal(pickNext(r, null).id, 'a');
  assert.equal(pickNext(r, 'a').id, 'b');
  assert.equal(pickNext(r, 'c').id, 'a');
  assert.equal(pickNext(r, 'gone').id, 'a');
  assert.equal(pickNext([], 'a'), null);
});

test('progress は0〜1にクランプ', () => {
  const t = T('a', 1000, 0, 1000);
  assert.equal(progress(t, -5), 0);
  assert.equal(progress(t, 500), 0.5);
  assert.equal(progress(t, 5000), 1);
});

test('parseStore: 正常・空・破損', () => {
  assert.deepEqual(parseStore(null), { timers: [], history: [], favorites: [] });
  assert.equal(parseStore('{broken'), null);
  assert.equal(parseStore(JSON.stringify({ version: 99, timers: [], history: [] })), null);
  const t = T('a', 5000);
  const raw = serializeStore([t, { id: 1 }], ['x', 3]);
  assert.deepEqual(parseStore(raw), { timers: [t], history: ['x'], favorites: [] });
  const fav = { id: 'f', text: '薬', durationMs: null };
  assert.deepEqual(parseStore(serializeStore([], [], [fav, { id: 1 }])).favorites, [fav]);
  // 旧データ（favorites なし）も読める
  assert.deepEqual(parseStore(JSON.stringify({ version: 1, timers: [], history: [] })).favorites, []);
});

test('estimateSpeechMs / msToNextSecond', () => {
  assert.ok(estimateSpeechMs('薬を飲む') > 2000);
  assert.ok(estimateSpeechMs('あ', 0.5) > estimateSpeechMs('あ', 1));
  const w = msToNextSecond(12_345);
  assert.ok(w > 0 && w <= 1005);
});

test('formatDuration', () => {
  assert.equal(formatDuration(45_000), '45秒');
  assert.equal(formatDuration(30 * 60_000), '30分');
  assert.equal(formatDuration(90_000), '1分30秒');
  assert.equal(formatDuration(3_600_000), '1時間');
  assert.equal(formatDuration(5_400_000), '1時間30分');
});

test('addFavorite: セリフのみ / セリフ+時間 を別物として登録、重複・上限・空を拒否', () => {
  let r = addFavorite([], { text: ' 薬 を 飲む ', id: '1' });
  assert.deepEqual(r.favorites, [{ id: '1', text: '薬 を 飲む', durationMs: null }]);
  r = addFavorite(r.favorites, { text: '薬 を 飲む', durationMs: 60_000, id: '2' });
  assert.equal(r.ok, true);
  assert.equal(r.favorites.length, 2);
  assert.equal(addFavorite(r.favorites, { text: '薬 を 飲む', durationMs: 60_000, id: '3' }).ok, false);
  assert.equal(addFavorite(r.favorites, { text: '  ', id: '4' }).ok, false);
  const full = Array.from({ length: MAX_FAVORITES }, (_, i) => ({ id: String(i), text: `t${i}`, durationMs: null }));
  assert.equal(addFavorite(full, { text: 'new', id: 'n' }).ok, false);
});

test('removeFavorite / moveFavorite', () => {
  const f = ['a', 'b', 'c'].map((id) => ({ id, text: id, durationMs: null }));
  assert.deepEqual(removeFavorite(f, 'b').map((x) => x.id), ['a', 'c']);
  assert.deepEqual(moveFavorite(f, 'b', -1).map((x) => x.id), ['b', 'a', 'c']);
  assert.deepEqual(moveFavorite(f, 'c', 1).map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(moveFavorite(f, 'zzz', 1), f);
});
