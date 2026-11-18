/** Procedural test card (no network): gradients, color bars, shapes and fine detail. */
export async function makeSampleImage(w = 1600, h = 1200): Promise<ImageBitmap> {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, h * 0.7);
  sky.addColorStop(0, '#1b2a6b');
  sky.addColorStop(0.55, '#e0648a');
  sky.addColorStop(1, '#ffc46b');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  // sun with stripes
  g.save();
  g.beginPath();
  g.arc(w * 0.68, h * 0.42, h * 0.2, 0, Math.PI * 2);
  g.clip();
  const sun = g.createLinearGradient(0, h * 0.22, 0, h * 0.62);
  sun.addColorStop(0, '#fff3a0');
  sun.addColorStop(1, '#ff5a36');
  g.fillStyle = sun;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#e0648a';
  for (let i = 0; i < 7; i++) g.fillRect(0, h * 0.44 + i * i * 4 + i * 14, w, 4 + i * 2.2);
  g.restore();
  // mountains
  const ridge = (base: number, amp: number, col: string, seed: number) => {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w; x += 8) {
      const y = base - Math.abs(Math.sin(x * 0.004 + seed) * amp) - Math.sin(x * 0.019 + seed * 3) * amp * 0.25;
      g.lineTo(x, y);
    }
    g.lineTo(w, h);
    g.fill();
  };
  ridge(h * 0.68, h * 0.18, '#3b2b6e', 1.3);
  ridge(h * 0.76, h * 0.12, '#1f1840', 4.1);
  // perspective grid floor
  g.fillStyle = '#120d22';
  g.fillRect(0, h * 0.78, w, h * 0.22);
  g.strokeStyle = '#2fe0ff';
  g.lineWidth = 2;
  for (let i = 0; i < 14; i++) {
    const y = h * 0.78 + Math.pow(i / 13, 2) * h * 0.22;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }
  for (let i = -12; i <= 12; i++) {
    g.beginPath(); g.moveTo(w / 2 + i * 18, h * 0.78); g.lineTo(w / 2 + i * 160, h); g.stroke();
  }
  // SMPTE-ish color bars top-left
  const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
  const bw = w * 0.05;
  bars.forEach((col, i) => { g.fillStyle = col; g.fillRect(w * 0.05 + i * bw, h * 0.07, bw, h * 0.2); });
  g.fillStyle = '#111';
  g.fillRect(w * 0.05, h * 0.27, bw * 7, h * 0.03);
  // grayscale ramp
  for (let i = 0; i < 16; i++) { const v = Math.round((i / 15) * 255); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(w * 0.05 + i * (bw * 7 / 16), h * 0.3, bw * 7 / 16 + 1, h * 0.035); }
  // checker + circles detail
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) { g.fillStyle = (x + y) % 2 ? '#fff' : '#000'; g.fillRect(w * 0.08 + x * 14, h * 0.44 + y * 14, 14, 14); }
  g.strokeStyle = '#fff';
  for (let r = 6; r < 70; r += 8) { g.beginPath(); g.arc(w * 0.3, h * 0.5, r, 0, Math.PI * 2); g.stroke(); }
  // title
  g.font = `900 ${Math.round(h * 0.13)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.fillStyle = '#ffffff';
  g.shadowColor = 'rgba(0,0,0,.45)';
  g.shadowBlur = 18;
  g.fillText('BENT CCD', w * 0.5, h * 0.94);
  return createImageBitmap(c);
}
