// @ts-check
// Voice pitch sensing, shared by the games: note maths, a YIN fundamental-frequency detector, a tracker that
// gates noise and suppresses octave jumps, and a Web Audio microphone wrapper with calibration and recovery.
// Everything except Microphone is pure and runs in Node for tests. Raw audio never leaves this module.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

export const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);
export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
/** e.g. 57 → "A3", 61.3 → "C♯4" (nearest semitone) */
export const noteName = (m) => { const r = Math.round(m); return `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`; };
/** Shifts `m` by whole octaves to land within ±6 semitones of `target`. Returns the folded pitch and the shift. */
export function fold(m, target) {
  const octaves = Math.round((target - m) / 12);
  return { folded: m + 12 * octaves, octaves: -octaves };
}

/**
 * YIN pitch detector (de Cheveigné & Kawahara 2002) on one frame of mono samples.
 * Picks the first lag whose cumulative-mean-normalized difference dips below `threshold`, which favours the true
 * period over its multiples (sub-octave errors), then refines it with parabolic interpolation.
 * @param {Float32Array} buf at least 2 × sampleRate/minHz samples
 * @returns {{hz:number, confidence:number, db:number}} hz = 0 when no periodicity; confidence = 1 − aperiodicity
 */
export function yin(buf, sampleRate, { minHz = 65, maxHz = 1000, threshold = 0.15 } = {}) {
  let x = buf, sr = sampleRate;
  // Voices sit far below 12 kHz, so halve the rate first: 4× fewer operations.
  if (sr >= 32000) {
    x = new Float32Array(buf.length >> 1);
    for (let i = 0; i < x.length; i++) x[i] = (buf[2 * i] + buf[2 * i + 1]) / 2;
    sr /= 2;
  }
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const db = 10 * Math.log10(sum / buf.length + 1e-12);
  const tauMin = Math.max(2, Math.floor(sr / maxHz)), tauMax = Math.min(Math.floor(sr / minHz), x.length >> 1);
  const width = x.length - tauMax, d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let j = 0; j < width; j++) { const v = x[j] - x[j + tau]; s += v * v; }
    d[tau] = s;
  }
  // Cumulative mean normalized difference.
  d[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) { running += d[tau]; d[tau] = running ? (d[tau] * tau) / running : 1; }
  let best = -1;
  for (let tau = tauMin; tau < tauMax; tau++) {
    if (d[tau] < threshold) {
      while (tau + 1 < tauMax && d[tau + 1] < d[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    // No clear dip: report the global minimum with its (low) confidence so callers can gate it.
    best = tauMin;
    for (let tau = tauMin; tau < tauMax; tau++) if (d[tau] < d[best]) best = tau;
  }
  const a = d[best - 1], b = d[best], c = d[best + 1] ?? b;
  const shift = a + c - 2 * b ? clamp((a - c) / (2 * (a + c - 2 * b)), -0.5, 0.5) : 0;
  return { hz: sr / (best + shift), confidence: clamp(1 - b, 0, 1), db };
}

/**
 * Turns raw YIN frames (~25 Hz) into steady pitch: a noise gate (calibrated floor), a confidence gate,
 * octave-jump hysteresis and a 10 Hz summary (median pitch, mean confidence, peak level).
 */
export class PitchTracker {
  constructor({ gateDb = -50, minConfidence = 0.8, jumpFrames = 3, minHz = 65, maxHz = 1000 } = {}) {
    Object.assign(this, { gateDb, minConfidence, jumpFrames, minHz, maxHz });
    this.prev = 0; this.prevAt = -1e9; this.pendingJump = 0; this.window = []; this.recent = [];
  }

  /** Sets the gate from levels measured while the participant stays quiet. */
  calibrate(levels) {
    const sorted = [...levels].sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * 0.8)] ?? -70;
    this.floorDb = floor;
    this.gateDb = clamp(floor + 9, -62, -35);
    return this.gateDb;
  }

  /**
   * @param {{hz:number, confidence:number, db:number}} est one YIN frame @param {number} now ms
   * @returns {{midi:number, voiced:boolean, confidence:number, db:number, corrected:boolean}}
   */
  frame(est, now) {
    const voiced = est.db >= this.gateDb && est.confidence >= this.minConfidence && est.hz >= this.minHz && est.hz <= this.maxHz;
    let midi = voiced ? hzToMidi(est.hz) : 0, corrected = false;
    if (voiced && this.prev && now - this.prevAt < 300) {
      // A sudden ±1–2 octave leap is far more often a harmonic or sub-harmonic lock than a real leap.
      // Hold the previous octave until the new one persists for `jumpFrames` frames.
      const octaves = Math.round((midi - this.prev) / 12);
      if (octaves && Math.abs(midi - 12 * octaves - this.prev) < 1.5) {
        if (++this.pendingJump < this.jumpFrames) { midi -= 12 * octaves; corrected = true; }
      } else this.pendingJump = 0;
    } else this.pendingJump = 0;
    if (voiced) {
      // Median of the last 3 voiced frames removes single-frame glitches without lagging glides much.
      this.recent = [...this.recent.slice(-2), midi];
      const sorted = [...this.recent].sort((a, b) => a - b);
      if (this.recent.length === 3 && !corrected) midi = sorted[1];
      this.prev = midi; this.prevAt = now;
    } else if (now - this.prevAt > 300) this.recent = [];
    const out = { midi, voiced, confidence: est.confidence, db: est.db, corrected };
    this.window.push(out);
    return out;
  }

  /** 10 Hz summary of frames since the last call. Voiced when at least half the frames were. Null when every frame was gated. */
  take() {
    const frames = this.window;
    this.window = [];
    if (!frames.length) return null;
    const voiced = frames.filter((f) => f.voiced), db = Math.max(...frames.map((f) => f.db));
    if (voiced.length * 2 < frames.length) return { midi: 0, voiced: false, confidence: Math.max(...frames.map((f) => f.confidence)), db };
    const midis = voiced.map((f) => f.midi).sort((a, b) => a - b);
    return { midi: midis[midis.length >> 1], voiced: true, confidence: voiced.reduce((s, f) => s + f.confidence, 0) / voiced.length, db };
  }
}

