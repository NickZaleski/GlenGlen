// =============================================================================
//  STRIPE VISUALIZER  —  audio-reactive pinstripes
// -----------------------------------------------------------------------------
//  The "journeys" cover is built entirely from horizontal bands. While a track
//  plays, the thin cream pinstripes between those bands swell with the music:
//  every element tagged `data-viz-band="n"` receives a smoothed 0..1 level for
//  frequency band n as its `--b` custom property, and CSS turns that into a
//  scaleY. Nothing else moves — the page stays as flat as the cover.
//
//  Cheap by design: the render loop only runs while playing (plus a short tail
//  while levels decay back to zero), writes one custom property per tagged
//  element, and is skipped entirely under prefers-reduced-motion.
// =============================================================================

// Log-spaced FFT bin edges (fftSize 256 → ~172 Hz per bin at 44.1 kHz):
// bass, low-mid, mid, presence, air.
const BAND_EDGES = [0, 2, 5, 11, 24, 64];
// Higher bands carry less energy in most mixes; lift them so all stripes move.
const BAND_GAIN = [1, 1.05, 1.2, 1.45, 1.9];
const BAND_COUNT = BAND_EDGES.length - 1;

export interface VisualizerHandle {
  /** Route an <audio> element's output through the shared analyser. Safe to
   *  call once per element; repeated calls for the same element are ignored. */
  connect(el: HTMLMediaElement): void;
  /** Resume the AudioContext (must be triggered by a user gesture). */
  resume(): void;
  /** Start/stop the render loop to match playback state. */
  setActive(active: boolean): void;
}

export function initVisualizer(): VisualizerHandle {
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
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    // Analyser feeds the speakers so audio still plays.
    analyser.connect(audioCtx.destination);
  };

  // --- Targets: every element that wants a band level ---
  const targets = Array.from(
    document.querySelectorAll<HTMLElement>("[data-viz-band]"),
  ).map((el) => ({
    el,
    band: Math.min(BAND_COUNT - 1, Number(el.dataset.vizBand) || 0),
  }));
  const levels = new Float32Array(BAND_COUNT);

  let active = false;
  let raf = 0;

  const write = () => {
    for (const t of targets) t.el.style.setProperty("--b", levels[t.band].toFixed(3));
  };

  const frame = () => {
    let energy = 0;
    if (analyser && freqData) analyser.getByteFrequencyData(freqData);
    for (let b = 0; b < BAND_COUNT; b++) {
      let target = 0;
      if (freqData) {
        const start = BAND_EDGES[b];
        const end = BAND_EDGES[b + 1];
        let sum = 0;
        for (let i = start; i < end; i++) sum += freqData[i];
        // Square the normalized level so quiet passages stay calm and only
        // real hits push the stripes wide.
        const avg = sum / (end - start) / 255;
        target = Math.min(1, avg * avg * BAND_GAIN[b] * 1.6);
      }
      // Fast attack, slow release — reads as "breathing", not flickering.
      const k = target > levels[b] ? 0.5 : 0.1;
      levels[b] += (target - levels[b]) * k;
      energy += levels[b];
    }
    write();

    // Keep going while playing, then let the stripes settle before stopping.
    if (active || energy > 0.004) {
      raf = requestAnimationFrame(frame);
    } else {
      levels.fill(0);
      write();
      raf = 0;
    }
  };

  return {
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
    setActive(next) {
      active = next;
      if (active && !raf && !reduced && targets.length) {
        raf = requestAnimationFrame(frame);
      }
    },
  };
}
