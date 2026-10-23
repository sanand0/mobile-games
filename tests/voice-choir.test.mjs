// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalBus } from "../shared/mqtt.js";
import { presenterKey, verifier } from "../shared/signing.js";
import { yin, PitchTracker, LeakGuard, hzToMidi, midiToHz, noteName, fold } from "../shared/pitch.js";
import {
  parseNote, chordNotes, CHORDS, SONGS, parseSong, segments, targetAt, ChoirRoom, ChoirSession, topics, singer, rng,
  simulatedCrowd, virtualChoir, VIRTUAL_ID, TOLERANCE,
} from "../voice-choir/voice-choir.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SR = 48000;
/** One analysis frame of a voice-like tone: harmonics with given amplitudes, plus white noise. */
function tone(hz, { harmonics = [1], noise = 0, n = 2048, seed = 1, sr = SR } = {}) {
  const random = rng(seed), phases = harmonics.map(() => random() * 6.28);
  return Float32Array.from({ length: n }, (_, i) => 0.2 * harmonics.reduce((s, a, k) => s + a * Math.sin(2 * Math.PI * hz * (k + 1) * (i / sr) + phases[k]), 0) + noise * (random() * 2 - 1));
}
const cents = (a, b) => 1200 * Math.log2(a / b);

test("note maths: names, parsing, octave folding", () => {
  assert.equal(noteName(69), "A4");
  assert.equal(noteName(61.4), "C♯4");
  assert.equal(parseNote("C4"), 60);
  assert.equal(parseNote("Bb3"), 58);
  assert.ok(Math.abs(midiToHz(57) - 220) < 1e-9 && Math.abs(hzToMidi(110) - 45) < 1e-9);
  assert.deepEqual(fold(45, 57), { folded: 57, octaves: -1 });
  assert.deepEqual(fold(81.2, 57), { folded: 57.2, octaves: 2 });
  assert.deepEqual(chordNotes("C"), [60, 64, 67]);
  assert.deepEqual(chordNotes("Am"), [57, 60, 64]);
  for (const c of CHORDS) assert.equal(chordNotes(c).length, 3, c);
});

test("YIN: pure and voice-like tones within 5 cents, 70–900 Hz, at 44.1 and 48 kHz", () => {
  for (const sr of [44100, 48000]) for (const hz of [70, 98, 131, 196, 262, 349, 440, 622, 880]) {
    const r = yin(tone(hz, { sr }), sr);
    assert.ok(Math.abs(cents(r.hz, hz)) < 5, `${hz} Hz at ${sr}: got ${r.hz.toFixed(1)}`);
    assert.ok(r.confidence > 0.9);
  }
});

test("YIN: strong harmonics and a weak fundamental do not cause octave errors", () => {
  for (const hz of [98, 147, 220, 330]) for (const harmonics of [[0.3, 1, 0.7, 0.5], [0.15, 1, 0.9, 0.6, 0.4, 0.2], [1, 0.8, 0.6, 0.4, 0.3, 0.2, 0.1]]) {
    const r = yin(tone(hz, { harmonics, seed: hz }), SR);
    assert.ok(Math.abs(cents(r.hz, hz)) < 10, `${hz} Hz ${harmonics}: got ${r.hz.toFixed(1)}`);
  }
});

test("YIN with noise: accurate at 10 dB SNR; white noise and silence have low confidence", () => {
  for (const hz of [110, 220, 330]) {
    const r = yin(tone(hz, { harmonics: [1, 0.5, 0.3], noise: 0.08, seed: hz }), SR);
    assert.ok(Math.abs(cents(r.hz, hz)) < 25, `${hz} noisy: ${r.hz.toFixed(1)}`);
  }
  const random = rng(5);
  const white = Float32Array.from({ length: 2048 }, () => random() * 0.6 - 0.3);
  assert.ok(yin(white, SR).confidence < 0.5, "white noise is aperiodic");
  assert.ok(yin(new Float32Array(2048), SR).db < -100, "silence is below any gate");
});

