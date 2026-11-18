"""
Test media for the video / GIF checks, generated locally (no ffmpeg needed):

  - WebM (and MP4 when this Chrome's MediaRecorder can write it) recorded from an animated
    canvas with canvas.captureStream + MediaRecorder, with an audio track (WebAudio tone);
  - an animated GIF drawn with Pillow;
  - a corrupt "video" (random bytes) for the error path;
  - an MP4 copy whose track matrix says "rotate 90°" (rotation metadata).

Every frame shows its index in big digits and moving bars, so motion is easy to detect.
"""
import base64, os, struct
from pathlib import Path
from PIL import Image, ImageDraw

RECORD_JS = r"""
async ({w, h, secs, mime, audio}) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const stream = c.captureStream(30);
  let ac = null;
  if (audio) {
    ac = new AudioContext();
    const osc = ac.createOscillator();
    osc.frequency.value = 440;
    const dst = ac.createMediaStreamDestination();
    osc.connect(dst);
    osc.start();
    stream.addTrack(dst.stream.getAudioTracks()[0]);
  }
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));
  rec.start(250);
  const t0 = performance.now();
  let n = 0;
  await new Promise((resolve) => {
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      if (t >= secs) return resolve();
      for (let i = 0; i < 8; i++) {
        g.fillStyle = `hsl(${(i * 45 + t * 120) % 360} 80% 50%)`;
        g.fillRect((i * w) / 8, 0, w / 8 + 1, h);
      }
      const x = ((t * 0.4) % 1) * w;
      g.fillStyle = '#fff';
      g.fillRect(x, h * 0.35, w * 0.12, h * 0.3);
      g.fillStyle = '#000';
      g.font = `bold ${Math.round(h / 4)}px monospace`;
      g.fillText(String(n++), w * 0.05, h * 0.9);
      requestAnimationFrame(draw);
    };
    draw();
  });
  rec.stop();
  await done;
  stream.getTracks().forEach((t) => t.stop());
  if (ac) await ac.close();
  const blob = new Blob(chunks, { type: mime });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
"""

def make_gif(path: Path, w=320, h=240, frames=48):
    imgs = []
    for i in range(frames):
        im = Image.new("RGB", (w, h))
        d = ImageDraw.Draw(im)
        for b in range(8):
            hue = (b * 32 + i * 8) % 256
            d.rectangle([b * w // 8, 0, (b + 1) * w // 8, h], fill=(hue, 255 - hue, (hue * 3) % 256))
        x = (i * 6) % w
        d.rectangle([x, h // 3, x + 40, 2 * h // 3], fill=(255, 255, 255))
        d.text((10, h - 30), f"{i:02d}", fill=(0, 0, 0))
        imgs.append(im.convert("P", palette=Image.ADAPTIVE))
    imgs[0].save(path, save_all=True, append_images=imgs[1:], duration=40, loop=0, disposal=1)

def rotate_mp4(src: Path, dst: Path) -> bool:
    """Copies an MP4 setting the video track header matrix to a 90° rotation."""
    b = bytearray(src.read_bytes())
    i = b.find(b"tkhd")
    found = False
    while i != -1:
        version = b[i + 4]
        # after the type: version/flags (4) + created/modified/track_ID/reserved/duration (20 in v0,
        # 32 in v1) + reserved (8) + layer, alternate_group, volume, reserved (2 each) → matrix (9 × 4)
        mat = i + 4 + 4 + (20 if version == 0 else 32) + 16
        w = struct.unpack(">I", b[mat + 36:mat + 40])[0] >> 16
        if w:  # the video track (audio tracks have width 0)
            one, mone = 0x00010000, 0xFFFF0000
            b[mat:mat + 36] = struct.pack(">9I", 0, one, 0, mone, 0, 0, 0, 0, 0x40000000)
            found = True
        i = b.find(b"tkhd", i + 4)
    dst.write_bytes(bytes(b))
    return found

async def make_fixtures(pg, out: Path) -> dict:
    """Records the fixtures inside the page `pg` (any page of the app). Returns {name: path}."""
    out.mkdir(parents=True, exist_ok=True)
    files = {}
    webm = await pg.evaluate("['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || ''")
    mp4 = await pg.evaluate("['video/mp4;codecs=avc1.42E01F,mp4a.40.2','video/mp4;codecs=avc1','video/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || ''")
    jobs = [("clip-720.webm", 1280, 720, webm, True), ("clip-1080.webm", 1920, 1080, webm, False)]
    if mp4:
        jobs += [("clip-720.mp4", 1280, 720, mp4, True), ("clip-1080.mp4", 1920, 1080, mp4, False)]
    for name, w, h, mime, audio in jobs:
        if not mime:
            continue
        data = await pg.evaluate(RECORD_JS, {"w": w, "h": h, "secs": 3, "mime": mime, "audio": audio})
        p = out / name
        p.write_bytes(base64.b64decode(data))
        files[name] = p
    make_gif(out / "anim.gif")
    files["anim.gif"] = out / "anim.gif"
    bad = out / "roto.mp4"
    bad.write_bytes(b"\x00\x00\x00\x18ftypmp42" + os.urandom(20000))
    files["roto.mp4"] = bad
    if "clip-720.mp4" in files and rotate_mp4(files["clip-720.mp4"], out / "rotado-90.mp4"):
        files["rotado-90.mp4"] = out / "rotado-90.mp4"
    return files
