// @ts-check
// Human Pixels core: text layout, stroke font, roster/assignment, wire protocol, presenter signing,
// legibility scoring, exports and virtual participants. No DOM access: shared by the page and Node tests.

export const PARAGRAPH = "AI IS A TEAM SPORT. WORK WITH EACH OTHER. ASK GREAT QUESTIONS. STAY CURIOUS. SHARE WHAT YOU LEARN. TRY NEW IDEAS AND TEST THEM. CHECK THE FACTS. KEEP PEOPLE IN THE LOOP. BE KIND WHEN THINGS GO WRONG. FIX IT AND MOVE ON. HELP A FRIEND WHO IS STUCK. LISTEN MORE THAN YOU TALK. EVERY SMALL PART ADDS UP. EACH LETTER IS ONE PIXEL. ALL OF US MAKE THE BIG PICTURE. NOW WE WRITE THE FUTURE TOGETHER.";
/** Cell height / width. Phones and the presenter grid share this aspect so normalized ink maps 1:1. */
export const CELL_ASPECT = 4 / 3;
/** Ink points on the wire: [x, y, r, t, start] (+ [beta, gamma] with research consent). x, y, r in 1/1000 of cell width/height/width; t in ms. */
export const SCALE = 1000;
const MAX_POINTS = 5000;
/** fitScore at or above this reads as the intended letter (tuned on simulated tracing vs scribbles). */
export const LEGIBLE = 0.55;
const isLetter = (ch) => ch >= "A" && ch <= "Z";
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const int = (v, lo, hi) => (Number.isFinite(v) ? Math.round(clamp(v, lo, hi)) : lo);

// Single-stroke font on a 10×10 box; letters span x 2–8, cap height y 1.5–8.5. The same skeleton is the
// phone's tracing guide, the presenter's "letter" fallback, the legibility reference and the simulator's path.
// M x y = move, L x y = line, A cx cy rx ry fromDeg toDeg = elliptical arc (y down, 0° = right, 90° = down).
const FONT = {
  A: ["M2 8.5 L5 1.5 L8 8.5", "M3.1 6 L6.9 6"],
  B: ["M2.5 8.5 L2.5 1.5 L5.4 1.5 A5.4 3.25 1.75 1.75 -90 90 L2.5 5 L5.8 5 A5.8 6.75 1.75 1.75 -90 90 L2.5 8.5"],
  C: ["A5.2 5 3 3.5 -40 -320"],
  D: ["M2.5 1.5 L2.5 8.5 L4 8.5 A4 5 3.5 3.5 90 -90 L2.5 1.5"],
  E: ["M7.5 1.5 L2.5 1.5 L2.5 8.5 L7.5 8.5", "M2.5 5 L6.5 5"],
  F: ["M7.5 1.5 L2.5 1.5 L2.5 8.5", "M2.5 5 L6.5 5"],
  G: ["A5.2 5 3 3.5 -40 -360 L5.5 5"],
  H: ["M2.5 1.5 L2.5 8.5", "M7.5 1.5 L7.5 8.5", "M2.5 5 L7.5 5"],
  I: ["M5 1.5 L5 8.5", "M3.5 1.5 L6.5 1.5", "M3.5 8.5 L6.5 8.5"],
  J: ["M7 1.5 L7 6.5 A5 6.5 2 2 0 180"],
  K: ["M2.5 1.5 L2.5 8.5", "M7.5 1.5 L2.5 5.5", "M4.2 4.3 L7.5 8.5"],
  L: ["M2.5 1.5 L2.5 8.5 L7.5 8.5"],
  M: ["M2 8.5 L2 1.5 L5 6 L8 1.5 L8 8.5"],
  N: ["M2.5 8.5 L2.5 1.5 L7.5 8.5 L7.5 1.5"],
  O: ["A5 5 3 3.5 -90 270"],
  P: ["M2.5 8.5 L2.5 1.5 L5.5 1.5 A5.5 3.4 1.9 1.9 -90 90 L2.5 5.3"],
  Q: ["A5 5 3 3.5 -90 270", "M5.5 6.5 L8 9"],
  R: ["M2.5 8.5 L2.5 1.5 L5.5 1.5 A5.5 3.4 1.9 1.9 -90 90 L2.5 5.3", "M5 5.3 L7.5 8.5"],
  S: ["A5 3.25 2.6 1.75 -30 -270 A5 6.75 2.6 1.75 -90 150"],
  T: ["M2 1.5 L8 1.5", "M5 1.5 L5 8.5"],
  U: ["M2.5 1.5 L2.5 6 A5 6 2.5 2.5 180 0 L7.5 1.5"],
  V: ["M2 1.5 L5 8.5 L8 1.5"],
  W: ["M1.5 1.5 L3.2 8.5 L5 3.5 L6.8 8.5 L8.5 1.5"],
  X: ["M2.5 1.5 L7.5 8.5", "M7.5 1.5 L2.5 8.5"],
  Y: ["M2.5 1.5 L5 5 L7.5 1.5", "M5 5 L5 8.5"],
  Z: ["M2.5 1.5 L7.5 1.5 L2.5 8.5 L7.5 8.5"],
  ".": ["M5 8.1 L5 8.5"],
  ",": ["M5.3 7.8 L4.6 9.4"],
  "'": ["M5 1.5 L5 3"],
  "!": ["M5 1.5 L5 6", "M5 8.1 L5 8.5"],
  "?": ["A5 3.3 2.3 1.8 -160 90 L5 6", "M5 8.1 L5 8.5"],
};
const glyphCache = new Map();

