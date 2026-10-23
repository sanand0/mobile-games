// @ts-check
// Tilt pen: the Air Ink interaction (tds-network-games/public/motion/air-ink) as a reusable module.
// Tilt aims a smoothed cursor relative to a recentred pose; holding a button inks; releasing lifts.
// Slow movement leaves thicker ink. A finger-drawing fallback covers missing or denied sensors.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const shortest = (a, b) => ((a - b + 540) % 360) - 180;

/**
 * Requests iOS motion permission. Call synchronously inside a tap: Safari needs BOTH requests to start
 * in the same user gesture, before any await.
 * @returns {Promise<"granted"|"denied"|"unsupported"|"insecure">}
 */
export function requestMotion() {
  if (!globalThis.isSecureContext) return Promise.resolve("insecure");
  if (!globalThis.DeviceOrientationEvent) return Promise.resolve("unsupported");
  const asks = [globalThis.DeviceOrientationEvent, globalThis.DeviceMotionEvent]
    .map((api) => (typeof api?.requestPermission === "function" ? api.requestPermission() : Promise.resolve("granted")));
  return Promise.allSettled(asks).then((results) => (results.every((r) => r.status === "fulfilled" && r.value === "granted") ? "granted" : "denied"));
}

/**
 * Points are normalized: x, y in [0, 1] of the surface; r is the ink radius as a fraction of surface width.
 * @typedef {{x:number, y:number, r:number}} PenPoint
 */
export class TiltPen {
  /**
   * @param {{surface:HTMLElement, hold:HTMLElement, onDown?:(p:PenPoint)=>void, onPoint?:(p:PenPoint)=>void, onUp?:()=>void,
   *   onFrame?:(cursor:{x:number,y:number,down:boolean})=>void, onNoSensor?:()=>void, rangeX?:number, rangeY?:number, canDraw?:()=>boolean}} options
   */
  constructor({ surface, hold, onDown = () => {}, onPoint = () => {}, onUp = () => {}, onFrame = () => {}, onNoSensor = () => {}, rangeX = 29, rangeY = 34, canDraw = () => true }) {
    Object.assign(this, { surface, hold, onDown, onPoint, onUp, onFrame, onNoSensor, rangeX, rangeY, canDraw });
    /** @type {"off"|"tilt"|"touch"} */ this.mode = "off";
    this.cursor = { x: 0.5, y: 0.5 }; this.target = { x: 0.5, y: 0.5 };
    this.down = false; this.pointer = null; this.raw = null; this.origin = null; this.relative = { beta: 0, gamma: 0 };
    this.width = 1; this.height = 1; this.speed = 0; this.stillSince = 0; this.lastTime = 0; this.last = null;
    this.stamps = []; this.events = 0; this.lastEventAt = 0;
    this.orientation = (e) => this.onOrientation(e);
    this.frame = (now) => this.tick(now);
    this.bindInputs();
  }

  /** @param {"tilt"|"touch"} mode */
  start(mode) {
    this.lift();
    this.mode = mode;
    this.hold.hidden = mode !== "tilt";
    removeEventListener("deviceorientation", this.orientation);
    if (mode === "tilt") {
      this.origin = null; // switching back to tilt centres on the current pose
      addEventListener("deviceorientation", this.orientation);
      clearTimeout(this.noSensorTimer);
      // Desktop browsers and some in-app browsers expose the API but never fire events.
      this.noSensorTimer = setTimeout(() => { if (this.mode === "tilt" && !this.events) this.onNoSensor(); }, 2500);
    }
    cancelAnimationFrame(this.raf); this.previous = 0; this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.lift(); this.mode = "off";
    removeEventListener("deviceorientation", this.orientation);
    clearTimeout(this.noSensorTimer); cancelAnimationFrame(this.raf);
  }

  /** Makes the current pose the centre of the canvas. */
  recenter() {
    this.lift();
    if (this.raw) this.origin = { ...this.raw };
    this.cursor = { x: 0.5, y: 0.5 }; this.target = { ...this.cursor };
  }

  /** Sensor health for the diagnostics strip. */
  diagnostics(now = performance.now()) {
    this.stamps = this.stamps.filter((t) => now - t < 2000);
    return { mode: this.mode, hz: this.stamps.length / 2, events: this.events, ageMs: this.lastEventAt ? now - this.lastEventAt : null, ...this.relative };
  }

