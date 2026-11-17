/** Only display work is batched. Engine calls and host automation retain their order. */
let depth = 0;
const updates = new Map<string, () => void>();

export function queueVisualUpdate(key: string, update: () => void): void {
  if (!depth) { update(); return; }
  updates.set(key, update);
}

export function batchPluginVisuals(apply: () => void): void {
  depth++;
  try { apply(); } finally {
    if (--depth === 0) {
      const pending = Array.from(updates.values());
      updates.clear();
      pending.forEach((update) => update());
    }
  }
}

/** Native snapshots are the plugin's visual clock; no second perpetual animation loop. */
export function onPluginVisualFrame(draw: () => void): void {
  let frame = 0;
  const schedule = () => {
    if (frame || document.hidden) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!document.hidden) draw();
    });
  };
  window.addEventListener("sy1-frame", schedule);
  schedule();
}
