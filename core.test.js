import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  remainingMs, isRinging, formatRemaining, formatOverdue, validateDuration, normalizeText,
  createTimer, canAddTimer, addHistory, ringingTimers, runningTimers, pickNext, progress,
  parseStore, serializeStore, estimateSpeechMs, msToNextSecond, MAX_TIMERS, DEFAULT_TEXT,
  formatDuration, addFavorite, removeFavorite, moveFavorite, MAX_FAVORITES,
  normalizeWarns, phaseText, warnLabel, phaseLabel, dueWarning, markWarned, advanceTimer, stopTimer, stopAllRinging, describeOpts, DEFAULT_BREAK_END_TEXT, BREAK_END_LABEL,
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
  assert.deepEqual(t, { id: 'x', text: '洗濯', createdAt: 1000, durationMs: 60_000, endAt: 61_000, warns: [], warned: [] });
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

const M = 60_000;
const rep = (o = {}) => createTimer({ text: '水', durationMs: 25 * M, now: 0, id: 'r',
  repeat: { breakMs: 5 * M, breakText: '', total: 2, ...o } });

test('normalizeWarns: 時間未満のみ・重複排除・降順', () => {
  assert.deepEqual(normalizeWarns([M, 5 * M, 5 * M, 10 * M, -1, NaN], 10 * M), [5 * M, M]);
  assert.deepEqual(normalizeWarns(undefined, M), []);
});

test('createTimer: 予告と繰り返しの設定', () => {
  const t = createTimer({ text: '薬', durationMs: 3 * M, now: 0, id: 'a', warns: [M, 5 * M], repeat: { breakMs: 10 * M, total: null } });
  assert.deepEqual(t.warns, [5 * M, M]); // 休憩(10分)より短い5分は有効
  assert.deepEqual(t.repeat, { workMs: 3 * M, breakMs: 10 * M, breakText: '', total: null, done: 0, phase: 'work' });
});

test('phaseText / warnLabel / phaseLabel', () => {
  const t = rep();
  assert.equal(phaseText(t), '水');
  assert.equal(phaseLabel(t), '🔁 1/2回目');
  const b = advanceTimer(t, 100);
  assert.equal(phaseText(b), DEFAULT_BREAK_END_TEXT);
  assert.equal(warnLabel(b), BREAK_END_LABEL);
  assert.equal(phaseLabel(b), '☕ 休憩中');
  assert.equal(phaseText({ ...b, repeat: { ...b.repeat, breakText: '再開！' } }), '再開！');
  assert.equal(phaseLabel(rep({ total: null })), '🔁 1回目');
});

test('advanceTimer: 作業→休憩→作業→終了（回数指定）', () => {
  const t = rep({ total: 2 });
  const b = advanceTimer(t, 1000);
  assert.equal(b.repeat.phase, 'break');
  assert.equal(b.repeat.done, 1);
  assert.equal(b.durationMs, 5 * M);
  assert.equal(b.endAt, 1000 + 5 * M);
  assert.deepEqual(b.warned, []);
  const w = advanceTimer(b, 2000);
  assert.equal(w.repeat.phase, 'work');
  assert.equal(w.durationMs, 25 * M);
  assert.equal(w.repeat.done, 1);
  assert.equal(advanceTimer(w, 3000), null); // 2回目の作業が終わったら終了（最後の休憩なし）
});

test('advanceTimer: 休憩なし・無限・繰り返しなし', () => {
  const nb = rep({ breakMs: 0, total: null });
  const n1 = advanceTimer(nb, 0);
  assert.equal(n1.repeat.phase, 'work');
  assert.equal(n1.repeat.done, 1);
  assert.equal(advanceTimer(advanceTimer(n1, 0), 0).repeat.done, 3);
  assert.equal(advanceTimer(createTimer({ text: 'a', durationMs: M, now: 0, id: 'x' }), 0), null);
});

test('stopTimer / stopAllRinging は鳴動中のものだけ進める', () => {
  const a = createTimer({ text: 'a', durationMs: M, now: 0, id: 'a' });
  const b = createTimer({ text: 'b', durationMs: M, now: 0, id: 'b', repeat: { breakMs: 0, total: null } });
  const c = createTimer({ text: 'c', durationMs: 10 * M, now: 0, id: 'c' });
  const now = 2 * M;
  assert.deepEqual(stopTimer([a, b, c], 'a', now).map((t) => t.id), ['b', 'c']);
  assert.deepEqual(stopTimer([a, b, c], 'c', now).map((t) => t.id), ['a', 'b', 'c']); // 未発火は変わらない
  const all = stopAllRinging([a, b, c], now);
  assert.deepEqual(all.map((t) => t.id), ['b', 'c']);
  assert.equal(all[0].repeat.done, 1);
  assert.equal(all[0].endAt, now + M);
});

test('dueWarning: 一度だけ・遅れたものは読まず記録のみ', () => {
  const t = createTimer({ text: '薬', durationMs: 10 * M, now: 0, id: 'a', warns: [5 * M, M] });
  assert.equal(dueWarning(t, 4 * M), null);                      // まだ5分前でない
  let d = dueWarning(t, 5 * M + 1000);                           // 残り4:59
  assert.deepEqual(d, { fire: 5 * M, mark: [5 * M] });
  const t2 = markWarned(t, d.mark);
  assert.equal(dueWarning(t2, 5 * M + 2000), null);              // 二重に鳴らない
  d = dueWarning(t2, 9 * M + 30_000);                            // 残り30秒: 1分前が due
  assert.deepEqual(d, { fire: M, mark: [M] });
  // 画面を離れていて大幅に遅れた場合は、読まずに記録だけ
  d = dueWarning(t, 9 * M + 50_000);
  assert.equal(d.fire, null);
  assert.deepEqual(d.mark.sort((a, b) => a - b), [M, 5 * M]);
  assert.equal(dueWarning(t, 10 * M), null);                     // 鳴動中は対象外
});

test('dueWarning: 休憩の段階では休憩の長さを基準にする', () => {
  const t = createTimer({ text: '作業', durationMs: 25 * M, now: 0, id: 'a', warns: [5 * M, M], repeat: { breakMs: 3 * M, total: null } });
  const b = advanceTimer(t, 0); // 休憩3分: 5分前は無効、1分前のみ有効
  assert.equal(dueWarning(b, 1000), null);
  assert.deepEqual(dueWarning(b, 2 * M + 10_000), { fire: M, mark: [M] });
});

test('describeOpts', () => {
  assert.equal(describeOpts(null), '');
  assert.equal(describeOpts({ warns: [M, 5 * M], repeat: { breakMs: 5 * M, total: 4 } }), '予告 5分前・1分前 / 繰り返し(休憩5分・4回)');
  assert.equal(describeOpts({ warns: [], repeat: { breakMs: 0, total: null } }), '繰り返し(休憩なし・止めるまで)');
});

test('addFavorite: 設定(opts)つきは別物として登録、時間なしでは opts を持たない', () => {
  const opts = { warns: [M], repeat: null };
  let r = addFavorite([], { text: '水', durationMs: 60 * M, id: '1' });
  r = addFavorite(r.favorites, { text: '水', durationMs: 60 * M, opts, id: '2' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.favorites[1], { id: '2', text: '水', durationMs: 60 * M, opts });
  assert.equal(addFavorite(r.favorites, { text: '水', durationMs: 60 * M, opts, id: '3' }).ok, false);
  const textOnly = addFavorite([], { text: '水', opts, id: '4' });
  assert.deepEqual(textOnly.favorites[0], { id: '4', text: '水', durationMs: null });
});