/**
 * Keeps the phone's own reference tone (or any synthesized tone nearby) out of the measurements. Two independent checks:
 * 1. Time gate: frames analysed while our tone is audible are dropped. The window is padded by the analysis frame,
 *    the output latency (Bluetooth speakers can add 150–300 ms) and a room-decay tail. Dropped frames are not
 *    "silence": the caller simply sends nothing for that moment.
 * 2. Machine-steady filter: a synthesized tone holds its pitch to a fraction of a cent on an equal-tempered note.
 *    Human hums wobble by 5–20 cents even when well held. Pitch that sits within `etCents` of an equal-tempered
 *    note with under `steadyCents` of spread for `steadyFrames` frames (~300 ms) is treated as a loudspeaker,
 *    which also catches a neighbour's phone and echo tails that escape the time gate.
 * Octave folding cannot help: a leaked tone folds onto the target and would score as perfectly in tune.
 */
export class LeakGuard {
  constructor({ tailMs = 150, frameMs = 50, steadyCents = 1.5, steadyFrames = 8, etCents = 6 } = {}) {
    Object.assign(this, { tailMs, frameMs, steadyCents, steadyFrames, etCents });
    /** @type {[number, number][]} audible intervals, performance.now() ms */ this.audible = [];
    this.recent = []; this.latencyMs = 0; this.dropped = { tone: 0, steady: 0 };
  }

  /** Records that our tone is audible from t0 to t1 (ms). Returns the interval; set its end later for open-ended tones. */
  mark(t0, t1) { const iv = [t0, t1]; this.audible = [...this.audible.filter(([, b]) => b > t0 - 10000), iv]; return iv; }

  /** True while our tone (with latency and tail) may still reach the mic. */
  sounding(now) {
    const pad = this.latencyMs + this.tailMs + this.frameMs;
    return this.audible.some(([a, b]) => now >= a + this.latencyMs && now <= b + pad);
  }

  /** @returns {"tone"|"steady"|null} why this frame must be dropped */
  check(est, now) {
    if (this.sounding(now)) { this.recent = []; this.dropped.tone++; return "tone"; }
    if (est.confidence < 0.8 || !est.hz) { this.recent = []; return null; }
    const midi = hzToMidi(est.hz);
    this.recent = [...this.recent.slice(1 - this.steadyFrames), midi];
    if (this.recent.length < this.steadyFrames) return null;
    const mean = this.recent.reduce((a, b) => a + b, 0) / this.recent.length;
    const sd = Math.sqrt(this.recent.reduce((s, m) => s + (m - mean) ** 2, 0) / this.recent.length) * 100;
    if (sd < this.steadyCents && Math.abs(mean - Math.round(mean)) * 100 < this.etCents) { this.dropped.steady++; return "steady"; }
    return null;
  }
}