test("PitchTracker: noise gate, octave-slip hysteresis, real leaps accepted, 10 Hz median summary", () => {
  const tracker = new PitchTracker();
  tracker.calibrate(Array.from({ length: 30 }, (_, i) => -66 + (i % 5)));
  assert.ok(tracker.gateDb > -60 && tracker.gateDb < -50);
  let t = 0;
  const feed = (hz, db = -25, confidence = 0.95) => tracker.frame({ hz, db, confidence }, (t += 40));
  for (let i = 0; i < 5; i++) feed(220);
  assert.ok(Math.abs(feed(440).midi - 57) < 0.01, "a one-frame octave slip is folded back");
  assert.ok(Math.abs(feed(220).midi - 57) < 0.01);
  assert.equal(feed(220, -70).voiced, false, "below the noise gate");
  assert.equal(feed(220, -25, 0.5).voiced, false, "below the confidence gate");
  for (let i = 0; i < 3; i++) feed(220);
  const leap = [1, 2, 3, 4, 5].map(() => feed(110).midi);
  assert.ok(Math.abs(leap.at(-1) - 45) < 0.01, "a sustained octave change is accepted");
  const fresh = new PitchTracker();
  for (const hz of [220, 221, 300, 219]) fresh.frame({ hz, db: -25, confidence: 0.95 }, (t += 40));
  const s = fresh.take();
  assert.ok(s.voiced && Math.abs(midiToHz(s.midi) - 220) < 3, `median rejects the outlier: ${midiToHz(s.midi)}`);
});

test("LeakGuard: drops frames while our tone plays (plus latency and tail) and machine-steady tones; keeps human hums", () => {
  const guard = new LeakGuard();
  guard.latencyMs = 200; // e.g. Bluetooth
  guard.mark(1000, 1400);
  assert.equal(guard.check({ hz: 220, confidence: 0.95 }, 1100), null, "before the tone reaches the speaker");
  assert.equal(guard.check({ hz: 220, confidence: 0.95 }, 1300), "tone");
  assert.equal(guard.check({ hz: 220, confidence: 0.95 }, 1750), "tone", "latency + tail + frame");
  // A loudspeaker tone (YIN on a synthetic sine): exact pitch, no wobble → dropped once ~300 ms of evidence accrues.
  const synthetic = [...Array(12)].map((_, i) => guard.check(yin(tone(220, { seed: i }), SR), 3000 + i * 40));
  assert.ok(synthetic.slice(8).every((r) => r === "steady"), `synthetic tone: ${synthetic}`);
  // A well-held human hum: 5.5 Hz vibrato of ±15 cents and slight jitter, even exactly on A3 → kept.
  const human = new LeakGuard(), random = rng(9);
  const kept = [...Array(40)].map((_, i) => human.check({ hz: 220 * 2 ** ((15 * Math.sin(i * 0.04 * 2 * Math.PI * 5.5) + (random() - 0.5) * 4) / 1200), confidence: 0.93 }, 5000 + i * 40));
  assert.ok(kept.every((r) => r === null), "human hum kept");
  // Even a very steady singer is not on an exact equal-tempered pitch: 20 cents flat, ±1 cent → kept.
  const flatGuard = new LeakGuard();
  assert.ok([...Array(20)].every((_, i) => flatGuard.check({ hz: 220 * 2 ** ((-20 + Math.sin(i)) / 1200), confidence: 0.95 }, i * 40) === null));
});

test("songs: parse, loop with a rest, harmony below the melody, canon delays later groups", () => {
  assert.deepEqual(SONGS.map((s) => s.id), ["birthday", "twinkle", "row", "mary"]);
  for (const song of SONGS) assert.ok(parseSong(song).beats >= 8, song.id);
  assert.equal(parseSong(SONGS[1]).steps.length, 42, "Twinkle has all six lines");
  const ode = SONGS.findIndex((s) => s.id === "mary"); // starts on E4 over C, like the original fixture
  const cfg = { mode: "song", song: ode, bpm: 60, start: 10000, note: 57, chord: "C" };
  assert.equal(targetAt(cfg, 0, 9000), null, "count-in is a rest");
  assert.equal(targetAt(cfg, 0, 10500), parseNote("E4"));
  const h1 = targetAt(cfg, 1, 10500), h2 = targetAt(cfg, 2, 10500);
  assert.ok(h2 < h1 && h1 < parseNote("E4"), `harmony sits below: ${h1} ${h2}`);
  assert.ok([0, 4, 7].includes(h1 % 12) && [0, 4, 7].includes(h2 % 12), "harmony uses chord tones");
  const beats = parseSong(SONGS[ode]).beats;
  assert.equal(targetAt(cfg, 0, 10000 + beats * 1000 + 500), null, "rest between loops");
  assert.equal(targetAt(cfg, 0, 10000 + (beats + 2) * 1000 + 500), parseNote("E4"), "loops");
  const row = { ...cfg, song: SONGS.findIndex((s) => s.canon) };
  assert.equal(targetAt(row, 1, 10500), null, "voice 2 waits two bars");
  assert.equal(targetAt(row, 1, 18500), parseNote("C4"));
  const segs = segments(cfg, 0, 10000, 14000);
  assert.ok(segs.length >= 4 && segs.every((s, i) => !i || s.t0 === segs[i - 1].t1), "contiguous segments");
  assert.equal(segments({ ...cfg, mode: "chord", chord: "F" }, 2, 0, 1)[0].midi, chordNotes("F")[2]);
});

