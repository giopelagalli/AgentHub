const WIDTH = 320;
const HEIGHT = 288;

export class Screen {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  constructor(host: HTMLElement) {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    ctx.imageSmoothingEnabled = false;
    canvas.style.imageRendering = 'pixelated';

    this.canvas = canvas;
    this.ctx = ctx;

    host.appendChild(canvas);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const scale = Math.max(1, Math.floor(Math.min(window.innerWidth / WIDTH, window.innerHeight / HEIGHT)));
    this.canvas.style.width = `${WIDTH * scale}px`;
    this.canvas.style.height = `${HEIGHT * scale}px`;
  }
}