/**
 * Microphone → PitchTracker on the main thread (AnalyserNode works on every mobile browser; AudioWorklet is not needed at 25 Hz).
 * States: off, asking, calibrating, live, muted (track muted by the OS or a call), interrupted (audio session paused),
 * denied, nomic, insecure, error. Call start() synchronously inside a tap: iOS Safari unlocks audio only then.
 */
export class Microphone {
  /** @param {{onFrame?:(f:any)=>void, onState?:(state:string, detail?:string)=>void, calibrateMs?:number}} options */
  constructor({ onFrame = () => {}, onState = () => {}, calibrateMs = 1200 } = {}) {
    Object.assign(this, { onFrame, onState, calibrateMs });
    this.state = "off"; this.tracker = new PitchTracker(); this.guard = new LeakGuard(); this.frames = 0; this.stamps = [];
    /** @type {AudioContext|null} */ this.ctx = null;
    this.buf = new Float32Array(2048);
  }

  setState(state, detail) { this.state = state; this.onState(state, detail); }

  /** Creates (or resumes) the shared AudioContext. Must run inside a user gesture on iOS. */
  audio() {
    const AC = globalThis.AudioContext ?? /** @type {any} */ (globalThis).webkitAudioContext;
    this.ctx ??= new AC({ latencyHint: "interactive" });
    this.ctx.resume?.();
    this.ctx.onstatechange = () => {
      if (this.ctx?.state === "running" && this.state === "interrupted") this.setState("live");
      else if (this.ctx?.state !== "running" && this.state === "live") this.setState("interrupted");
    };
    return this.ctx;
  }

  async start() {
    const ctx = this.audio(); // before any await, so the tap still counts
    if (!globalThis.isSecureContext) return this.setState("insecure");
    if (!navigator.mediaDevices?.getUserMedia) return this.setState("nomic");
    this.setState("asking");
    try {
      // Noise suppression and AGC treat a sustained hum as noise and squash it; echo cancellation distorts pitch.
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    } catch (e) {
      return this.setState(e?.name === "NotAllowedError" || e?.name === "SecurityError" ? "denied" : "nomic", e?.message);
    }
    const track = this.stream.getAudioTracks()[0];
    track.onmute = () => this.setState("muted");
    track.onunmute = () => this.setState("live");
    track.onended = () => this.setState("nomic", "The microphone was disconnected");
    this.source = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);
    await ctx.resume().catch(() => {});
    this.recalibrate();
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.analyser || !this.ctx) return;
      this.analyser.getFloatTimeDomainData(this.buf);
      const now = performance.now(), est = yin(this.buf, this.ctx.sampleRate);
      this.frames++; this.stamps.push(now); if (this.stamps.length > 50) this.stamps.shift();
      this.guard.latencyMs = ((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000;
      const leak = this.guard.check(est, now);
      if (this.state === "calibrating") {
        if (!leak) this.levels.push(est.db);
        if (now - this.calibrateAt >= this.calibrateMs && this.levels.length >= 10) { this.tracker.calibrate(this.levels); this.setState("live"); }
        return;
      }
      // Leaked frames bypass the tracker so they neither count as silence nor disturb its octave memory.
      this.onFrame(leak ? { leak, db: est.db, voiced: false, midi: 0, confidence: 0 } : this.tracker.frame(est, now));
    }, 40);
  }

  /** Re-measures the noise floor (ask the participant to stay quiet). */
  recalibrate() { this.levels = []; this.calibrateAt = performance.now(); this.setState("calibrating"); }

  /** Resumes a suspended audio session (iOS after a call, lock screen or tab switch). */
  resume() {
    this.ctx?.resume?.();
    if (this.stream && !this.stream.getAudioTracks().some((t) => t.readyState === "live")) this.start();
  }

  stop() {
    clearInterval(this.timer);
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null;
    this.setState("off");
  }

  /** Sensor health for the diagnostics strip. */
  diagnostics(now = performance.now()) {
    const s = this.stamps, hz = s.length > 1 ? ((s.length - 1) * 1000) / (s.at(-1) - s[0]) : 0;
    return { state: this.state, hz, ageMs: s.length ? now - s.at(-1) : Infinity, sampleRate: this.ctx?.sampleRate ?? 0, gateDb: this.tracker.gateDb, floorDb: this.tracker.floorDb };
  }
}