/** @returns {number[][][]} polylines of [x, y] in [0, 1] of the cell */
export function glyph(ch) {
  if (glyphCache.has(ch)) return glyphCache.get(ch);
  const lines = (FONT[ch] ?? []).map((path) => {
    const tokens = path.trim().split(/\s+/), points = [];
    for (let i = 0; i < tokens.length; ) {
      const cmd = tokens[i][0], nums = [tokens[i].slice(1), ...tokens.slice(i + 1)].map(Number);
      if (cmd === "A") {
        const [cx, cy, rx, ry, a0, a1] = nums;
        const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 10));
        for (let s = 0; s <= steps; s++) {
          const a = ((a0 + ((a1 - a0) * s) / steps) * Math.PI) / 180;
          points.push([(cx + rx * Math.cos(a)) / 10, (cy + ry * Math.sin(a)) / 10]);
        }
        i += 6;
      } else {
        points.push([nums[0] / 10, nums[1] / 10]);
        i += 2;
      }
    }
    return points;
  });
  glyphCache.set(ch, lines);
  return lines;
}

/** Splits text into characters; only A–Z become participant slots. Spaces and punctuation are automatic. */
export function parseText(text = PARAGRAPH) {
  const chars = [...text.toUpperCase()];
  const slots = [], slotOf = chars.map((ch, i) => (isLetter(ch) ? slots.push(i) - 1 : -1));
  const sentenceEnd = [];
  let end = chars.length - 1;
  for (let i = chars.length - 1; i >= 0; i--) {
    if (/[.!?]/.test(chars[i])) end = i;
    sentenceEnd[i] = end;
  }
  const wordOf = (i) => {
    let a = i, b = i;
    while (a > 0 && isLetter(chars[a - 1])) a--;
    while (b < chars.length - 1 && isLetter(chars[b + 1])) b++;
    return { word: chars.slice(a, b + 1).join(""), pos: i - a };
  };
  return { text: chars.join(""), chars, slots, slotOf, sentenceEnd, wordOf };
}

/** Wraps characters [0, count) into rows of at most `cols`, never splitting words. Returns rows of char indices. */
export function wrap(chars, cols, count = chars.length) {
  const rows = [];
  let row = [], word = [];
  const place = () => {
    if (!word.length) return;
    if (row.length && row.length + 1 + word.length > cols) { rows.push(row); row = []; }
    if (row.length) row.push(-1);
    row.push(...word); word = [];
  };
  for (let i = 0; i < count; i++) {
    if (chars[i] === " ") place();
    else word.push(i);
  }
  place();
  if (row.length) rows.push(row);
  return rows;
}

/** Picks the column count that maximizes cell size in a width × height box. */
export function fitGrid(chars, count, width, height, lineGap = 0.18) {
  let best = null;
  const longest = Math.max(...chars.slice(0, count).join("").split(" ").map((w) => w.length));
  for (let cols = Math.max(longest, 4); cols <= 80; cols++) {
    const rows = wrap(chars, cols, count);
    const size = Math.min(width / cols, height / (rows.length * (CELL_ASPECT + lineGap)));
    if (!best || size > best.size + 1e-9) best = { cols, rows, size };
  }
  return best;
}

export const topics = (room) => {
  const base = `human-pixels/v1/${room}`;
  return { up: `${base}/up`, all: `${base}/all`, client: (id) => `${base}/c/${id}` };
};

// ---------- Presenter authenticity ----------
// The room code is a hash of the presenter's public key. Participants accept control messages only when
// signed by a key that hashes to the room code, so the audience URL carries no secret.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const ECDSA = { name: "ECDSA", namedCurve: "P-256" }, SIGN = { name: "ECDSA", hash: "SHA-256" };

export async function roomFromKey(publicKey) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", unb64(publicKey)));
  return [...hash.slice(0, 8)].map((b) => ALPHABET[b & 31]).join("");
}