test("pause freezes a song where it is; Start resumes from there after a count-in", () => {
  let now = 0;
  const room = new ChoirRoom({ now: () => now });
  const mary = SONGS.findIndex((s) => s.id === "mary"), beat = 60000 / 60;
  room.configure({ mode: "song", song: mary, bpm: 60 });
  assert.equal(room.cfg.paused, true, "a song waits for Start");
  room.setPhase("sing");
  now += 2 * beat + 2.5 * beat; // count-in, then 2.5 beats into the song: third note (C4)
  assert.equal(targetAt(room.cfg, 0, now), parseNote("C4"));
  room.setPhase("pause");
  assert.equal(targetAt(room.cfg, 0, now + 1000), null, "silent while paused");
  now += 60000;
  room.setPhase("sing");
  assert.equal(targetAt(room.cfg, 0, now + beat), null, "two-beat count-in on resume");
  assert.equal(targetAt(room.cfg, 0, now + 2 * beat + 100), parseNote("C4"), "resumes mid-note");
  assert.equal(targetAt(room.cfg, 0, now + 2 * beat + 600), parseNote("D4"), "then carries on");
  room.configure({ start: 1 });
  assert.equal(targetAt(room.cfg, 0, now + 2 * beat + 100), parseNote("E4"), "Restart goes back to the top");
});

test("room: balanced groups, returning group kept, octave-folded scoring by sample time despite latency", () => {
  let now = 100000;
  const sent = [];
  const room = new ChoirRoom({ now: () => now, send: (to, data) => sent.push({ to, ...data }) });
  for (const id of ["aaaaaa01", "bbbbbb02", "cccccc03", "dddddd04"]) room.handle({ v: 1, t: "hello", id });
  assert.deepEqual([...room.clients.values()].map((c) => c.group), [0, 1, 2, 0]);
  room.handle({ v: 1, t: "hello", id: "eeeeee05", g: 2 });
  assert.equal(room.clients.get("eeeeee05").group, 2, "a phone that already had a group keeps it");
  room.setPhase("sing");
  room.configure({ mode: "unison", note: 57 });
  // aaa sings A2 (an octave low, in tune); bbb sings 50 cents sharp; ccc is silent; ddd is noisy (low confidence).
  const batch = (id, hz, conf = 95) => room.handle({ v: 1, t: "p", id, st: "ok", b: now - 600, s: [[0, hz, -30, conf], [100, hz, -30, conf], [200, hz, -30, conf]] });
  batch("aaaaaa01", 110); batch("bbbbbb02", 220 * 2 ** (50 / 1200)); batch("cccccc03", 0); batch("dddddd04", 300, 30);
  now += 100;
  const groups = room.metrics(now - 600 - 100 + 200), sum = (k) => groups.reduce((s, g) => s + g[k], 0);
  assert.equal(sum("voiced"), 2);
  assert.deepEqual(groups.map((g) => g.inTune), [1, 0, 0], "A2 folds onto A3; +50 cents is out of tune");
  assert.equal(sum("quiet"), 3, "the silent, low-confidence and not-yet-heard singers are quiet");
  const lat = room.clients.get("aaaaaa01").latency;
  assert.ok(lat > 300 && lat < 500, `latency estimate ${lat}`);
  // Duplicates and reordered samples are ignored.
  const before = room.clients.get("aaaaaa01").trace.length;
  room.handle({ v: 1, t: "p", id: "aaaaaa01", b: now - 700, s: [[100, 110, -30, 95], [0, 110, -30, 95]] });
  assert.equal(room.clients.get("aaaaaa01").trace.length, before);
});

