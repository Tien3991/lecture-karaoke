// The picture for a recording without cover art: bars that move with the sound, mirrored about a
// line across the middle, on a canvas over the empty video. With an AnalyserNode (the media
// element's audio measured through Web Audio) they show the voice's spectrum, low notes in the
// middle. On iPhone and iPad the app doesn't route the audio through Web Audio (the silent switch
// or the background could mute it), so there they follow the transcript: up while a word is
// spoken. With neither, a slow wave shows that it plays. Browser only.
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const LOW_HZ = 90, HIGH_HZ = 4000;   // the bars' range: where a voice has its strength
/** A steady pseudo-random number in [0, 1) for each x. */
const noise = (x) => { const s = Math.sin(x * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };

/** The word being spoken at t (ms, the words' own clock), or -1 between words. */
export function wordAt(words, t) {
  let lo = 0, hi = words.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at >= 0 && t <= words[at].end + 80 ? at : -1;
}

export class Visualizer {
  /** analyser() -> AnalyserNode or null; speech() -> {words: [{start, end}], shiftMs} or null
   *  (shiftMs: what the media's clock adds to the words' times). */
  constructor(canvas, media, { analyser = () => null, speech = () => null, color = "#ffe000", rest = "#3a3a3a" } = {}) {
    Object.assign(this, { canvas, media, analyser, speech, color, rest, on: false, raf: 0, last: 0, bins: null });
    this.g = canvas.getContext("2d");
    this.levels = new Float32Array(16);
    new ResizeObserver(() => this.resize()).observe(canvas);
    for (const ev of ["play", "pause", "seeked", "ended", "emptied"]) media.addEventListener(ev, () => this.kick());
    reduced.addEventListener?.("change", () => this.kick());
  }

  /** Starts drawing (it stops by itself once paused and at rest), or stops. */
  show(on) {
    this.on = on;
    if (on) this.resize();
    else { cancelAnimationFrame(this.raf); this.raf = 0; this.last = 0; }
  }

  resize() {
    const { canvas } = this, w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(devicePixelRatio || 1, 3);
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const half = Math.max(8, Math.min(32, Math.round(w / 28)));
    if (this.levels.length !== half) this.levels = new Float32Array(half);
    this.draw();
    this.kick();
  }

  kick() {
    if (this.on && !this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  frame(now) {
    this.raf = 0;
    if (!this.on) return;
    const dt = this.last ? Math.min(100, now - this.last) : 16.7, playing = !this.media.paused && !this.media.ended;
    this.last = now;
    const to = this.targets(playing, now), up = Math.min(1, dt / 45), down = Math.min(1, dt / 220);
    let moving = false;
    for (let i = 0; i < this.levels.length; i++) {
      const cur = this.levels[i], next = cur + (to[i] - cur) * (to[i] > cur ? up : down);
      this.levels[i] = Math.abs(next - to[i]) < 0.002 ? to[i] : next;
      moving ||= this.levels[i] !== to[i];
    }
    this.draw(playing);
    if ((playing && !reduced.matches) || moving) this.raf = requestAnimationFrame((t) => this.frame(t));
    else this.last = 0;
  }

  /** Where each bar is heading, 0 to 1 (the lowest notes first). */
  targets(playing, now) {
    const n = this.levels.length, out = new Float32Array(n);
    if (!playing) return out;
    if (reduced.matches) return out.map((_, i) => 0.4 * (1 - (0.5 * i) / n));   // still: one calm shape
    const an = this.analyser();
    if (an) {
      if (this.bins?.length !== an.frequencyBinCount) this.bins = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(this.bins);
      const hz = an.context.sampleRate / an.fftSize;
      for (let i = 0; i < n; i++) {   // bands evenly spaced in pitch
        const a = Math.floor((LOW_HZ * (HIGH_HZ / LOW_HZ) ** (i / n)) / hz);
        const b = Math.max(a + 1, Math.ceil((LOW_HZ * (HIGH_HZ / LOW_HZ) ** ((i + 1) / n)) / hz));
        let sum = 0;
        for (let k = a; k < b; k++) sum += this.bins[k];
        // a little lift for the higher bands, where a voice is weaker
        out[i] = Math.min(1, Math.max(0, (sum / (b - a) / 255 + (0.12 * i) / n - 0.14) / 0.5)) ** 1.15;
      }
      return out;
    }
    const sp = this.speech();
    if (sp?.words.length) {
      const w = wordAt(sp.words, this.media.currentTime * 1000 - sp.shiftMs);
      if (w < 0) return out.fill(0.03);
      const loud = 0.5 + 0.45 * noise(w);
      for (let i = 0; i < n; i++) {
        out[i] = loud * (1 - (0.6 * i) / n) * (0.72 + 0.28 * Math.sin(now / 75 + i * 1.7 + w * 2.3)) * (0.7 + 0.3 * noise(w * 31 + i));
      }
      return out;
    }
    for (let i = 0; i < n; i++) out[i] = 0.12 + 0.08 * Math.sin(now / 520 - i * 0.45);
    return out;
  }

  draw(playing = !this.media.paused) {
    const { g, canvas, levels } = this, W = canvas.width, H = canvas.height, n = levels.length;
    if (!W || !H) return;
    g.clearRect(0, 0, W, H);
    const dpr = W / Math.max(1, canvas.clientWidth), total = 2 * n;
    const slot = Math.min((W * 0.84) / total, 22 * dpr), bw = Math.max(2, slot * 0.56), x0 = (W - slot * total) / 2;
    const mid = H / 2, tallest = Math.min(H * 0.62, W * 0.5);
    g.fillStyle = playing ? this.color : this.rest;
    g.beginPath();
    for (let j = 0; j < total; j++) {
      const i = j < n ? n - 1 - j : j - n, h = Math.max(bw, levels[i] * tallest), x = x0 + j * slot + (slot - bw) / 2;
      if (g.roundRect) g.roundRect(x, mid - h / 2, bw, h, bw / 2);
      else g.rect(x, mid - h / 2, bw, h);
    }
    g.fill();
  }
}