/** Creates (or restores from a JWK) the presenter key. Returns the signer and room code. */
export async function presenterKey(jwk = null) {
  let privateKey, publicKey;
  if (jwk) {
    privateKey = await crypto.subtle.importKey("jwk", jwk, ECDSA, true, ["sign"]);
    const { d: _d, ...pub } = jwk;
    publicKey = await crypto.subtle.importKey("jwk", { ...pub, key_ops: ["verify"] }, ECDSA, true, ["verify"]);
  } else ({ privateKey, publicKey } = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]));
  const k = b64(await crypto.subtle.exportKey("raw", publicKey));
  const room = await roomFromKey(k);
  const sign = async (data) => {
    const d = JSON.stringify({ v: 1, at: Date.now(), ...data });
    return { d, k, s: b64(await crypto.subtle.sign(SIGN, privateKey, new TextEncoder().encode(d))) };
  };
  return { room, sign, jwk: await crypto.subtle.exportKey("jwk", privateKey) };
}

/** Returns an async verifier for envelopes on this room. Resolves to the payload, or null if forged. */
export function verifier(room) {
  let trusted = null;
  return async (envelope) => {
    if (typeof envelope?.d !== "string" || typeof envelope.k !== "string" || typeof envelope.s !== "string") return null;
    try {
      if (trusted?.k !== envelope.k) {
        if ((await roomFromKey(envelope.k)) !== room) return null;
        trusted = { k: envelope.k, key: await crypto.subtle.importKey("raw", unb64(envelope.k), ECDSA, false, ["verify"]) };
      }
      if (!(await crypto.subtle.verify(SIGN, trusted.key, unb64(envelope.s), new TextEncoder().encode(envelope.d)))) return null;
      const data = JSON.parse(envelope.d);
      // Reject stale replays; allow for phone clock skew.
      return Math.abs(Date.now() - data.at) < 10 * 60e3 ? data : null;
    } catch {
      return null;
    }
  };
}

// ---------- Legibility ----------
function samples(polylines, step = 0.12) {
  const out = [];
  for (const line of polylines) {
    out.push([line[0][0] * 3, line[0][1] * 4]);
    for (let i = 1; i < line.length; i++) {
      const [x0, y0] = [line[i - 1][0] * 3, line[i - 1][1] * 4], [x1, y1] = [line[i][0] * 3, line[i][1] * 4];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let s = 1; s <= n; s++) out.push([x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n]);
    }
  }
  return out;
}

/** Splits wire points into polylines of [x, y] in [0, 1]. */
export function strokesOf(pts) {
  const lines = [];
  for (const p of pts) {
    if (p[4] || !lines.length) lines.push([]);
    lines.at(-1).push([p[0] / SCALE, p[1] / SCALE, p[2] / SCALE, p[3]]);
  }
  return lines;
}

/**
 * Rough legibility: the lower of guide coverage (recall) and ink staying on the guide (precision), within ~10% of
 * cell width. A hint for the presenter, not OCR. 0 = empty or off-target, ~0.8+ = careful tracing.
 */
