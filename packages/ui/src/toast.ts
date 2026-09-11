const TOAST_MS = 9000;

/** One transient line in the bottom-right corner; a second toast replaces the first. */
export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  document.querySelector('.toast')?.remove();
  const box = document.createElement('div');
  box.className = kind === 'error' ? 'toast toast--error' : 'toast';
  box.setAttribute('role', 'status');
  box.textContent = text;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'toast__close';
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => box.remove());
  box.appendChild(dismiss);
  document.body.appendChild(box);
  setTimeout(() => box.remove(), TOAST_MS);
}
