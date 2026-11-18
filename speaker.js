// Speaker: iOS Safari の speechSynthesis を堅牢に扱う。
// - onend / onerror / 推定時間タイムアウト の最速で次へ（世代トークンで二重進行を防止）
// - cancel() の後は少し待ってから speak()
// - onstart が来なければ「音が出ていない」として通知（タップで再開させる）
import { pickNext, estimateSpeechMs } from './core.js';

const CANCEL_GAP_MS = 100;
const START_TIMEOUT_MS = 3500;
const LOOP_GAP_MS = 1500;

export function createSpeaker({ synth = globalThis.speechSynthesis, Utter = globalThis.SpeechSynthesisUtterance, getRinging, onSpeaking, onBlocked, getRate = () => 1 }) {
  let gen = 0;          // 世代トークン
  let running = false;
  let lastId = null;
  let currentId = null;
  let voice = null;
  let needsTap = false; // 再読込・復帰直後など、ユーザー操作を待つ状態

  const supported = !!(synth && Utter);

  function loadVoice() {
    if (!supported) return;
    const voices = synth.getVoices();
    if (voices.length) {
      voice = voices.find((v) => v.lang === 'ja-JP') || voices.find((v) => v.lang && v.lang.startsWith('ja')) || null;
    }
  }
  if (supported) {
    loadVoice();
    synth.addEventListener?.('voiceschanged', loadVoice);
    // voiceschanged が来ない環境向けのポーリング
    let tries = 0;
    const poll = setInterval(() => { loadVoice(); if (voice || ++tries > 10) clearInterval(poll); }, 500);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1回だけ発話。onend / onerror / タイムアウト の最速で resolve。
  function speakOnce(text, myGen) {
    return new Promise((resolve) => {
      let done = false;
      let started = false;
      const finish = () => { if (!done) { done = true; clearTimeout(startTimer); clearTimeout(maxTimer); resolve(); } };
      const rate = getRate();
      const u = new Utter(text);
      u.lang = 'ja-JP';
      u.rate = rate;
      if (voice) u.voice = voice;
      u.onstart = () => { started = true; if (myGen === gen) onBlocked(false); };
      u.onend = finish;
      u.onerror = finish;
      const startTimer = setTimeout(() => { if (!started && myGen === gen) onBlocked(true); }, START_TIMEOUT_MS);
      const maxTimer = setTimeout(finish, estimateSpeechMs(text, rate) + START_TIMEOUT_MS);
      try {
        if (synth.speaking || synth.pending) synth.cancel();
      } catch { /* noop */ }
      setTimeout(() => {
        if (done || myGen !== gen) { finish(); return; }
        try { synth.speak(u); } catch { finish(); }
      }, CANCEL_GAP_MS);
    });
  }

  async function loop(myGen) {
    while (running && myGen === gen) {
      const ringing = getRinging();
      const t = pickNext(ringing, lastId);
      if (!t) break;
      lastId = t.id;
      currentId = t.id;
      onSpeaking(t.id);
      await speakOnce(t.text, myGen);
      if (myGen !== gen) return;
      currentId = null;
      onSpeaking(null);
      await wait(LOOP_GAP_MS);
    }
    if (myGen === gen) { running = false; currentId = null; onSpeaking(null); }
  }

  function start() {
    if (!supported || running) return;
    running = true;
    gen += 1;
    loop(gen);
  }

  function stop() {
    gen += 1;
    running = false;
    currentId = null;
    lastId = null;
    onSpeaking(null);
    onBlocked(false);
    try { synth?.cancel(); } catch { /* noop */ }
  }

  return {
    supported,
    get needsTap() { return needsTap; },
    setNeedsTap(v) { needsTap = v; },
    // ユーザー操作内で呼ぶ: 極小音量の実発話でアンロック
    unlock() {
      if (!supported) return;
      try {
        const u = new Utter(' ');
        u.volume = 0.01;
        u.lang = 'ja-JP';
        synth.speak(u);
      } catch { /* noop */ }
    },
    // ユーザー操作内で呼ぶ: 再開（ブロック状態の解除）
    resume() {
      needsTap = false;
      this.unlock();
      if (running) { gen += 1; running = false; try { synth.cancel(); } catch { /* noop */ } }
      onBlocked(false);
      this.sync();
    },
    // 鳴動中の状態に合わせてループを開始/停止
    sync() {
      const ringing = getRinging();
      if (ringing.length === 0) { if (running) stop(); return; }
      if (needsTap || !supported) return;
      if (!running) { start(); return; }
      // 現在読み上げ中のタイマーが止められたら、即座に中断して次へ
      if (currentId && !ringing.some((t) => t.id === currentId)) {
        gen += 1; running = false;
        try { synth.cancel(); } catch { /* noop */ }
        start();
      }
    },
    // テスト再生（ユーザー操作内）
    test(text) {
      if (!supported) return false;
      try { synth.cancel(); } catch { /* noop */ }
      setTimeout(() => {
        const u = new Utter(text);
        u.lang = 'ja-JP';
        u.rate = getRate();
        if (voice) u.voice = voice;
        try { synth.speak(u); } catch { /* noop */ }
      }, CANCEL_GAP_MS);
      return true;
    },
    stop,
  };
}