export function fitScore(letter, pts) {
  if (pts.length < 4) return 0;
  const guide = samples(glyph(letter)), ink = samples(strokesOf(pts));
  const tol2 = 0.3 ** 2;
  const near = (a, set) => set.some((b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 < tol2);
  const recall = guide.filter((g) => near(g, ink)).length / guide.length;
  const precision = ink.filter((p) => near(p, guide)).length / ink.length;
  return Math.min(recall, precision);
}

// ---------- Presenter roster ----------
const ID = /^[a-z0-9]{6,32}$/i;

/**
 * Authoritative room state on the presenter. `send(to, data)` delivers to "all" or a client id (the caller signs).
 * Slot lifecycle: empty → live → away (silent > awayMs) → gone (silent > goneMs, reassignable unless done/legible).
 */
export class PresenterRoom {
  constructor({ text = PARAGRAPH, send = (_to, _data) => {}, now = () => Date.now(), awayMs = 12000, goneMs = 30000 } = {}) {
    Object.assign(this, { send, now, awayMs, goneMs });
    this.parsed = parseText(text);
    this.slots = this.parsed.slots.map((charIndex, slot) => this.blank({ slot, charIndex, letter: this.parsed.chars[charIndex], view: "ink" }));
    /** @type {Map<string, number>} */ this.clients = new Map();
    /** @type {Set<string>} */ this.waiting = new Set();
    this.needAt = new Map();
    this.phase = "lobby"; this.round = 1; this.version = 0; this.joins = 0; this.messages = 0;
  }

  blank(slot) {
    return Object.assign(slot, { cid: null, seen: 0, epoch: -1, pts: [], done: false, fit: null, fitN: -1, cursor: null, mode: null, trace: false, platform: null, history: slot.history ?? 0 });
  }

  status(slot, now = this.now()) {
    if (!slot.cid) return "empty";
    const silent = now - slot.seen;
    return silent < this.awayMs ? "live" : silent < this.goneMs ? "away" : "gone";
  }

  /** Index one past the last letter anyone holds or held. */
  get reach() {
    for (let i = this.slots.length - 1; i >= 0; i--) if (this.slots[i].cid || this.slots[i].pts.length) return i + 1;
    return 0;
  }

  counts(now = this.now()) {
    const counts = { live: 0, away: 0, gone: 0, empty: 0, done: 0, waiting: this.waiting.size };
    for (const slot of this.slots) {
      counts[this.status(slot, now)]++;
      if (slot.done) counts.done++;
    }
    return counts;
  }

  /** @param {any} msg a participant message from the up topic */
  handle(msg) {
    if (!msg || msg.v !== 1 || typeof msg.id !== "string" || !ID.test(msg.id)) return;
    this.messages++;
    const { id } = msg, now = this.now();
    if (msg.t === "hello") return this.join(id, msg);
    if (!["ink", "hb", "done", "bye"].includes(msg.t)) return;
    const index = this.clients.get(id), slot = this.slots[index];
    if (!slot || slot.cid !== id) {
      // Unknown or displaced client (e.g. presenter reloaded, or letter reassigned): treat as a join.
      if (msg.t !== "bye") this.join(id, msg);
      return;
    }
    if (msg.t === "bye") { slot.seen = Math.min(slot.seen, now - this.awayMs); this.version++; return; }
    slot.seen = now;
    if (Array.isArray(msg.c)) slot.cursor = [int(msg.c[0], 0, SCALE), int(msg.c[1], 0, SCALE), msg.c[2] ? 1 : 0, now];
    if (msg.m === "tilt" || msg.m === "touch") slot.mode = msg.m;
    if (msg.t === "done") { slot.done = !!msg.done; this.version++; return; }
    if (msg.t === "hb") {
      const behind = msg.e > slot.epoch || (msg.e === slot.epoch && msg.n > slot.pts.length);
      if (behind) this.need(id, msg.e === slot.epoch ? slot.pts.length : 0);
      return;
    }
    // ink
    if (!Number.isInteger(msg.e) || !Number.isInteger(msg.k) || !Array.isArray(msg.p) || msg.e < slot.epoch) return;
    if (msg.e > slot.epoch) { slot.epoch = msg.e; slot.pts = []; slot.fitN = -1; this.version++; }
    const have = slot.pts.length;
    if (msg.k > have) return this.need(id, have);
    for (const p of msg.p.slice(have - msg.k)) {
      if (slot.pts.length >= MAX_POINTS || !Array.isArray(p)) break;
      const point = [int(p[0], 0, SCALE), int(p[1], 0, SCALE), int(p[2], 1, 120), int(p[3], 0, 36e5), p[4] ? 1 : 0];
      if (slot.trace && p.length >= 7) point.push(Math.round(clamp(+p[5] || 0, -180, 180) * 10) / 10, Math.round(clamp(+p[6] || 0, -180, 180) * 10) / 10);
      slot.pts.push(point);
    }
    if (slot.pts.length !== have) this.version++;
  }

  need(id, from) {
    const now = this.now();
    if (now - (this.needAt.get(id) ?? 0) < 700) return;
    this.needAt.set(id, now);
    this.send(id, { t: "need", to: id, from, round: this.round });
  }

  join(id, msg) {
    const now = this.now();
    let index = this.clients.get(id);
    if (index === undefined || this.slots[index].cid !== id) {
      index = undefined;
      // Presenter lost its state (reload without storage): let the client reclaim an untouched slot.
      const claim = this.slots[msg.slot];
      if (Number.isInteger(msg.slot) && claim && !claim.cid && msg.round === this.round) index = msg.slot;
      index ??= this.slots.findIndex((s) => this.reassignable(s, now));
      if (index < 0) index = this.slots.findIndex((s) => !s.cid);
      if (index < 0) {
        this.waiting.add(id);
        this.send(id, { t: "assign", to: id, slot: null, round: this.round, phase: this.phase, total: this.slots.length });
        return;
      }
      const slot = this.slots[index];
      if (slot.cid) { this.clients.delete(slot.cid); slot.history++; }
      this.blank(slot);
      slot.cid = id; slot.view = "ink";
      this.clients.set(id, index);
      this.waiting.delete(id);
      this.joins++;
    }
    const slot = this.slots[index];
    slot.seen = now;
    if (msg.m === "touch" || msg.m === "tilt") slot.mode = msg.m;
    if (msg.t === "hello") {
      slot.trace = msg.trace === true;
      slot.platform = ["ios", "android", "other"].includes(msg.os) ? msg.os : "other";
    }
    this.version++;
    this.assign(id, index);
  }

  assign(id, index) {
    const slot = this.slots[index], { word, pos } = this.parsed.wordOf(slot.charIndex);
    this.send(id, { t: "assign", to: id, slot: index, letter: slot.letter, word, pos, total: this.slots.length, epoch: slot.epoch, have: slot.pts.length, round: this.round, phase: this.phase });
  }

  /**
   * Frees every letter held by clients matching `drop` (e.g. virtual phones) and erases their ink. Participants who have
   * not inked yet move down into the freed letters, so "grow with crowd" shrinks back to the real crowd.
   * People with ink keep their letter. Returns the number of letters freed.
   * @param {(id:string)=>boolean} drop
   */
  release(drop) {
    let freed = 0;
    for (const id of [...this.waiting]) if (drop(id)) this.waiting.delete(id);
    for (const slot of this.slots) if (slot.cid && drop(slot.cid)) {
      this.clients.delete(slot.cid);
      Object.assign(this.blank(slot), { history: 0, view: "ink" });
      freed++;
    }
    for (const slot of this.slots) {
      if (!slot.cid || slot.pts.length || slot.done) continue;
      const free = this.slots.findIndex((s) => !s.cid && !s.pts.length);
      if (free < 0 || free > slot.slot) continue;
      const { cid, mode, trace, platform, seen } = slot;
      this.blank(slot);
      Object.assign(this.slots[free], { cid, mode, trace, platform, seen, view: "ink" });
      this.clients.set(cid, free);
      this.assign(cid, free);
    }
    this.version++;
    return freed;
  }

  /** A dropped participant's letter goes to the next joiner, unless it already looks finished. */
  reassignable(slot, now) {
    if (this.status(slot, now) !== "gone" || slot.done) return false;
    return this.fit(slot) < LEGIBLE;
  }

  fit(slot) {
    if (slot.fitN !== slot.pts.length) { slot.fit = fitScore(slot.letter, slot.pts); slot.fitN = slot.pts.length; }
    return slot.fit;
  }

  /** Periodic housekeeping: offers newly reassignable letters to waiting clients and broadcasts state. */
  tick() {
    const now = this.now();
    if (this.waiting.size && this.slots.some((s) => !s.cid || this.reassignable(s, now))) for (const id of [...this.waiting]) this.join(id, {});
    this.broadcast();
  }

  broadcast() {
    const c = this.counts();
    this.send("all", { t: "state", phase: this.phase, round: this.round, live: c.live, total: this.slots.length });
  }

  setPhase(phase) { this.phase = phase; this.version++; this.broadcast(); }

  /** Clears all ink but keeps assignments. Phones clear on the new round number. */
  resetInk() {
    this.round++;
    for (const slot of this.slots) Object.assign(slot, { epoch: -1, pts: [], done: false, fit: null, fitN: -1, view: "ink" });
    this.version++; this.broadcast();
  }

  toggleView(index, view) {
    const slot = this.slots[index];
    slot.view = view ?? (slot.view === "ink" ? "letter" : "ink");
    this.version++;
  }

  /** Shows the guide letter for every slot that is empty or below the legibility threshold. */
  autoFix(threshold = LEGIBLE, upTo = this.slots.length) {
    let changed = 0;
    for (const slot of this.slots.slice(0, upTo)) {
      const view = this.fit(slot) < threshold ? "letter" : "ink";
      if (slot.view !== view) { slot.view = view; changed++; }
    }
    this.version++;
    return changed;
  }

  serialize() {
    return JSON.stringify({ v: 1, phase: this.phase, round: this.round, joins: this.joins, clients: [...this.clients], slots: this.slots.map(({ slot, cid, epoch, pts, done, view, mode, trace, platform, history, seen }) => ({ slot, cid, epoch, pts, done, view, mode, trace, platform, history, seen })) });
  }

  restore(json) {
    const data = JSON.parse(json);
    if (data.v !== 1 || data.slots.length !== this.slots.length) return false;
    Object.assign(this, { phase: data.phase, round: data.round, joins: data.joins, clients: new Map(data.clients) });
    data.slots.forEach((s, i) => Object.assign(this.slots[i], s, { fitN: -1 }));
    this.version++;
    return true;
  }

  /** Anonymous research export: only participants who opted in, no client ids. */
  toJSONL(session = Math.random().toString(36).slice(2, 10)) {
    return this.slots
      .filter((s) => s.trace && s.pts.length)
      .map((s) => JSON.stringify({ schema: "human-pixels/trace-v1", session, sample: `${session}-${s.slot}-${s.history}`, letter: s.letter, round: this.round, aspect: CELL_ASPECT, input: s.mode, platform: s.platform, fields: ["x", "y", "r", "t_ms", "pen_down", "beta_rel", "gamma_rel"], units: "x,y,r per 1000 of cell width/height/width; tilt in degrees relative to the participant's recentre pose", points: s.pts }))
      .join("\n");
  }
}

// ---------- Participant protocol ----------
/**
 * Participant-side protocol state. `send(data)` publishes to the up topic and returns false when offline.
 * Ink is an append-only point list per epoch; undo/clear starts a new epoch and resends.
 */
export class ParticipantSession {
  constructor({ id, send, onChange = () => {}, now = () => performance.now() }) {
    Object.assign(this, { id, send, onChange, now });
    this.slot = null; this.letter = null; this.word = ""; this.pos = 0; this.total = 0;
    this.phase = "lobby"; this.round = 0; this.waiting = false;
    this.pts = []; this.epoch = 0; this.sent = 0; this.t0 = null; this.cursor = [500, 500, 0];
    // ready: the presenter confirmed our slot in this page session (restored ink waits for it).
    this.ready = false; this.lastCursor = ""; this.lastSend = 0; this.done = false; this.mode = "tilt"; this.trace = false; this.os = "other";
  }

  // slot and round ride on every message so a presenter that lost its state can hand the same letter back.
  msg(t, data = {}) { return this.send({ v: 1, t, id: this.id, slot: this.slot ?? undefined, round: this.round, ...data }); }
  hello() { return this.msg("hello", { e: this.epoch, n: this.pts.length, m: this.mode, trace: this.trace, os: this.os }); }

  /** @param {any} data a verified presenter message */
  receive(data) {
    if (data.to && data.to !== this.id) return;
    if (data.t === "hi") { this.hello(); return; }
    if (data.round && data.round !== this.round) {
      // A reset (new round) clears ink everywhere; keep the letter.
      if (this.round) { this.newEpoch([]); this.done = false; }
      this.round = data.round;
    }
    if (data.phase) this.phase = data.phase;
    if (data.t === "assign") {
      this.waiting = data.slot === null; this.ready = !this.waiting;
      if (data.slot !== this.slot) { this.newEpoch([]); this.done = false; }
      Object.assign(this, { slot: data.slot, letter: data.letter ?? null, word: data.word ?? "", pos: data.pos ?? 0, total: data.total });
      // Resume from what the presenter already has of this epoch.
      this.sent = data.epoch === this.epoch ? Math.min(data.have, this.pts.length) : 0;
      this.flush(true);
    }
    if (data.t === "need") { this.sent = Math.min(data.from, this.pts.length); this.flush(true); }
    this.onChange(data.t);
  }

  newEpoch(pts) { this.epoch++; this.pts = pts; this.sent = 0; if (!pts.length) this.t0 = null; }

  canDraw() { return this.ready && this.slot !== null && this.phase === "draw"; }

  /** @param {{x:number,y:number,r:number}} p normalized pen point @param {boolean} start @param {{beta:number,gamma:number}} [tilt] */
  add(p, start, tilt) {
    if (this.pts.length >= MAX_POINTS) return;
    const now = this.now();
    this.t0 ??= now;
    const point = [Math.round(p.x * SCALE), Math.round(p.y * SCALE), Math.max(1, Math.round(p.r * SCALE)), Math.round(now - this.t0), start ? 1 : 0];
    if (this.trace && tilt) point.push(Math.round(tilt.beta * 10) / 10 || 0, Math.round(tilt.gamma * 10) / 10 || 0);
    this.pts.push(point);
    if (this.done) this.markDone(false);
  }

  undo() {
    let i = this.pts.length - 1;
    while (i > 0 && !this.pts[i][4]) i--;
    this.newEpoch(this.pts.slice(0, Math.max(0, i)));
    this.flush(true);
  }

  clear() { this.newEpoch([]); this.flush(true); }

  markDone(done = true) { this.done = done; this.msg("done", { done }); }

  setCursor(x, y, down) { this.cursor = [Math.round(x * SCALE), Math.round(y * SCALE), down ? 1 : 0]; }

  /** Call at 5–10 Hz. Sends new points (chunked) and cursor changes; heartbeats every 3 s when idle. */
  flush(force = false) {
    const now = this.now(), cursor = this.cursor.join();
    if (this.slot === null || !this.ready) {
      // Hello or its reply may be lost on QoS 0; keep asking (slowly while on the waiting list).
      if (now - this.lastSend > (this.waiting ? 10000 : 2000)) { this.lastSend = now; this.hello(); }
      return;
    }
    // A forced empty send (sent === 0) tells the presenter about a cleared epoch.
    if (this.pts.length > this.sent || (force && this.sent === 0)) {
      const p = this.pts.slice(this.sent, this.sent + 150);
      if (this.msg("ink", { e: this.epoch, k: this.sent, p, c: this.cursor, m: this.mode })) this.sent += p.length;
      this.lastSend = now; this.lastCursor = cursor;
    } else if (cursor !== this.lastCursor || now - this.lastSend > 3000) {
      this.msg("hb", { e: this.epoch, n: this.pts.length, c: this.cursor, m: this.mode });
      this.lastSend = now; this.lastCursor = cursor;
    }
  }
}

// ---------- Simulation ----------
/** Deterministic PRNG so simulations and tests are reproducible. */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) ^ Math.imul(s ^ (s >>> 13), 3266489917)), (s >>> 0) / 4294967296);
}

