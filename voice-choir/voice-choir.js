// @ts-check
// Voice Choir core: rounds and songs, group assignment, wire protocol, convergence metrics, JSONL export and
// virtual singers. No DOM access: shared by the page and Node tests. Pitch sensing lives in shared/pitch.js.
import { hzToMidi, midiToHz, fold } from "../shared/pitch.js";

/** Cents from the target (after octave folding) that count as in tune. Generous: these are untrained crowds. */
export const TOLERANCE = 35;
/** A group has converged when this share of its voiced singers is in tune for HOLD_MS. */
export const CONVERGED = 0.6, HOLD_MS = 500;
/** Confidence (0–100) below which a sample is drawn faintly and left out of the metrics. */
export const MIN_CONF = 60;
export const GROUPS = 3;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;

// ---------- Notes, chords, songs ----------
const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** "C4" → 60, "Bb3" → 58, "F#4" → 66 */
export function parseNote(text) {
  const m = /^([A-G])([#b♯♭]?)(-?\d)$/.exec(text);
  if (!m) throw new Error(`Bad note ${text}`);
  return 12 * (+m[3] + 1) + PITCH[m[1]] + (m[2] === "#" || m[2] === "♯" ? 1 : m[2] ? -1 : 0);
}

/** Triads the presenter can pick. Root in a comfortable humming register (G3–F♯4). */
export const CHORDS = ["C", "Dm", "Em", "F", "G", "Am", "D", "E", "A", "B♭", "E♭", "Cm"];
const ROOTS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** @returns {number[]} [root, third, fifth] as MIDI numbers — group 0, 1, 2 */
export function chordNotes(symbol) {
  const m = /^([A-G])([♭♯]?)(m?)$/.exec(symbol);
  if (!m) throw new Error(`Bad chord ${symbol}`);
  let root = 48 + ROOTS[m[1]] + (m[2] === "♭" ? -1 : m[2] === "♯" ? 1 : 0);
  while (root < 55) root += 12;
  return [root, root + (m[3] ? 3 : 4), root + 7];
}
const chordClasses = (symbol) => chordNotes(symbol).map((n) => n % 12);

/**
 * Public-domain tunes in C, within a humming range. Steps are NOTE[:beats][/CHORD] (beat = quarter note); "-" is a rest;
 * the chord carries forward. Groups 1 and 2 sing the two chord tones just below the melody, unless `canon` (beats)
 * staggers entries instead. Default tempos are deliberately slow; the presenter can raise them.
 */
export const SONGS = [
  { id: "birthday", name: "Happy Birthday", credit: "Hill sisters, 1893 · public domain", bpm: 50,
    steps: "G3:0.75/C G3:0.25 A3 G3 C4 B3:2/G G3:0.75 G3:0.25 A3 G3 D4 C4:2/C G3:0.75 G3:0.25 G4 E4 C4/F B3 A3:2 F4:0.75 F4:0.25 E4/C C4 D4/G C4:2/C" },
  { id: "twinkle", name: "Twinkle, Twinkle, Little Star", credit: "Jane Taylor, 1806 · traditional melody", bpm: 42,
    steps: "C4/C C4 G4 G4 A4/F A4 G4:2/C F4/F F4 E4/C E4 D4/G D4 C4:2/C G4/C G4 F4/F F4 E4/C E4 D4:2/G G4/C G4 F4/F F4 E4/C E4 D4:2/G C4/C C4 G4 G4 A4/F A4 G4:2/C F4/F F4 E4/C E4 D4/G D4 C4:2/C" },
  { id: "row", name: "Row, Row, Row Your Boat (round)", credit: "Traditional, 1852 · each group enters 2 bars later", bpm: 50, canon: 6,
    steps: "C4:1.5/C C4:1.5 C4 D4:0.5 E4:1.5 E4 D4:0.5 E4 F4:0.5 G4:3 C5:0.5 C5:0.5 C5:0.5 G4:0.5 G4:0.5 G4:0.5 E4:0.5 E4:0.5 E4:0.5 C4:0.5 C4:0.5 C4:0.5 G4/G F4:0.5 E4 D4:0.5 C4:3/C" },
  { id: "mary", name: "Mary Had a Little Lamb", credit: "Sarah Josepha Hale, 1830 · traditional melody", bpm: 50,
    steps: "E4/C D4 C4 D4 E4 E4 E4:2 D4/G D4 D4:2 E4/C G4 G4:2 E4/C D4 C4 D4 E4 E4 E4 E4 D4/G D4 E4 D4 C4:4/C" },
];
const REST_BEATS = 2;
const songCache = new Map();
/** @returns {{steps:{beat:number, beats:number, melody:number|null, chord:string}[], beats:number}} */
export function parseSong(song) {
  if (songCache.has(song.id)) return songCache.get(song.id);
  let beat = 0, chord = "C";
  const steps = song.steps.trim().split(/\s+/).map((token) => {
    const [main, chordPart] = token.split("/"), [note, len] = main.split(":");
    if (chordPart) chord = chordPart;
    const step = { beat, beats: len ? +len : 1, melody: note === "-" ? null : parseNote(note), chord };
    beat += step.beats;
    return step;
  });
  const parsed = { steps, beats: beat };
  songCache.set(song.id, parsed);
  return parsed;
}

/** Note for a harmony group under a melody note: the chord tones just below it (group 1 nearer, group 2 lower). */
function harmony(melody, chord, group) {
  const classes = chordClasses(chord);
  let n = melody, found = 0;
  while (found < group && n > melody - 24) { n--; if (classes.includes(((n % 12) + 12) % 12) && melody - n >= 3) found++; }
  return n;
}

/**
 * Target segments for `group` between presenter times `from` and `to` (ms). Unison and chord rounds are one
 * open segment. Songs play from `cfg.offset` ms into the song starting at presenter time `cfg.start` (a rest before
 * that is the count-in), loop with a short rest, and a canon delays each group by `canon` beats. Paused = all rest.
 * @returns {{t0:number, t1:number, midi:number|null, step:number}[]}
 */
export function segments(cfg, group, from, to) {
  if (cfg.mode === "unison") return [{ t0: -Infinity, t1: Infinity, midi: cfg.note, step: 0 }];
  if (cfg.mode === "chord") return [{ t0: -Infinity, t1: Infinity, midi: chordNotes(cfg.chord)[group % GROUPS], step: 0 }];
  if (cfg.paused) return [{ t0: -Infinity, t1: Infinity, midi: null, step: -1 }];
  const song = SONGS[cfg.song] ?? SONGS[0], { steps, beats } = parseSong(song), beatMs = 60000 / cfg.bpm;
  // base: when this group's song time 0 falls; entry: when it may first sing (after the count-in and its canon delay).
  const base = cfg.start - (cfg.offset ?? 0) + (song.canon ? song.canon * group : 0) * beatMs, entry = Math.max(cfg.start, base);
  const loop = (beats + REST_BEATS) * beatMs, out = [];
  for (let k = Math.max(0, Math.floor((Math.max(from, entry) - base) / loop)); base + k * loop <= to; k++) {
    const at = base + k * loop;
    steps.forEach((s, i) => out.push({ t0: at + s.beat * beatMs, t1: at + (s.beat + s.beats) * beatMs, step: i,
      midi: s.melody === null ? null : song.canon || !group ? s.melody : harmony(s.melody, s.chord, group) }));
    out.push({ t0: at + beats * beatMs, t1: at + loop, midi: null, step: -1 });
  }
  // Before the entry it is all rest; resuming mid-note clips that note to start at the entry.
  const notes = out.filter((s) => s.t1 > entry).map((s) => (s.t0 < entry ? { ...s, t0: entry } : s));
  return [...(from < entry ? [{ t0: -Infinity, t1: entry, midi: null, step: -1 }] : []), ...notes].filter((s) => s.t1 > from && s.t0 <= to);
}

/** Target MIDI note (or null for a rest) for a group at presenter time t. */
export const targetAt = (cfg, group, t) => segments(cfg, group, t, t)[0]?.midi ?? null;

/** Group labels for the current round, shown to participants and on the presenter legend. */
export function groupNames(cfg) {
  if (cfg.mode === "unison") return ["Unison", "Unison", "Unison"];
  if (cfg.mode === "chord") return ["Root", "Third", "Fifth"];
  return (SONGS[cfg.song] ?? SONGS[0]).canon ? ["Voice 1", "Voice 2", "Voice 3"] : ["Melody", "Harmony", "Low harmony"];
}

export const topics = (room) => {
  const base = `voice-choir/v1/${room}`;
  return { up: `${base}/up`, all: `${base}/all`, client: (id) => `${base}/c/${id}` };
};

// ---------- Presenter room ----------
const ID = /^[a-z0-9]{6,32}$/i;
/** Participant states besides "ok": muted mic, mic permission denied, no mic, audio session interrupted, hearing the reference tone. */
export const STATES = ["ok", "off", "listen", "muted", "denied", "nomic", "interrupted"];
const KEEP_MS = 120000;

/**
 * Authoritative presenter state. `send(to, data)` delivers to "all" or a client id (the caller signs).
 * Samples arrive stamped with the phone's estimate of the presenter clock, so scoring uses the time a singer
 * actually heard and saw the target, not the time the message happened to arrive.
 */
export class ChoirRoom {
  constructor({ send = (_to, _data) => {}, now = () => Date.now(), awayMs = 6000, goneMs = 20000 } = {}) {
    Object.assign(this, { send, now, awayMs, goneMs });
    this.cfg = { mode: "unison", note: 57, chord: "C", song: 0, bpm: SONGS[0].bpm, start: 0, offset: 0, paused: false };
    this.phase = "lobby"; this.round = 1; this.joins = 0; this.messages = 0; this.samples = 0;
    /** @type {Map<string, any>} */ this.clients = new Map();
    this.t0 = this.now();
    this.timeline = []; this.log = []; this.converge = []; this.takes = [{ at: this.t0, cfg: { ...this.cfg } }];
    this.groupState = Array.from({ length: GROUPS }, () => ({ target: null, since: this.t0, goodSince: null, done: false }));
  }

  /** Messages per phone per second: 10 Hz samples are batched more as the room grows, to spare the public relay. */
  get batch() { const n = this.counts().live; return n < 50 ? 2 : n < 150 ? 3 : 5; }
  /** Presenter render/synth delay (ms): covers batching and the measured relay latency. Updated by tick() so it stays steady. */
  get delay() { return this.delayMs ?? this.batch * 100 + 300; }

  status(c, now = this.now()) {
    const silent = now - c.seen;
    return silent < this.awayMs ? "live" : silent < this.goneMs ? "away" : "gone";
  }

  counts(now = this.now()) {
    const counts = { live: 0, away: 0, voiced: 0, quiet: 0, muted: 0, denied: 0, consent: 0, latency: 0 };
    const lat = [];
    for (const c of this.clients.values()) {
      const st = this.status(c, now);
      if (st === "gone") continue;
      counts[st]++;
      if (st !== "live") continue;
      if (c.consent) counts.consent++;
      if (c.st === "denied" || c.st === "nomic") counts.denied++;
      else if (c.st !== "ok" && c.st !== "listen") counts.muted++;
      else if (c.trace.at(-1)?.midi && now - c.trace.at(-1).t < 1500) counts.voiced++;
      else counts.quiet++;
      if (c.latency) lat.push(c.latency);
    }
    counts.latency = Math.round(median(lat));
    return counts;
  }

  /** @param {any} msg a participant message from the up topic */
  handle(msg) {
    if (!msg || msg.v !== 1 || typeof msg.id !== "string" || !ID.test(msg.id)) return;
    this.messages++;
    const now = this.now();
    let c = this.clients.get(msg.id);
    if (msg.t === "bye") { if (c) c.seen = Math.min(c.seen, now - this.awayMs); return; }
    if (!c || msg.t === "hello") c = this.join(msg.id, msg);
    c.seen = now;
    if (STATES.includes(msg.st)) c.st = msg.st;
    if (msg.t !== "p" || !Array.isArray(msg.s) || !Number.isFinite(msg.b)) return;
    for (const s of msg.s.slice(0, 20)) {
      if (!Array.isArray(s)) continue;
      const t = msg.b + clamp(+s[0] || 0, 0, 5000), hz = +s[1] || 0;
      if (t <= (c.trace.at(-1)?.t ?? -Infinity)) continue; // duplicate or reordered
      const sample = { t, midi: hz >= 50 && hz <= 1200 ? hzToMidi(hz) : 0, db: clamp(Math.round(+s[2] || -100), -100, 0), c: clamp(Math.round(+s[3] || 0), 0, 100) };
      c.trace.push(sample);
      this.samples++;
      if (c.consent && this.log.length < 500000) this.log.push([c.n, c.group, t, hz, sample.db, sample.c]);
    }
    // Arrival minus stamp: network latency plus clock-estimate error. Smoothed for the latency pill.
    const lat = now - (msg.b + (+msg.s.at(-1)?.[0] || 0));
    c.latency = c.latency ? c.latency * 0.9 + lat * 0.1 : lat;
    while (c.trace.length && c.trace[0].t < now - KEEP_MS) c.trace.shift();
  }

  join(id, msg) {
    let c = this.clients.get(id);
    if (!c) {
      // Keep a returning phone's group (also after a presenter reload); otherwise fill the smallest group.
      const sizes = this.groupSizes();
      const group = Number.isInteger(msg.g) && msg.g >= 0 && msg.g < GROUPS ? msg.g : sizes.indexOf(Math.min(...sizes));
      c = { id, n: this.joins++, group, seen: this.now(), st: "off", consent: false, os: "other", trace: [], latency: 0 };
      this.clients.set(id, c);
    }
    if (msg.t === "hello") {
      c.consent = msg.consent === true;
      c.os = ["ios", "android", "other"].includes(msg.os) ? msg.os : "other";
      if (!c.consent) this.log = this.log.filter((row) => row[0] !== c.n); // consent withdrawn: forget retained rows
    }
    this.send(id, { t: "assign", to: id, group: c.group, n: c.n });
    return c;
  }

  groupSizes(now = this.now()) {
    const sizes = Array(GROUPS).fill(0);
    for (const c of this.clients.values()) if (this.status(c, now) !== "gone") sizes[c.group]++;
    return sizes;
  }

  /** Re-deals groups evenly among live phones (e.g. after many people left one group). */
  rebalance() {
    const live = [...this.clients.values()].filter((c) => this.status(c) !== "gone").sort((a, b) => a.n - b.n);
    live.forEach((c, i) => { c.group = i % GROUPS; this.send(c.id, { t: "assign", to: c.id, group: c.group, n: c.n }); });
  }

  /** Forgets clients matching `drop` (e.g. virtual phones). Returns how many. */
  release(drop) {
    let n = 0;
    for (const id of [...this.clients.keys()]) if (drop(id)) { this.clients.delete(id); n++; }
    return n;
  }

  /** Latest sample at or before t that is fresh enough to describe the singer at t. maxAge bridges the gaps a phone leaves while its own guide tone plays. */
  sampleAt(c, t, maxAge = 700) {
    const trace = c.trace;
    for (let i = trace.length - 1; i >= 0; i--) if (trace[i].t <= t) return t - trace[i].t <= maxAge ? trace[i] : null;
    return null;
  }

  /**
   * Group metrics at presenter time t: voiced singers, share in tune, median |cents| and spread (IQR, cents),
   * all after folding each pitch to the target's octave.
   */
  metrics(t = this.now() - this.delay) {
    const cfg = this.cfgAt(t), groups = Array.from({ length: GROUPS }, (_, g) => ({ target: targetAt(cfg, g, t), cents: [], quiet: 0 }));
    for (const c of this.clients.values()) {
      if (this.status(c) !== "live") continue;
      const g = groups[c.group], s = this.sampleAt(c, t);
      if (g.target === null) continue;
      if (!s || !s.midi || s.c < MIN_CONF) { g.quiet++; continue; }
      g.cents.push(Math.round((fold(s.midi, g.target).folded - g.target) * 100));
    }
    return groups.map(({ target, cents, quiet }) => {
      const abs = cents.map(Math.abs), sorted = [...cents].sort((a, b) => a - b);
      return { target, voiced: cents.length, quiet, inTune: cents.length ? abs.filter((a) => a <= TOLERANCE).length / cents.length : 0,
        error: Math.round(median(abs)), bias: Math.round(median(cents)), spread: Math.round(quantile(sorted, 0.75) - quantile(sorted, 0.25)) };
    });
  }

  /** Round settings in force at presenter time t (rendering runs behind real time, and replays look back). */
  cfgAt(t) {
    for (let i = this.takes.length - 1; i > 0; i--) if (this.takes[i].at <= t) return this.takes[i].cfg;
    return this.takes[0].cfg;
  }

  /** Call ~4–10 Hz. Records the timeline and convergence times (how long each group took to lock onto a new target). */
  update(t = this.now() - this.delay) {
    if (this.timeline.length && t - this.timeline.at(-1).t < 200) return;
    const groups = this.metrics(t);
    if (this.timeline.length < 20000) this.timeline.push({ t, mode: this.cfg.mode, groups });
    groups.forEach((m, g) => {
      const gs = this.groupState[g];
      if (m.target !== gs.target) Object.assign(gs, { target: m.target, since: t, goodSince: null, done: false });
      // The clock starts once the round is running and the part has someone singing.
      if (!gs.done && (m.target === null || this.phase !== "sing" || !m.voiced)) { gs.since = t; gs.goodSince = null; }
      if (gs.done || m.target === null || this.phase !== "sing") return;
      const good = m.voiced >= Math.min(2, this.groupSizes()[g]) && m.inTune >= CONVERGED;
      if (!good) { gs.goodSince = null; return; }
      gs.goodSince ??= t;
      if (t - gs.goodSince >= HOLD_MS) { gs.done = true; this.converge.push({ t, group: g, target: m.target, ms: Math.round(gs.goodSince - gs.since) }); }
    });
  }

  /** Accuracy over the last `ms`: mean share in tune across voiced, targeted group samples. */
  accuracy(ms = 10000) {
    const end = this.timeline.at(-1)?.t ?? 0, rows = this.timeline.filter((r) => r.t > end - ms);
    let sum = 0, n = 0;
    for (const r of rows) for (const g of r.groups) if (g.voiced) { sum += g.inTune * g.voiced; n += g.voiced; }
    return n ? sum / n : 0;
  }

  /** Median lock-on time (ms) of the last few convergences, or null. */
  lockTime(last = 9) { const xs = this.converge.slice(-last).map((c) => c.ms); return xs.length ? median(xs) : null; }

  /** @param {Partial<{mode:string, note:number, chord:string, song:number, bpm:number}>} change */
  configure(change) {
    const before = JSON.stringify(this.cfg);
    Object.assign(this.cfg, change);
    this.cfg.note = clamp(Math.round(this.cfg.note), 40, 79);
    this.cfg.bpm = clamp(Math.round(this.cfg.bpm), 20, 180);
    if (!CHORDS.includes(this.cfg.chord)) this.cfg.chord = "C";
    if (!SONGS[this.cfg.song]) this.cfg.song = 0;
    // A song (re)starts from the top after a two-beat count-in so every phone can see it coming. It only runs while
    // the room is singing: otherwise it waits, paused at the top, for Start.
    if (this.cfg.mode === "song" && ("song" in change || "mode" in change || "bpm" in change || change.start)) {
      Object.assign(this.cfg, { offset: 0, paused: this.phase !== "sing", start: this.now() + (2 * 60000) / this.cfg.bpm });
    }
    this.commit(before);
  }

  /** Records a take when the settings changed, and tells the phones. */
  commit(before) {
    if (JSON.stringify(this.cfg) !== before) this.takes = [...this.takes.slice(-500), { at: this.now(), cfg: { ...this.cfg } }];
    this.broadcast();
  }

  /** Pause, reveal and lobby freeze a song where it is; Start resumes it from there after a two-beat count-in. */
  setPhase(phase) {
    const before = JSON.stringify(this.cfg), c = this.cfg, now = this.now();
    this.phase = phase;
    if (c.mode === "song" && phase !== "sing" && !c.paused) Object.assign(c, { paused: true, offset: (c.offset ?? 0) + Math.max(0, now - c.start) });
    else if (c.mode === "song" && phase === "sing" && c.paused) Object.assign(c, { paused: false, start: now + (2 * 60000) / c.bpm });
    this.commit(before);
  }

  /** Clears measurements; phones keep their groups. */
  reset() {
    this.round++; this.timeline = []; this.converge = []; this.log = [];
    this.groupState.forEach((g) => Object.assign(g, { target: null, goodSince: null, done: false }));
    this.broadcast();
  }

  tick() {
    const now = this.now(), want = Math.min(1500, Math.max(this.batch * 100 + 300, this.counts().latency + 200));
    // Move in 100 ms steps only when it matters: every change makes the ribbons jump.
    if (Math.abs(want - this.delay) >= 100) this.delayMs = Math.round(want / 100) * 100;
    for (const [id, c] of this.clients) if (now - c.seen > 10 * 60000) this.clients.delete(id);
    this.broadcast();
  }

  broadcast() {
    this.send("all", { t: "state", now: this.now(), phase: this.phase, round: this.round, cfg: this.cfg, live: this.counts().live, batch: this.batch });
  }

  /** JSONL measurements: aggregate group metrics for everyone; per-sample rows only for phones that opted in. No ids. */
  toJSONL({ from = -Infinity, session = Math.random().toString(36).slice(2, 10) } = {}) {
    const rel = (t) => Math.round(t - this.t0);
    const lines = [{ type: "session", schema: "voice-choir/measurements-v1", session, note: "Pitch measurements only. No audio was recorded or uploaded.", tolerance_cents: TOLERANCE, takes: this.takes.filter((k) => k.at >= from).map((k) => ({ t_ms: rel(k.at), ...k.cfg, start: k.cfg.start ? rel(k.cfg.start) : 0 })) }];
    for (const r of this.timeline) if (r.t >= from) lines.push({ type: "summary", t_ms: rel(r.t), mode: r.mode, groups: r.groups.map((g) => ({ target: g.target, voiced: g.voiced, quiet: g.quiet, in_tune: Math.round(g.inTune * 1000) / 1000, error_cents: g.error, bias_cents: g.bias, spread_cents: g.spread })) });
    for (const c of this.converge) if (c.t >= from) lines.push({ type: "converged", t_ms: rel(c.t), group: c.group, target: c.target, lock_ms: c.ms });
    for (const [n, group, t, hz, db, conf] of this.log) if (t >= from) {
      const target = targetAt(this.cfgAt(t), group, t);
      lines.push({ type: "sample", singer: n, group, t_ms: rel(t), hz, db, conf, target, cents: hz && target !== null ? Math.round((fold(hzToMidi(hz), target).folded - target) * 100) : null });
    }
    return lines.map((l) => JSON.stringify(l)).join("\n");
  }
}

// ---------- Participant protocol ----------
/**
 * Phone-side protocol. Collect one sample per 100 ms with push(); flush() batches them as the presenter asks.
 * Timestamps use an estimate of the presenter clock (minimum observed offset), so songs line up across phones.
 */
export class ChoirSession {
  constructor({ id, send, onChange = (_type) => {}, now = () => Date.now() }) {
    Object.assign(this, { id, send, onChange, now });
    this.group = null; this.n = null; this.ready = false; this.phase = "lobby"; this.round = 0;
    this.cfg = { mode: "unison", note: 57, chord: "C", song: 0, bpm: SONGS[0].bpm, start: 0, offset: 0, paused: false };
    this.live = 0; this.batchSize = 2; this.offsets = []; this.offset = 0;
    this.buffer = []; this.base = 0; this.bufferAt = 0; this.st = "off"; this.consent = false; this.os = "other"; this.lastSend = -1e9; this.sent = 0;
  }

  /** Presenter time estimate (ms). */
  clock() { return this.now() - this.offset; }
  target(t = this.clock()) { return this.group === null ? null : targetAt(this.cfg, this.group, t); }

  msg(t, data = {}) { const ok = this.send({ v: 1, t, id: this.id, st: this.st, ...data }); if (ok) this.sent++; return ok; }
  hello() { return this.msg("hello", { g: this.group ?? undefined, consent: this.consent, os: this.os }); }

  /** @param {any} data a verified presenter message */
  receive(data) {
    if (data.to && data.to !== this.id) return;
    if (data.t === "hi") { this.hello(); return; }
    const sent = data.now ?? data.at;
    if (Number.isFinite(sent)) {
      // The smallest local−presenter difference over recent messages is the best offset (least network delay).
      this.offsets = [...this.offsets.slice(-19), this.now() - sent];
      this.offset = Math.min(...this.offsets);
    }
    if (data.t === "assign") Object.assign(this, { group: data.group, n: data.n, ready: true });
    if (data.t === "state") {
      Object.assign(this, { phase: data.phase, round: data.round, live: data.live, batchSize: clamp(data.batch | 0, 1, 10) });
      if (data.cfg) this.cfg = data.cfg;
    }
    this.onChange(data.t);
  }

  /** @param {{midi:number, voiced:boolean, confidence:number, db:number}} s a 10 Hz pitch summary */
  push(s, t = this.clock()) {
    if (!this.buffer.length) { this.base = Math.round(t); this.bufferAt = this.now(); }
    const hz = s.voiced && s.midi ? Math.round(midiToHz(s.midi) * 10) / 10 : 0;
    this.buffer.push([Math.round(t) - this.base, hz, Math.round(s.db), Math.round(s.confidence * 100)]);
  }

  /** Call often (≥10 Hz). Sends batches, or a heartbeat every 2 s when there is nothing to send. */
  flush() {
    const now = this.now();
    if (!this.ready) {
      if (now - this.lastSend > 2000) { this.lastSend = now; this.hello(); }
      return;
    }
    if (this.buffer.length >= this.batchSize || (this.buffer.length && now - this.bufferAt > this.batchSize * 100 + 50)) {
      if (this.msg("p", { b: this.base, s: this.buffer })) this.buffer = [];
      else if (this.buffer.length > 30) this.buffer = this.buffer.slice(-10); // offline: keep only the recent past
      this.lastSend = now;
    } else if (!this.buffer.length && now - this.lastSend > 2000) { this.msg("hb"); this.lastSend = now; }
  }
}

// ---------- Simulation ----------
/** Deterministic PRNG so simulations and tests are reproducible. */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) ^ Math.imul(s ^ (s >>> 13), 3266489917)), (s >>> 0) / 4294967296);
}
const gauss = (random) => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());