test("room: convergence time measured from the target change", () => {
  let now = 0;
  const room = new ChoirRoom({ now: () => now });
  const ids = ["sing0001", "sing0002", "sing0003"];
  for (const id of ids) room.handle({ v: 1, t: "hello", id, g: 0 });
  room.setPhase("sing");
  room.configure({ mode: "unison", note: 60 });
  const voices = ids.map((_, i) => singer({ random: rng(i + 1), role: "good" }));
  for (let step = 0; step < 60; step++) {
    now += 100;
    ids.forEach((id, i) => { const s = voices[i](now, 60); room.handle({ v: 1, t: "p", id, st: "ok", b: now, s: [[0, s.voiced ? midiToHz(s.midi) : 0, s.db, s.confidence * 100]] }); });
    room.update(now);
  }
  assert.equal(room.converge.length, 1);
  assert.ok(room.converge[0].ms > 300 && room.converge[0].ms < 3500, `lock ${room.converge[0].ms} ms`);
  assert.ok(room.accuracy(2000) > 0.8);
});

test("JSONL: aggregates for all, per-sample rows only with consent, no client ids, consent withdrawal forgets", () => {
  let now = 0;
  const room = new ChoirRoom({ now: () => now });
  room.handle({ v: 1, t: "hello", id: "yesyes01", consent: true });
  room.handle({ v: 1, t: "hello", id: "nopeno02" });
  room.setPhase("sing");
  for (let i = 0; i < 5; i++) {
    now += 100;
    for (const id of ["yesyes01", "nopeno02"]) room.handle({ v: 1, t: "p", id, b: now, s: [[0, 220, -30, 90]] });
    room.update(now);
  }
  const lines = room.toJSONL().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "session");
  assert.match(lines[0].note, /No audio/);
  const samples = lines.filter((l) => l.type === "sample");
  assert.equal(samples.length, 5);
  assert.ok(samples.every((s) => s.singer === 0 && s.cents === 0));
  assert.ok(lines.some((l) => l.type === "summary"));
  const text = JSON.stringify(lines);
  assert.ok(!text.includes("yesyes01") && !text.includes("nopeno02"));
  room.handle({ v: 1, t: "hello", id: "yesyes01", consent: false });
  assert.equal(room.toJSONL().split("\n").filter((l) => l.includes('"sample"')).length, 0);
});

test("session: presenter-clock offset, batching follows the presenter, heartbeat while silent, bounded offline buffer", () => {
  let local = 50000, online = true;
  const out = [];
  const s = new ChoirSession({ id: "phone001", now: () => local, send: (d) => online && out.push(d) });
  s.receive({ t: "state", now: 20000 - 80, phase: "sing", round: 1, cfg: { mode: "unison", note: 57 }, batch: 3, live: 4 });
  s.receive({ t: "state", now: 20000 - 30, phase: "sing", round: 1, cfg: { mode: "unison", note: 57 }, batch: 3, live: 4 });
  assert.equal(s.clock(), 20000 - 30, "offset uses the least-delayed message");
  s.receive({ t: "assign", to: "phone001", group: 1, n: 7 });
  out.length = 0;
  for (let i = 0; i < 3; i++) { s.push({ midi: 57, voiced: true, confidence: 0.9, db: -30 }); local += 100; s.flush(); }
  assert.equal(out.length, 1);
  assert.equal(out[0].s.length, 3);
  assert.deepEqual(out[0].s[0].slice(1), [220, -30, 90]);
  local += 2100; s.flush();
  assert.equal(out.at(-1).t, "hb");
  online = false;
  for (let i = 0; i < 60; i++) { s.push({ midi: 0, voiced: false, confidence: 0, db: -70 }); local += 100; s.flush(); }
  assert.ok(s.buffer.length <= 30);
});

test("presenter signatures are shared with Human Pixels and reject forgeries", async () => {
  const key = await presenterKey(), verify = verifier(key.room);
  const good = await key.sign({ t: "state", phase: "sing" });
  assert.equal((await verify(good)).phase, "sing");
  assert.equal(await verify({ ...good, d: good.d.replace("sing", "pause") }), null);
});