/**
 * Pen points a simulated participant would produce for a letter, as [{x, y, r}, start, dtMs].
 * quality: "good" (careful tracing with tilt lag), "shaky", "scribble" (unreadable) or "tiny" (unreadable).
 */
export function simulateDrawing(letter, quality = "good", random = rng(7)) {
  const out = [];
  const noise = { good: 0.012, shaky: 0.035, scribble: 0, tiny: 0.01 }[quality];
  if (quality === "scribble") {
    // A tangle of loops in one spot: what a lost or rushed participant tends to leave behind.
    const cx = 0.25 + random() * 0.5, cy = 0.25 + random() * 0.5;
    for (let i = 0; i < 90; i++) {
      const a = i * 0.7, rad = 0.06 + random() * 0.1;
      out.push([{ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad * 0.8, r: 0.02 }, i === 0, 40]);
    }
    return out;
  }
  const scale = quality === "tiny" ? 0.25 : 1, ox = quality === "tiny" ? 0.05 : 0, oy = quality === "tiny" ? 0.7 : 0;
  for (const line of glyph(letter)) {
    let first = true, wobble = [0, 0];
    for (let i = 0; i < line.length; i++) {
      const [x1, y1] = line[i], [x0, y0] = line[Math.max(0, i - 1)];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, (y1 - y0) * CELL_ASPECT) / 0.025));
      for (let s = i ? 1 : 0; s <= n; s++) {
        // Correlated noise imitates hand tremor through a smoothed tilt cursor.
        wobble = [wobble[0] * 0.8 + (random() - 0.5) * noise, wobble[1] * 0.8 + (random() - 0.5) * noise];
        const x = ox + (x0 + ((x1 - x0) * s) / n) * scale + wobble[0], y = oy + (y0 + ((y1 - y0) * s) / n) * scale + wobble[1];
        out.push([{ x: clamp(x, 0, 1), y: clamp(y, 0, 1), r: 0.018 + random() * 0.012 }, first, 45 + random() * 30]);
        first = false;
      }
    }
  }
  return out;
}

