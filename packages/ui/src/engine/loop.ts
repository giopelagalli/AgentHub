const TICK_MS = 1000 / 8;

export function startLoop(onTick: (tick: number) => void, onFrame: () => void): () => void {
  let tick = 0;
  let accumulator = 0;
  let last = performance.now();
  let rafId = 0;
  let stopped = false;

  const frame = (now: number) => {
    if (stopped) return;
    accumulator += now - last;
    last = now;
    while (accumulator >= TICK_MS) {
      accumulator -= TICK_MS;
      onTick(tick++);
    }
    onFrame();
    rafId = requestAnimationFrame(frame);
  };

  rafId = requestAnimationFrame(frame);

  return () => {
    stopped = true;
    cancelAnimationFrame(rafId);
  };
}
