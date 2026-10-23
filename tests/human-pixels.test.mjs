// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalBus } from "../shared/mqtt.js";
import {
  PARAGRAPH, parseText, wrap, fitGrid, glyph, fitScore, simulateDrawing, rng, PresenterRoom, ParticipantSession,
  presenterKey, verifier, topics, virtualParticipant, SCALE, LEGIBLE, simulatedCrowd, artworkSVG, layoutCells, VIRTUAL_ID,
} from "../human-pixels/human-pixels.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toWire = (drawing) => drawing.map(([p, start], i) => [Math.round(p.x * SCALE), Math.round(p.y * SCALE), Math.round(p.r * SCALE), i * 50, start ? 1 : 0]);

test("paragraph has exactly 300 participant letters; spaces and punctuation are automatic", () => {
  const { slots, chars } = parseText(PARAGRAPH);
  assert.equal(slots.length, 300);
  assert.ok(slots.every((i) => /[A-Z]/.test(chars[i])));
  assert.ok(PARAGRAPH.startsWith("AI IS A TEAM SPORT. WORK WITH EACH OTHER."));
});

test("wrap never splits words and keeps every visible character", () => {
  const { chars } = parseText();
  for (const cols of [10, 17, 40]) {
    const rows = wrap(chars, cols);
    assert.ok(rows.every((r) => r.length <= cols));
    const placed = rows.flat().filter((i) => i >= 0).map((i) => chars[i]).join("");
    assert.equal(placed, PARAGRAPH.replace(/ /g, ""));
  }
  const small = fitGrid(chars, 19, 1600, 900), all = fitGrid(chars, chars.length, 1600, 900);
  assert.ok(small.size > all.size * 2, "a few sentences render much larger than the whole paragraph");
});

test("stroke font covers A–Z and punctuation inside the cell", () => {
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ.,'!?") {
    const lines = glyph(ch);
    assert.ok(lines.length, ch);
    for (const [x, y] of lines.flat()) assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1, `${ch} ${x},${y}`);
  }
});

test("legibility score separates traced letters from unreadable ones", () => {
  const random = rng(3);
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    assert.ok(fitScore(ch, toWire(simulateDrawing(ch, "good", random))) > 0.8, `good ${ch}`);
    assert.ok(fitScore(ch, toWire(simulateDrawing(ch, "shaky", random))) > 0.5, `shaky ${ch}`);
    assert.ok(fitScore(ch, toWire(simulateDrawing(ch, "scribble", random))) < LEGIBLE, `scribble ${ch}`);
    assert.ok(fitScore(ch, toWire(simulateDrawing(ch, "tiny", random))) < LEGIBLE, `tiny ${ch}`);
  }
});

test("roster: join order, rejoin, drop-off reassignment, done letters kept, waiting list", () => {
  let now = 0;
  const sent = [];
  const room = new PresenterRoom({ text: "AB C.", now: () => now, send: (to, data) => sent.push({ to, ...data }) });
  const hello = (id, extra = {}) => room.handle({ v: 1, t: "hello", id, ...extra });
  hello("alice001"); hello("bobby002"); hello("carol003");
  assert.deepEqual(room.slots.map((s) => s.cid), ["alice001", "bobby002", "carol003"]);
  hello("dave0004");
  assert.equal(sent.at(-1).slot, null, "fourth person waits when letters run out");
  hello("bobby002");
  assert.equal(room.slots[1].cid, "bobby002", "rejoin keeps the same letter");

  room.handle({ v: 1, t: "done", id: "alice001", done: true });
  now += 31000; // alice (done), bob and carol silent beyond goneMs
  room.handle({ v: 1, t: "hb", id: "carol003", e: 0, n: 0 });
  room.tick();
  assert.equal(room.slots[1].cid, "dave0004", "waiting person takes bob's dropped letter");
  assert.equal(room.slots[0].cid, "alice001", "a finished letter is never reassigned");
  hello("bobby002");
  assert.equal(sent.at(-1).slot, null, "bob returns after reassignment and waits for a free letter");
});