/**
 * A virtual participant driving a real ParticipantSession over any transport, for 3–300 person rehearsals.
 * @param {{bus:any, room:string, id:string, verify:(e:any)=>Promise<any>, quality?:string, mode?:string, speed?:number, trace?:boolean,
 *   joinAt?:number, dropAt?:number|null, returnAfter?:number|null, random?:()=>number}} options
 * dropAt: ms after joining when the network drops; returnAfter: ms until reconnecting (null = never returns).
 */
export function virtualParticipant({ bus, room, id, verify, quality = "good", mode = "tilt", speed = 1, trace = false, joinAt = 0, dropAt = null, returnAfter = null, random = rng(1) }) {
  const t = topics(room);
  const client = bus.client({
    onMessage: (_topic, envelope) => { chain = chain.then(() => verify(envelope)).then((data) => data && session.receive(data)); },
    onLive: () => session.hello(),
  });
  let chain = Promise.resolve();
  const session = new ParticipantSession({ id, send: (data) => client.publish(t.up, data), now: () => performance.now() * speed });
  Object.assign(session, { mode, trace });
  const plan = simulateDrawing("A", quality, random);
  const timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms / speed));
  let step = 0, planned = null, finished = false;
  const draw = () => {
    if (!client.live) return later(400, draw);
    if (session.canDraw()) {
      if (planned !== session.letter) { planned = session.letter; step = 0; plan.splice(0, plan.length, ...simulateDrawing(session.letter, quality, random)); }
      if (step < plan.length) {
        const [p, start, dt] = plan[step++];
        session.add(p, start, { beta: (p.y - 0.5) * 60, gamma: (p.x - 0.5) * 55 });
        session.setCursor(p.x, p.y, true);
        return later(dt, draw);
      }
      if (!finished) { finished = true; session.markDone(); }
    }
    later(500, draw);
  };
  const flusher = setInterval(() => client.live && session.flush(), 180 / speed);
  later(joinAt, () => {
    client.subscribe(t.all); client.subscribe(t.client(id)); client.connect(); draw();
    if (dropAt !== null) later(dropAt, () => {
      client.drop();
      if (returnAfter !== null) later(returnAfter, () => client.connect());
    });
  });
  // Watch the presenter: a reset or reassignment restarts the drawing plan.
  const restart = session.onChange;
  session.onChange = (type) => { restart(type); if (type === "assign" || type === "state") if (!session.pts.length) { step = 0; finished = false; planned = null; } };
  return { session, client, stop: () => { timers.forEach(clearTimeout); clearInterval(flusher); client.close(); } };
}

