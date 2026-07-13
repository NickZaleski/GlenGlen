// =============================================================================
//  LIQUID LIGHT SHOW  —  audio-reactive background
// -----------------------------------------------------------------------------
//  The modern descendant of the 1960s oil-and-dye liquid light show: layered
//  "oil blobs" rendered as additive radial gradients on a 2D canvas. When a
//  track is playing they warp, drift, and shift in intensity to the music via a
//  Web Audio AnalyserNode; when idle they breathe on a slow ambient clock so the
//  page is never dead.
//
//  It also publishes a normalized amplitude to `document.body` as the CSS custom
//  property `--pulse` (0..1), which the wordmark's chromatic aberration and the
//  play button's glow ring read from — so the whole identity reacts as one.
//
//  Deliberately dependency-free and cheap: a handful of gradients per frame,
//  DPR-capped, paused when the tab is hidden, and downgraded under
//  prefers-reduced-motion.
// =============================================================================

type RGB = [number, number, number];

// Oil-slick accent palette (matches the CSS design tokens).
const PALETTE: RGB[] = [
  [86, 251, 160], // acid green
  [255, 62, 165], // electric magenta
  [53, 224, 255], // cyan
  [124, 77, 255], // deep violet
];

interface Blob {
  x: number; // 0..1 relative position
  y: number;
  baseR: number; // base radius as fraction of min(viewport)
  driftX: number; // ambient drift speed
  driftY: number;
  phase: number; // per-blob phase offset
  color: RGB;
  band: number; // which FFT band (0..1) drives this blob
}

export interface LiquidHandle {
  /** Route an <audio> element's output through the shared analyser. Safe to
   *  call once per element; repeated calls for the same element are ignored. */
  connect(el: HTMLMediaElement): void;
  /** Resume the AudioContext (must be triggered by a user gesture). */
  resume(): void;
}

export function initLiquid(canvasId = "liquid-canvas"): LiquidHandle | null {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!canvas) return null;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // --- Web Audio graph (created lazily; needs a user gesture to start) ---
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let freqData: Uint8Array | null = null;
  const connected = new WeakSet<HTMLMediaElement>();

  const ensureAudio = () => {
    if (audioCtx) return;
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256; // 128 frequency bins — plenty for a visualizer
    analyser.smoothingTimeConstant = 0.82; // buttery, not jittery
    freqData = new Uint8Array(analyser.frequencyBinCount);
    // Analyser feeds the speakers so audio still plays.
    analyser.connect(audioCtx.destination);
  };

  const handle: LiquidHandle = {
    connect(el) {
      ensureAudio();
      if (!audioCtx || !analyser || connected.has(el)) return;
      try {
        const src = audioCtx.createMediaElementSource(el);
        src.connect(analyser);
        connected.add(el);
      } catch {
        // createMediaElementSource throws if the element is already sourced;
        // ignore — it means we (or the browser) already wired it.
      }
    },
    resume() {
      ensureAudio();
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    },
  };

  // --- Blobs: seeded deterministically so the composition is intentional ---
  const rand = mulberry32(0x9e3779b9);
  const BLOB_COUNT = reduced ? 4 : 7;
  const blobs: Blob[] = Array.from({ length: BLOB_COUNT }, (_, i) => ({
    x: rand(),
    y: rand(),
    baseR: 0.28 + rand() * 0.32,
    driftX: (rand() - 0.5) * 0.02,
    driftY: (rand() - 0.5) * 0.02,
    phase: rand() * Math.PI * 2,
    color: PALETTE[i % PALETTE.length],
    band: rand(),
  }));

  // --- Sizing (DPR-capped for perf on retina) ---
  let W = 0;
  let H = 0;
  let dpr = 1;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize, { passive: true });

  // --- Amplitude smoothing for the --pulse CSS var ---
  let pulse = 0;

  const sampleAudio = (): { level: number; bands: number[] } => {
    if (!analyser || !freqData) return { level: 0, bands: [] };
    analyser.getByteFrequencyData(freqData);
    const n = freqData.length;
    let sum = 0;
    const bands: number[] = [];
    // Split the spectrum into BLOB_COUNT log-ish bands.
    for (let b = 0; b < BLOB_COUNT; b++) {
      const start = Math.floor((b / BLOB_COUNT) * n);
      const end = Math.floor(((b + 1) / BLOB_COUNT) * n);
      let bs = 0;
      for (let i = start; i < end; i++) bs += freqData[i];
      const avg = bs / Math.max(1, end - start) / 255;
      bands.push(avg);
    }
    for (let i = 0; i < n; i++) sum += freqData[i];
    const level = sum / n / 255;
    return { level, bands };
  };

  let raf = 0;
  let running = false;

  const frame = (tMs: number) => {
    const t = tMs / 1000;
    const { level, bands } = sampleAudio();

    // Smooth the master amplitude and publish it for the CSS-driven reactions.
    pulse += (level - pulse) * 0.12;
    document.body.style.setProperty("--pulse", pulse.toFixed(3));

    // Base wash — a very dark inky field so blobs read as projected light.
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#05100e";
    ctx.fillRect(0, 0, W, H);

    // Additive blobs.
    ctx.globalCompositeOperation = "lighter";
    const minDim = Math.min(W, H);
    const idle = reduced ? 0.0 : 1.0;

    for (let i = 0; i < blobs.length; i++) {
      const bl = blobs[i];
      const bandLevel = bands.length
        ? bands[Math.floor(bl.band * bands.length)] ?? 0
        : 0;

      // Ambient drift (slow figure-eight) + audio-driven expansion.
      const wob = idle * 0.06;
      const cx =
        (bl.x + Math.sin(t * 0.13 + bl.phase) * wob + bl.driftX * t * 0.4) % 1.2;
      const cy =
        (bl.y + Math.cos(t * 0.11 + bl.phase) * wob + bl.driftY * t * 0.4) % 1.2;
      const px = ((cx + 1.2) % 1.2) * W;
      const py = ((cy + 1.2) % 1.2) * H;

      // Radius pulses with its band; a gentle idle breath keeps it alive.
      const breath = 1 + Math.sin(t * 0.5 + bl.phase) * 0.08 * idle;
      const r = bl.baseR * minDim * breath * (1 + bandLevel * 0.9);

      const [cr, cg, cb] = bl.color;
      const alpha = 0.16 + bandLevel * 0.5 + pulse * 0.12;

      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha})`);
      g.addColorStop(0.5, `rgba(${cr},${cg},${cb},${alpha * 0.35})`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }

    raf = requestAnimationFrame(frame);
  };

  const start = () => {
    if (running) return;
    running = true;
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  // Pause the render loop when the tab is hidden (saves battery; the audio
  // engine keeps playing independently). Resume on return.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });

  start();
  return handle;
}

// Tiny deterministic PRNG so the blob layout is repeatable (intentional design,
// not random-on-every-load noise).
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let tt = Math.imul(a ^ (a >>> 15), 1 | a);
    tt = (tt + Math.imul(tt ^ (tt >>> 7), 61 | tt)) ^ tt;
    return ((tt ^ (tt >>> 14)) >>> 0) / 4294967296;
  };
}