test("removing virtual phones frees their letters and moves inkless real people down", () => {
  const sent = [];
  const room = new PresenterRoom({ send: (to, data) => sent.push({ to, ...data }) });
  const ids = simulatedCrowd(5, { seed: 7 }).map((p) => p.id);
  assert.ok(ids.every((id) => VIRTUAL_ID.test(id)));
  const real = ["realink01", "realnew02"];
  for (const id of [ids[0], ids[1], real[0], ids[2], real[1], ids[3]]) room.handle({ v: 1, t: "hello", id });
  room.handle({ v: 1, t: "ink", id: real[0], e: 0, k: 0, p: [[100, 100, 20, 0, 1]] });
  room.handle({ v: 1, t: "ink", id: ids[3], e: 0, k: 0, p: [[100, 100, 20, 0, 1]] });
  assert.equal(room.release((id) => VIRTUAL_ID.test(id)), 4);
  assert.equal(room.slots[2].cid, real[0], "a real participant with ink keeps their letter");
  assert.equal(room.slots[0].cid, real[1], "an inkless real participant moves to the first free letter");
  assert.equal(sent.at(-1).to, real[1]);
  assert.equal(sent.at(-1).slot, 0);
  assert.equal(room.reach, 3);
  assert.ok(room.slots.every((s) => !s.cid || !VIRTUAL_ID.test(s.cid)) && room.slots[5].pts.length === 0);
});

test("lossy network: heartbeats and resend requests converge on identical ink", async () => {
  const bus = new LocalBus({ loss: 0.35, delay: 5 });
  const t = topics("TESTROOM");
  const room = new PresenterRoom({ send: (to, data) => presenter.publish(to === "all" ? t.all : t.client(to), data) });
  const presenter = bus.client({ onMessage: (_topic, msg) => room.handle(msg) });
  presenter.subscribe(t.up); presenter.connect();
  room.setPhase("draw");
  const client = bus.client({ onMessage: (_topic, data) => session.receive(data) });
  const session = new ParticipantSession({ id: "lossy001", send: (d) => client.publish(t.up, d) });
  client.subscribe(t.client("lossy001")); client.subscribe(t.all); client.connect();
  for (let i = 0; i < 40 && session.slot === null; i++) { session.hello(); await sleep(10); }
  assert.equal(session.slot, 0);
  for (const [p, start] of simulateDrawing("A")) { session.add(p, start); if (Math.random() < 0.2) session.flush(); }
  session.undo();
  for (const [p, start] of simulateDrawing("A").slice(0, 20)) session.add(p, start);
  for (let i = 0; i < 1500 && JSON.stringify(room.slots[0].pts) !== JSON.stringify(session.pts); i++) { session.lastSend = -1e9; session.flush(); await sleep(8); }
  assert.deepEqual(room.slots[0].pts, session.pts);
  assert.ok(session.pts.length > 20);
});

test("presenter signatures: valid accepted, forged/tampered/other-room rejected, no secret in room code", async () => {
  const key = await presenterKey();
  assert.match(key.room, /^[A-Z2-9]{8}$/);
  const verify = verifier(key.room);
  const good = await key.sign({ t: "state", phase: "draw" });
  assert.equal((await verify(good)).phase, "draw");
  assert.equal(await verify({ ...good, d: good.d.replace("draw", "lobby") }), null);
  const other = await presenterKey();
  assert.equal(await verify(await other.sign({ t: "state", phase: "lobby" })), null);
  assert.equal(await verify({ ...(await other.sign({ t: "x" })), k: good.k }), null);
  const restored = await presenterKey(key.jwk);
  assert.equal(restored.room, key.room, "a stored JWK restores the same room");
  assert.ok(!JSON.stringify(good).includes(key.jwk.d), "private key never leaves the presenter");
});

test("JSONL export contains only consenting participants and no client ids", () => {
  const room = new PresenterRoom({ text: "HI" });
  room.handle({ v: 1, t: "hello", id: "yes00001", trace: true, os: "ios" });
  room.handle({ v: 1, t: "hello", id: "nope0002" });
  for (const id of ["yes00001", "nope0002"]) room.handle({ v: 1, t: "ink", id, e: 1, k: 0, p: [[100, 100, 20, 0, 1, 2.5, -3], [200, 200, 20, 40, 0, 3, -4]] });
  const lines = room.toJSONL("s1").split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].letter, "H");
  assert.deepEqual(lines[0].points[0], [100, 100, 20, 0, 1, 2.5, -3]);
  assert.ok(!JSON.stringify(lines).includes("yes00001"));
  assert.equal(room.slots[1].pts[0].length, 5, "non-consenting tilt values are discarded");
});

