/** Placeholder entry point: draws "scaffold OK" on the page canvas. */
export function renderPlaceholder(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const dpr = window.devicePixelRatio || 1;
  const size = Math.min(canvas.clientWidth, canvas.clientHeight) || 512;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#1b1f24';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#e6edf3';
  ctx.font = `600 ${Math.round(size / 12)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('scaffold OK', size / 2, size / 2);
}

const el = typeof document === 'undefined' ? null : document.getElementById('view');
if (el instanceof HTMLCanvasElement) {
  renderPlaceholder(el);
  window.addEventListener('resize', () => renderPlaceholder(el));
}