  onOrientation(e) {
    if (!Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
    const now = performance.now();
    this.events++; this.lastEventAt = now; this.stamps.push(now);
    this.raw = { beta: e.beta, gamma: e.gamma };
    if (!this.origin) this.recenter();
    // Landscape swaps physical tilt axes into screen coordinates.
    const angle = ((screen.orientation?.angle ?? /** @type {any} */ (globalThis).orientation ?? 0) * Math.PI) / 180;
    const gamma = shortest(this.raw.gamma, this.origin.gamma), beta = shortest(this.raw.beta, this.origin.beta);
    this.relative = { beta, gamma };
    const x = gamma * Math.cos(angle) + beta * Math.sin(angle), y = beta * Math.cos(angle) - gamma * Math.sin(angle);
    this.target = { x: clamp(0.5 + (x / this.rangeX) * 0.46, 0.03, 0.97), y: clamp(0.5 + (y / this.rangeY) * 0.46, 0.03, 0.97) };
  }

  tick(now) {
    const rect = this.surface.getBoundingClientRect();
    this.width = rect.width || 1; this.height = rect.height || 1;
    // Exponential smoothing that is frame-rate independent (Air Ink uses 19/s).
    const k = this.mode === "touch" ? 1 : 1 - Math.exp(-Math.min(0.05, (now - (this.previous || now)) / 1000) * 19);
    this.cursor.x += (this.target.x - this.cursor.x) * k; this.cursor.y += (this.target.y - this.cursor.y) * k;
    if (this.down) this.addPoint(now);
    this.onFrame({ ...this.cursor, down: this.down });
    this.previous = now; this.raf = requestAnimationFrame(this.frame);
  }

  point() { return { x: this.cursor.x, y: this.cursor.y, r: 5 / this.width }; }

  addPoint(now, first = false) {
    const p = this.point();
    const px = p.x * this.width, py = p.y * this.height;
    const distance = this.last ? Math.hypot(px - this.last.px, py - this.last.py) : 0;
    const velocity = distance / clamp((now - this.lastTime) / 1000, 0.001, 0.06);
    this.speed = this.speed * 0.6 + velocity * 0.4;
    if (this.speed > 10) this.stillSince = now;
    // Scale Air Ink's pixel radius (tuned for ~360px canvases) to this surface.
    const radius = clamp(1 + 7.8 / (1 + (this.speed / 75) ** 1.7) + 2.2 * clamp((now - this.stillSince) / 650, 0, 1), 1, 11) * (this.width / 360);
    p.r = radius / this.width;
    this.lastTime = now;
    if (!first && this.last && distance < 1.2 && Math.abs(this.last.r - p.r) < 0.004) return;
    this.last = { px, py, r: p.r };
    (first ? this.onDown : this.onPoint)(p);
  }

  /** @param {Event} [event] */
  press(event) {
    if (this.down || this.mode === "off" || !this.canDraw()) return;
    if (this.mode === "tilt" && !this.raw) return;
    event?.preventDefault();
    this.down = true; this.speed = 0; this.last = null;
    this.stillSince = this.lastTime = performance.now();
    this.hold.classList.add("down");
    this.addPoint(this.lastTime, true);
    navigator.vibrate?.(8);
  }

  lift() {
    if (!this.down) return;
    this.down = false; this.pointer = null; this.last = null;
    this.hold.classList.remove("down");
    this.onUp();
  }

  bindInputs() {
    const { hold, surface } = this;
    // Capture is best-effort: it throws for pointers the browser no longer tracks (and synthetic test events).
    const capture = (el, id) => { try { el.setPointerCapture(id); } catch { /* keep drawing without capture */ } };
    hold.addEventListener("pointerdown", (e) => {
      if (this.mode !== "tilt") return;
      this.pointer = e.pointerId; capture(hold, e.pointerId); this.press(e);
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) hold.addEventListener(name, (e) => { if (this.pointer === /** @type {PointerEvent} */ (e).pointerId) this.lift(); });
    hold.addEventListener("keydown", (e) => { if (e.code === "Space" && !e.repeat) this.press(e); });
    hold.addEventListener("keyup", (e) => { if (e.code === "Space") { e.preventDefault(); this.lift(); } });
    hold.addEventListener("contextmenu", (e) => e.preventDefault());
    // Finger fallback: the drawing surface itself is the pen.
    const toTarget = (e) => {
      const rect = surface.getBoundingClientRect();
      this.target = { x: clamp((e.clientX - rect.left) / rect.width, 0, 1), y: clamp((e.clientY - rect.top) / rect.height, 0, 1) };
    };
    surface.addEventListener("pointerdown", (e) => {
      if (this.mode !== "touch") return;
      toTarget(e); this.cursor = { ...this.target };
      this.pointer = e.pointerId; capture(surface, e.pointerId); this.press(e);
    });
    surface.addEventListener("pointermove", (e) => { if (this.mode === "touch" && this.pointer === e.pointerId) toTarget(e); });
    for (const name of ["pointerup", "pointercancel"]) surface.addEventListener(name, (e) => { if (this.mode === "touch" && this.pointer === /** @type {PointerEvent} */ (e).pointerId) this.lift(); });
    addEventListener("blur", () => this.lift());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.lift(); });
  }
}