/** Runs a whole room over the in-memory bus at `speed`× real time with mixed failure modes. */
async function simulate(n, { speed = 25, seed = 1 } = {}) {
  const bus = new LocalBus({ loss: 0.05, delay: 4 });
  const key = await presenterKey();
  const t = topics(key.room);
  const room = new PresenterRoom({ awayMs: 8000 / speed * 1, goneMs: 20000 / speed, send: async (to, data) => presenter.publish(to === "all" ? t.all : t.client(to), await key.sign(data)) });
  const presenter = bus.client({ onMessage: (_topic, msg) => room.handle(msg) });
  presenter.subscribe(t.up); presenter.connect();
  room.setPhase("draw");
  const ticker = setInterval(() => room.tick(), 2000 / speed);
  const verify = verifier(key.room);
  const roles = {};
  const people = simulatedCrowd(n, { seed }).map((plan) => {
    roles[plan.role] = (roles[plan.role] ?? 0) + 1;
    return virtualParticipant({ bus, room: key.room, verify, speed, ...plan });
  });
  // Leavers vanish; latecomers inherit their letters once they are gone.
  const start = Date.now();
  while (Date.now() - start < 150000) {
    await sleep(100);
    const lateJoinsOver = Date.now() - start > 50000 / speed;
    if (lateJoinsOver && people.every((p) => !p.client.live || p.session.done || p.session.slot === null)) break;
  }
  // Heartbeats and resend requests repair ink lost on the 5%-loss network; allow a few rounds.
  const synced = () => people.every((p) => !p.session.done || room.slots[p.session.slot].cid !== p.session.id || room.slots[p.session.slot].pts.length === p.session.pts.length);
  for (let i = 0; i < 100 && !synced(); i++) await sleep(100);
  clearInterval(ticker);
  people.forEach((p) => p.stop());
  return { room, roles, people };
}

for (const n of [3, 30, 300]) {
  test(`simulation with ${n} participants stays legible after auto-fix`, { timeout: 180000 }, async () => {
    const { room, roles, people } = await simulate(n);
    const used = room.slots.slice(0, Math.min(n, 300));
    const ids = used.map((s) => s.cid).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, "no letter is held by two people");
    if (roles.leaver && roles.late) assert.ok(used.some((s) => s.history > 0), "a dropped letter was reassigned");
    for (const p of people.filter((p) => p.session.done && room.slots[p.session.slot].cid === p.session.id)) {
      const slot = room.slots[p.session.slot];
      assert.deepEqual([slot.epoch, slot.pts.length, slot.pts], [p.session.epoch, p.session.pts.length, p.session.pts], `presenter ink matches phone ink for ${p.session.id} sent=${p.session.sent}`);
    }
    room.autoFix(LEGIBLE, used.length);
    const illegible = used.filter((s) => s.view === "ink" && room.fit(s) < LEGIBLE);
    assert.equal(illegible.length, 0);
    const svg = artworkSVG(room);
    assert.equal(svg.match(/<g data-char=/g).length, PARAGRAPH.replace(/ /g, "").length, "every letter and punctuation mark is drawn");
    const fixed = used.filter((s) => s.view === "letter").length;
    console.log(`n=${n} roles=${JSON.stringify(roles)} reassigned=${used.filter((s) => s.history).length} letterFallback=${fixed} messages=${room.messages}`);
  });
}

test("layout keeps every cell inside the screen at 3, 30 and 300 letters", () => {
  const parsed = parseText();
  for (const [w, h] of [[1920, 1080], [1280, 800], [390, 844]]) for (const count of [19, 120, parsed.chars.length]) {
    const { cells } = layoutCells(parsed, count, w, h, 10);
    assert.equal(cells.length, parsed.chars.slice(0, count).filter((c) => c !== " ").length);
    for (const c of cells) assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= w + 0.01 && c.y + c.h <= h + 0.01, `${w}x${h} ${count}`);
  }
});