/**
 * A synthetic singer producing what the phone's pitch tracker would report at 10 Hz.
 * Roles: good, octave (sings in another octave and suffers detector octave slips), sharp, flat, lost (random notes),
 * noisy (room noise: dropouts, low confidence, spurious pitches), breathy (pauses), muted, denied.
 * @returns {(t:number, target:number|null) => {midi:number, voiced:boolean, confidence:number, db:number}}
 */
export function singer({ role = "good", random = rng(1), low = random() < 0.5 } = {}) {
  const centre = low ? 50 : 62, bias = { sharp: 55, flat: -60 }[role] ?? gauss(random) * 12, rate = 4.5 + random() * 1.5;
  const tau = 120 + random() * 250, react = 200 + random() * 500, depth = 0.08 + random() * 0.15, phase = random() * 6.28;
  let pitch = centre + gauss(random) * 3, goal = pitch, target = null, changedAt = 0, last = 0, breath = 4000 + random() * 4000;
  const silent = (db = -70 + random() * 8) => ({ midi: 0, voiced: false, confidence: random() * 0.4, db });
  return (t, next) => {
    const dt = last ? t - last : 100;
    last = t;
    if (role === "muted" || role === "denied") return silent(-100);
    if (next !== target) { target = next; changedAt = t; }
    if (target === null) return silent();
    if (role === "breathy" && (t % breath) < 900) return silent();
    if (t - changedAt > react) {
      const octave = role === "octave" ? (low ? -12 : 12) : 0;
      goal = role === "lost" ? centre + Math.round(gauss(random) * 4) : fold(target, centre).folded + octave + bias / 100;
    }
    pitch += (goal - pitch) * (1 - Math.exp(-dt / tau));
    let midi = pitch + depth * Math.sin(phase + (t / 1000) * rate * 2 * Math.PI) + gauss(random) * 0.05;
    let confidence = clamp(0.9 + gauss(random) * 0.04, 0, 1);
    if (role === "octave" && random() < 0.08) midi += random() < 0.5 ? 12 : -12;
    if (role === "noisy") {
      if (random() < 0.3) return silent(-48);
      confidence = 0.45 + random() * 0.4;
      if (random() < 0.15) midi = 45 + random() * 30;
    }
    return { midi, voiced: true, confidence, db: -30 + gauss(random) * 3 };
  };
}

