// =============================================================================
//  STRIPE VISUALIZER  —  audio-reactive pinstripes
// -----------------------------------------------------------------------------
//  The "journeys" cover is built entirely from horizontal bands. While a track
//  plays, the thin stripe under the "journeys" wordmark swells with the
//  music: every element tagged `data-viz-band="n"` receives a smoothed 0..1
//  level for frequency band n as its `--b` custom property, and CSS turns that
//  into a scaleY. Nothing else moves — the page stays as flat as the cover.
//
//  Cheap by design: the render loop only runs while playing (plus a short tail
//  while levels decay back to zero), writes one custom property per tagged
//  element, and is skipped entirely under prefers-reduced-motion.
// =============================================================================

// FFT bin edges (fftSize 1024 → ~43 Hz per bin at 44.1 kHz):
//   band 0 = kick / bass   (~43–170 Hz)
//   band 1 = snare / body  (~215–1030 Hz)
const BAND_EDGES = [
  [1, 4],
  [5, 24],
];
const BAND_COUNT = BAND_EDGES.length;

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
    analyser.fftSize = 1024;
    // Low smoothing keeps transients (drum hits) sharp; the frame loop does
    // its own easing.
    analyser.smoothingTimeConstant = 0.5;
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
  const levels = new Float32Array(BAND_COUNT); // eased output, 0..1
  // Adaptive normalisation. A mastered rock mix is loud in the low end all
  // the time, so absolute level would pin the stripes at maximum. Instead we
  // track each band's running average (slow) and recent peak, and output how
  // far the current frame sits above the average — i.e. the beats.
  const avgLevel = new Float32Array(BAND_COUNT);
  const peakLevel = new Float32Array(BAND_COUNT);
  // Per band: 0 → seed avg/peak from the first audible frame.
  const seeded = new Uint8Array(BAND_COUNT);

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
      if (freqData && active) {
        const [start, end] = BAND_EDGES[b];
        let sum = 0;
        for (let i = start; i < end; i++) sum += freqData[i];
        const raw = sum / (end - start) / 255;
        if (!seeded[b]) {
          // Start from the music's actual level (skipping the silent frames
          // while the track loads), otherwise the first seconds of every play
          // read as one long "beat" and pin the stripes wide.
          if (raw < 0.02) continue;
          avgLevel[b] = raw;
          peakLevel[b] = raw;
          seeded[b] = 1;
        }
        avgLevel[b] += (raw - avgLevel[b]) * 0.015; // ~1 s memory
        peakLevel[b] = Math.max(raw, peakLevel[b] * 0.998); // slow peak decay
        const range = Math.max(0.06, peakLevel[b] - avgLevel[b]);
        target = Math.min(1, Math.max(0, (raw - avgLevel[b]) / range));
      }
      // Gentle easing both ways so the stripes swell and settle slowly
      // rather than twitching on every hit.
      const k = target > levels[b] ? 0.12 : 0.035;
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
      if (next && !active) seeded.fill(0);
      active = next;
      if (active && !raf && !reduced && targets.length) {
        raf = requestAnimationFrame(frame);
      }
    },
  };
}
