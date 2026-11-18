// KeepAwake: Screen Wake Lock を管理。解放されたら再取得、失敗/未対応は状態として通知。
export function createKeepAwake({ onChange }) {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  let sentinel = null;
  let wanted = false;
  let status = supported ? 'idle' : 'unsupported'; // idle | active | failed | unsupported

  function set(s) { if (status !== s) { status = s; onChange(s); } }

  async function acquire() {
    if (!supported || !wanted || sentinel || document.visibilityState !== 'visible') return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
        if (wanted) { set('failed'); acquire(); } // 解放されたら再取得を試みる
      });
      set('active');
    } catch {
      sentinel = null;
      set('failed'); // 低電力モード等
    }
  }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') acquire(); });

  return {
    get status() { return status; },
    supported,
    // true: 保持したい（タイマーあり） / false: 解放
    want(v) {
      wanted = v;
      if (v) { acquire(); return; }
      if (sentinel) { const s = sentinel; sentinel = null; s.release().catch(() => {}); }
      set(supported ? 'idle' : 'unsupported');
    },
    retry() { return acquire(); },
  };
}
