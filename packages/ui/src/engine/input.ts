const WIDTH = 320;
const HEIGHT = 288;

export function bindPointer(canvas: HTMLCanvasElement, onClick: (x: number, y: number) => void): void {
  canvas.addEventListener('click', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * WIDTH);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * HEIGHT);
    onClick(x, y);
  });
}