/** A whole room over the in-memory bus with loss, jitter, and chaos roles, run in real time. */
async function simulate(n, { seed = 3, plan = [["unison", 4000]] } = {}) {
  const bus = new LocalBus({ loss: 0.05, delay: 60 });
  const key = await presenterKey(), t = topics(key.room);
  const room = new ChoirRoom({ awayMs: 2500, goneMs: 5000, send: async (to, data) => presenter.publish(to === "all" ? t.all : t.client(to), await key.sign(data)) });
  const presenter = bus.client({ onMessage: (_topic, msg) => room.handle(msg) });
  presenter.subscribe(t.up); presenter.connect();
  const ticker = setInterval(() => room.tick(), 1000), updater = setInterval(() => room.update(), 100);
  // Three phones sing cleanly; larger rooms get the full mix of failure modes.
  const crowd = simulatedCrowd(n, { seed, lateAt: 2500, chaos: n > 3 });
  const choir = virtualChoir({ bus, room: key.room, verify: verifier(key.room), crowd });
  await sleep(1500);
  room.setPhase("sing");
  const results = {};
  for (const [mode, ms, extra = {}] of plan) {
    const from = room.timeline.length;
    room.configure({ mode, ...extra });
    await sleep(ms);
    const rows = room.timeline.slice(from + 10); // skip the first second while people find the note
    let sum = 0, voiced = 0;
    for (const r of rows) for (const g of r.groups) { sum += g.inTune * g.voiced; voiced += g.voiced; }
    results[mode] = { accuracy: voiced ? sum / voiced : 0, voiced: voiced / Math.max(1, rows.length) };
  }
  const counts = room.counts(), rate = room.messages;
  clearInterval(ticker); clearInterval(updater); choir.stop();
  return { room, results, counts, rate, crowd };
}

for (const n of [3, 30, 300]) {
  test(`simulation with ${n} phones converges in unison and chord rounds`, { timeout: 60000 }, async () => {
    const t0 = Date.now();
    const { room, results, counts, crowd } = await simulate(n, { plan: [["unison", 4000, { note: 57 }], ["chord", 4000, { chord: "F" }]] });
    const seconds = (Date.now() - t0) / 1000, roles = {};
    for (const p of crowd) roles[p.role] = (roles[p.role] ?? 0) + 1;
    console.log(`n=${n} ${JSON.stringify(results)} lock=${room.lockTime()}ms converged=${room.converge.length} counts=${JSON.stringify(counts)} msg/phone/s=${(room.messages / n / seconds).toFixed(1)} roles=${JSON.stringify(roles)}`);
    // Chaos roles (sharp, flat, lost, noisy) can never be in tune, so ~0.8 is the ceiling at 30+ phones.
    assert.ok(results.unison.accuracy > 0.6, `unison accuracy ${results.unison.accuracy}`);
    assert.ok(results.chord.accuracy > 0.6, `chord accuracy ${results.chord.accuracy}`);
    assert.ok(room.converge.length >= (n >= 30 ? 4 : 1), "groups lock on after each change");
    assert.ok(room.messages / n / seconds <= 10, "phones send at most 10 messages per second");
    if (n === 300) {
      assert.ok(counts.muted + counts.denied > 0, "muted and denied phones are counted");
      assert.ok(counts.live >= n * 0.85, `most phones are live (${counts.live})`);
      const sizes = room.groupSizes();
      assert.ok(Math.max(...sizes) - Math.min(...sizes) < n * 0.1, `groups balanced ${sizes}`);
    }
  });
}

test("simulation: 30 phones follow a three-part song in time", { timeout: 60000 }, async () => {
  const song = SONGS.findIndex((s) => s.id === "mary");
  const { room, results } = await simulate(30, { plan: [["song", 9000, { song, bpm: 80 }]] });
  console.log(`song ${JSON.stringify(results)} lock=${room.lockTime()}ms`);
  // Each note lasts 3 s and singers need ~1 s to find it, so ~0.5 is good; a clock mismatch would score ~0.
  assert.ok(results.song.accuracy > 0.4, `song accuracy ${results.song.accuracy}`);
  assert.ok(room.converge.length >= 3);
});

test("virtual phone ids are recognisable for removal", () => {
  const room = new ChoirRoom();
  const crowd = simulatedCrowd(5);
  assert.ok(crowd.every((p) => VIRTUAL_ID.test(p.id)));
  for (const p of crowd) room.handle({ v: 1, t: "hello", id: p.id });
  room.handle({ v: 1, t: "hello", id: "realphone1" });
  assert.equal(room.release((id) => VIRTUAL_ID.test(id)), 5);
  assert.deepEqual([...room.clients.keys()], ["realphone1"]);
  assert.ok(TOLERANCE > 0);
});