/** Ids that simulatedCrowd generates, so the presenter can remove virtual phones even after a reload. */
export const VIRTUAL_ID = /^vc\d+x\d{4}$/;

/**
 * Plans for a rehearsal crowd. With chaos: 6% octave, 4% sharp, 4% flat, 3% lost, 6% noisy, 5% breathy, 3% muted,
 * 2% mic denied, 5% leave, 5% drop and return, 10% join late; the rest sing well.
 */
export function simulatedCrowd(n, { seed = 1, chaos = true, lateAt = 6000 } = {}) {
  const random = rng(seed);
  const roles = [["octave", 6], ["sharp", 4], ["flat", 4], ["lost", 3], ["noisy", 6], ["breathy", 5], ["muted", 3], ["denied", 2], ["leaver", 5], ["rejoin", 5], ["late", 10]];
  return Array.from({ length: n }, (_, i) => {
    let r = chaos ? random() * 100 : 100, role = "good";
    for (const [name, pct] of roles) { if (r < pct) { role = name; break; } r -= pct; }
    return { role, id: `vc${seed}x${String(i).padStart(4, "0")}`, seed: seed * 1000 + i, consent: i % 3 === 0,
      joinAt: (role === "late" ? lateAt : 0) + random() * Math.min(3000, 200 + n * 8),
      dropAt: role === "leaver" ? 4000 : role === "rejoin" ? 3000 : null, returnAfter: role === "rejoin" ? 3000 : null };
  });
}