/**
 * Participant plans for a rehearsal crowd. With chaos: ~8% unreadable, 6% missing sensors (finger, shakier),
 * 6% leave for good, 6% drop and return, 15% join late (after leavers' letters become reassignable).
 * Times are in ms at speed 1; pass the result to virtualParticipant with a bus, room and verifier.
 */
/** Ids that simulatedCrowd generates, so the presenter can remove virtual phones even after a reload. */
export const VIRTUAL_ID = /^sim\d+x\d{4}$/;

export function simulatedCrowd(n, { seed = 1, chaos = true, lateAt = 40000, prefix = "sim" } = {}) {
  const random = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const r = chaos ? random() : 1;
    const role = r < 0.08 ? "scribble" : r < 0.14 ? "touch" : r < 0.2 ? "leaver" : r < 0.26 ? "rejoin" : r < 0.41 ? "late" : "good";
    return {
      role, id: `${prefix}${seed}x${String(i).padStart(4, "0")}`, random: rng(seed * 1000 + i), trace: i % 3 === 0,
      quality: role === "scribble" ? "scribble" : role === "touch" ? "shaky" : "good", mode: role === "touch" ? "touch" : "tilt",
      joinAt: (role === "late" ? lateAt : 0) + random() * Math.min(8000, 300 + n * 25),
      dropAt: role === "leaver" ? 1500 : role === "rejoin" ? 2500 : null, returnAfter: role === "rejoin" ? 4000 : null,
    };
  });
}