/**
 * Runs a crowd of virtual phones on the real ChoirSession protocol over any bus, from one shared 10 Hz driver.
 * `now` lets tests run faster than real time (presenter and phones must share it).
 */
export function virtualChoir({ bus, room, verify, crowd, now = () => Date.now(), tickMs = 100 }) {
  const t = topics(room), timers = [];
  const people = crowd.map((plan) => {
    const role = ["leaver", "rejoin", "late"].includes(plan.role) ? "good" : plan.role;
    const voice = singer({ role, random: rng(plan.seed) });
    let chain = Promise.resolve();
    const client = bus.client({
      onMessage: (_topic, envelope) => { chain = chain.then(() => verify(envelope)).then((data) => data && session.receive(data)); },
      onLive: () => session.hello(),
    });
    const session = new ChoirSession({ id: plan.id, send: (data) => client.publish(t.up, data), now });
    Object.assign(session, { consent: plan.consent, st: role === "muted" ? "muted" : role === "denied" ? "denied" : "ok" });
    const person = { plan, session, client, voice, joined: false };
    timers.push(setTimeout(() => {
      client.subscribe(t.all); client.subscribe(t.client(plan.id)); client.connect(); person.joined = true;
      if (plan.dropAt !== null) timers.push(setTimeout(() => {
        client.drop();
        if (plan.returnAfter !== null) timers.push(setTimeout(() => client.connect(), plan.returnAfter));
      }, plan.dropAt));
    }, plan.joinAt));
    return person;
  });
  const driver = setInterval(() => {
    for (const p of people) {
      if (!p.joined || !p.client.live) continue;
      const s = p.session;
      // In songs singers see the next note coming on their lane, so they aim ~300 ms ahead and arrive near the onset.
      const t = s.clock(), target = s.phase !== "sing" ? null : s.target(s.cfg.mode === "song" ? t + 300 : t);
      if (s.ready && s.st !== "denied") s.push(p.voice(t, target), t);
      s.flush();
    }
  }, tickMs);
  return { people, stop: () => { timers.forEach(clearTimeout); clearInterval(driver); people.forEach((p) => p.client.close()); } };
}