// ---------- Layout and artwork ----------
/** Places characters [0, count) in a width × height box. Spaces get no cell. Returns cells with pixel rects. */
export function layoutCells(parsed, count, width, height, pad = 0) {
  const grid = fitGrid(parsed.chars, count, width - 2 * pad, height - 2 * pad);
  const size = grid.size, pitch = size * (CELL_ASPECT + 0.18), inset = size * 0.05;
  const widest = Math.max(...grid.rows.map((r) => r.length));
  const ox = (width - widest * size) / 2, oy = (height - grid.rows.length * pitch + size * 0.18) / 2;
  const cells = [];
  grid.rows.forEach((row, r) => row.forEach((i, c) => {
    if (i < 0) return;
    cells.push({ i, ch: parsed.chars[i], slot: parsed.slotOf[i], row: r, col: c, x: ox + c * size + inset, y: oy + r * pitch, w: size - 2 * inset, h: (size - 2 * inset) * CELL_ASPECT });
  }));
  return { cells, size, rows: grid.rows.length };
}

const n1 = (v) => Math.round(v * 10) / 10;
/** Standalone SVG of the artwork. Cells shown as "letter" (or empty) use the faint stroke-font letter. */
export function artworkSVG(room, { count = room.parsed.chars.length, width = 1920, height = 1080, paper = "#f6f1e4", ink = "#1d1b19", guide = "#2f5d8a", rule = "#d9643a", boxes = true } = {}) {
  const { cells } = layoutCells(room.parsed, count, width, height, width * 0.03);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<title>${room.parsed.text.slice(0, count)}</title>`, `<rect width="100%" height="100%" fill="${paper}"/>`,
    `<g fill="none" stroke-linecap="round" stroke-linejoin="round">`];
  const poly = (lines, cell, color, widthOf, opacity = 1) => lines.filter((l) => l.length).map((l) => {
    const pts = (l.length === 1 ? [l[0], l[0]] : l).map((p) => `${n1(cell.x + p[0] * cell.w)},${n1(cell.y + p[1] * cell.h)}`).join(" ");
    return `<polyline points="${pts}" stroke="${color}" stroke-width="${n1(widthOf(l))}"${opacity < 1 ? ` stroke-opacity="${opacity}"` : ""}/>`;
  }).join("");
  for (const cell of cells) {
    const slot = cell.slot >= 0 ? room.slots[cell.slot] : null;
    const parts = [boxes ? `<rect x="${n1(cell.x)}" y="${n1(cell.y)}" width="${n1(cell.w)}" height="${n1(cell.h)}" stroke="${rule}" stroke-opacity="0.35" stroke-width="${n1(cell.w * 0.012 + 0.5)}"/>` : ""];
    if (!slot) parts.push(poly(glyph(cell.ch), cell, ink, () => cell.w * 0.06));
    else if (slot.view === "letter") parts.push(poly(glyph(slot.letter), cell, guide, () => cell.w * 0.07, 0.55));
    else parts.push(poly(strokesOf(slot.pts), cell, ink, (l) => Math.max(1, (l.reduce((s, p) => s + p[2], 0) / l.length) * 2 * cell.w * 1.8)));
    out.push(`<g data-char="${cell.ch === "'" ? "&#39;" : cell.ch}">${parts.join("")}</g>`);
  }
  out.push("</g></svg>");
  return out.join("\n");
}
