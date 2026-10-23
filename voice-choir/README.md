# Voice Choir

A collaborative humming game for 2 to 300 phones. Each phone listens to its singer, works out the pitch locally, and shows a target note on a pitch meter. The presenter screen draws every singer's pitch as glowing ribbons that converge on the target lines. It also plays a **synthesized choir rebuilt from the pitch numbers**. No one's voice is recorded, uploaded or replayed.

## Files

| File | Purpose |
| --- | --- |
| `voice-choir/index.html` | Landing, participant and presenter views (plain HTML/CSS/JS module), choir synth, recorder |
| `voice-choir/voice-choir.js` | Core with no DOM: chords, songs and targets, group assignment, wire protocol, convergence metrics, JSONL export, virtual singers |
| `shared/pitch.js` | Reusable voice sensing: note maths, YIN pitch detector, `PitchTracker` (noise gate, octave hysteresis, 10 Hz summaries), `LeakGuard` (keeps the phone's own tone out), `Microphone` (permissions, calibration, recovery) |
| `shared/signing.js` | Presenter signing shared with Human Pixels (moved out of `human-pixels.js`, which re-exports it) |
| `shared/mqtt.js` | Reusable MQTT-over-WebSocket client plus the in-memory `LocalBus` for simulations |
| `tests/voice-choir.test.mjs` | Node tests: detector on synthetic audio, tracker, leak guard, rounds, protocol, 3/30/300-phone simulations |

## Run and deploy

The page needs `http(s)://`: ES modules, WebCrypto and the microphone do not work from `file://`. Phones need **HTTPS** for the microphone (`localhost` also counts as secure).

```sh
uv run python -m http.server 8765 --bind 127.0.0.1   # from the repo root; open http://127.0.0.1:8765/voice-choir/
# Deploy: any static HTTPS host. Copy voice-choir/ and shared/ side by side (GitHub Pages works as-is).
```

There is no server. Messages go through public MQTT brokers (`broker.emqx.io`, with `test.mosquitto.org` as the fallback). The QR code image comes from `api.qrserver.com`, fonts from Google Fonts, and icons from jsDelivr.

## How a session runs

1. The presenter opens `voice-choir/` and clicks **Create a room**. This generates a signing key that stays in this browser. The room code is a hash of the public key, so the audience link (`?room=CODE`) carries no secret.
2. Phones scan the QR code. Each phone is dealt a part (group 1, 2 or 3), filling the smallest group first, and keeps it across reloads. **Rebalance** re-deals the parts evenly.
3. On the phone, **Start singing** asks for the microphone (inside the tap, as iPhone requires). The phone then measures the room's noise for about 1 s to set its noise gate, and keeps the screen awake.
4. The presenter picks a round and presses **Start**:
   - **1 · Unison:** everyone hums one note. Use **−/+** or the ↑/↓ keys to change it.
   - **2 · Chord:** parts 1, 2 and 3 sing the root, third and fifth of the chosen triad (C, Dm, Em, F, G, Am, D, E, A, B♭, E♭, Cm).
   - **3 · Song:** four public-domain songs, in C within humming range:
     - *Happy Birthday*
     - *Twinkle, Twinkle, Little Star* (all six lines)
     - *Row, Row, Row Your Boat*
     - *Mary Had a Little Lamb*

     Part 1 sings the melody and parts 2 and 3 sing chord tones beneath it. *Row, Row, Row Your Boat* is a three-part round instead, with each part entering two bars later.

     Default tempos are deliberately slow (42–50 bpm); raise them with the Tempo slider (20–160). Every (re)start has a two-beat count-in, and songs loop with a two-beat rest.

     **Pause** (and Reveal) freezes the song where it is. **Start** resumes from that point after a two-beat count-in, and **Restart** goes back to the top. A song waits, paused at the top, until the room is singing.
5. **Reveal** shows a scorecard on screen (accuracy, median lock-on time, peak singers, per-round table), and each phone shows its own in-tune percentage. **Replay** replays the last 30 s of ribbons and choir. **Record** captures the synthesized choir audio and the animated ribbons. **Export** downloads them, plus the JSONL measurements.

Presenter keyboard on the stage: ↑/↓ changes the note (unison), chord (chord) or tempo (song). 1/2/3 switch rounds, Space starts or pauses, R replays. Hovering a target line shows that part's numbers. Round settings live in the URL (`&mode=chord&chord=F&song=ode&bpm=96&qr=1`), so a bookmark restores them.

### The phone's pitch meter

- **Target band:** the target note ± the tolerance (35 cents), in the part's colour. In songs, upcoming notes scroll in from the right.
- **Bright line:** your pitch moved into the target's octave. It turns the part's colour when you are in tune. Any octave counts.
- **Dashed line:** your actual pitch. The view widens so it stays visible when you sing one or two octaves away, with a "−1 oct" tag.
- **Readouts:** the target note in large type; a small line with your note, Hz, octave difference and detection confidence; a hint chip (*Higher · 40¢*, *In tune*, *Lower*); and a level meter. The level meter marks the calibrated noise gate and shows *Silent*, *Good* or *Too loud*. The lane glows after 1 s in tune.
- **Guide tone:** hold **Hear note** (touch, mouse, or Space/Enter) to hear the target in your own octave for as long as you hold it. It stops the moment you let go.
  - A 0.25 s cue plays every time the note changes: when the presenter changes the note or chord, and at each note change in songs (shorter for very short notes).
  - **Drone** keeps a pulsing guide going in unison and chord rounds.
  - A volume slider (default 80%; 0 = mute) controls all of these.
  - The tone adds harmonics to the fundamental, because phone speakers barely reproduce 100–250 Hz and a pure sine sounds faint.

### Keeping the phone's own tone out of the measurement

A leaked tone would fold onto the target and score as perfectly in tune, so three layers guard against it (`LeakGuard` in `shared/pitch.js`):

1. **Time gate:** frames analysed while this phone's tone is audible are discarded. For a held *Hear note* that runs from press to release (plus the tail). The gate covers the analysis frame, the reported output latency (`outputLatency + baseLatency`, which covers Bluetooth) and a 150 ms room-decay tail. Discarded moments send nothing, rather than "silence", and the presenter bridges gaps of up to 700 ms.
2. **Pulsed drone, short song pips:** the drone plays 350 ms on and 450 ms off, so the mic measures in the gaps. It fades out after you hold the note for 3 s and returns if you drift for more than 1 s. In songs the guide is a 0.25 s pip only where the note changes, when singers are still moving to it anyway.
3. **Machine-steady filter:** pitch within 6 cents of an equal-tempered note, with under 1.5 cents of wobble for about 300 ms, is rejected. Human hums wobble 5–20 cents; synthesized tones do not. This also catches a neighbour's phone and echo tails that slip past the time gate.

Echo cancellation is off because it distorts pitch. Noise suppression and auto-gain are off because they squash sustained hums.

## Pitch detection

- **YIN** (cumulative mean normalized difference) runs on 2048-sample frames at about 25 Hz from an `AnalyserNode`, halving the sample rate first. That takes about 1.5 ms per frame on a laptop.
- **Range and accuracy:** 65–1000 Hz. On synthetic tones it is within 5 cents, and within 25 cents at about 10 dB SNR.
- **`PitchTracker`:**
  - Gates by calibrated level (noise floor + 9 dB) and by YIN confidence (≥0.8).
  - Holds the previous octave through ±1–2-octave jumps until they persist for 3 frames, since those are usually harmonic locks.
  - Takes a median of 3 frames.
  - Summarises at 10 Hz: median pitch, mean confidence and peak level.

## Protocol (topic `voice-choir/v1/<ROOM>/…`)

| Direction | Topic | Messages |
| --- | --- | --- |
| phone → presenter | `up` | `hello {g, consent, os}`, `p {b, s:[[dt_ms, hz, db, conf]…], st}`, `hb {st}`, `bye` |
| presenter → one phone | `c/<id>` | `assign {group, n}` (signed) |
| presenter → all | `all` | `state {now, phase, round, cfg, live, batch}` every 2 s and on change, `hi` (signed) |

- **What phones send:** only pitch (Hz, 0 = silent/unvoiced), level (dBFS), confidence (0–100) and timestamps, at **10 readings per second**. Readings are batched 2/3/5 per message as the room grows (<50, <150, 300 phones), which is 5, 3.3 or 2 messages per phone per second, sparing the public relay. `st` reports the mic state: `ok`, `listen` (tone playing), `muted`, `interrupted`, `denied`, `nomic` or `off`. Phones never receive anyone else's data.
- **Latency:** phones estimate the presenter's clock from the smallest observed offset in signed `state` messages and stamp readings with it. Songs therefore line up across phones, and scoring uses the moment the singer saw the note, not the arrival time. The presenter draws and synthesizes everything `delay` ms behind real time. That is batching + 300 ms, raised in 100 ms steps to the median measured latency + 200 ms (at most 1.5 s).
- **Authenticity:** phones accept presenter messages only if signed by the key that hashes to the room code (see `shared/signing.js`).

## Metrics

Each reading is folded into its target's octave and compared in cents. A part's numbers come from its live singers with confidence ≥ 60:

- **in tune:** share within ±35 cents
- **error:** median |cents|
- **bias:** median signed cents
- **spread:** IQR

**Lock-on time** runs from a target change (or the first singer arriving) until 60% of the part has been in tune for 0.5 s. The headline accuracy is the in-tune share over the last 8 s, weighted by singers.

## Privacy

- **No audio leaves the phone:** pitch is computed on-device. The choir on the big screen is synthesized from numbers, and every recording and export is labelled as such ("synthesized choir rebuilt from pitch numbers, not a recording of anyone's voice").
- **Anonymous:** no login and no names. The phone ID is random and stored only on that device.
- **Retained measurements are opt-in:** the checkbox is off by default. The JSONL export always contains group-level summaries. Per-reading rows are included only for phones that opted in, and use a join number (`singer`) instead of the device ID. Unticking the box later deletes that phone's retained rows from the presenter.
- **Public relay:** anyone who knows the room code can read the pitch numbers in that room, and could spoof a phone's readings. Presenter controls cannot be forged.

## Simulation

**Presenter → Simulate → Add 3 / 30 / 300 virtual singers**, or bookmark `?room=CODE&present&sim=300`.

Virtual phones run the real `ChoirSession` protocol and signature checks over an in-memory bus with 2% loss and up to 80 ms jitter. Their singers react after 0.2–0.7 s, glide in, wobble with vibrato, and pick a low or high octave. In songs they anticipate the next note by 300 ms.

With chaos on:

| Behaviour | Share |
| --- | --- |
| Sing in another octave, with detector octave slips | 6% |
| Sharp | 4% |
| Flat | 4% |
| Lost | 3% |
| Noisy (dropouts, low confidence, stray pitches) | 6% |
| Breathy pauses | 5% |
| Muted mic | 3% |
| Mic denied | 2% |
| Leave | 5% |
| Drop and return | 5% |
| Join late | 10% |

**Remove virtual singers** forgets them at once.

## Tests

```sh
node --test tests/                 # Voice Choir + Human Pixels, ~45 s
node --test tests/voice-choir.test.mjs
```

The tests cover:

- **YIN:** within 5 cents at 70–880 Hz at 44.1 and 48 kHz. No octave errors with weak fundamentals or strong harmonics. Within 25 cents at 10 dB SNR. Low confidence on white noise.
- **Tracker:** noise gate, confidence gate, one-frame octave slips folded back, sustained leaps accepted, median summaries.
- **LeakGuard:** our tone is dropped (including 200 ms Bluetooth latency plus tail), a synthetic sine is rejected as machine-steady, and human hums with vibrato or a steady-but-off-pitch singer are kept.
- **Rounds:** the four songs in order, all six lines of *Twinkle*, loops, rests, harmony below the melody, canon delays, chord voicing.
- **Pause:** silent while paused, a two-beat count-in on resume, resuming mid-note, carrying on from there; Restart goes back to the top.
- **Room and protocol:** balanced groups, a returning phone keeps its part, octave-folded scoring by sample time despite 400 ms latency, duplicate and reordered readings ignored, convergence timing, clock offset, batching, heartbeat, bounded offline buffer.
- **JSONL:** group summaries for everyone, per-reading rows only with consent, no IDs, withdrawal forgets.
- **Simulations at 3, 30 and 300 phones** (real time, 5% loss, 60 ms jitter): in-tune accuracy above 0.6 in unison and chord rounds; parts lock on after each change; ≤10 messages per phone per second; muted and denied phones counted; groups balanced. A 30-phone song run checks timing (accuracy above 0.4; a clock mismatch would score near 0).

Typical results:

| Phones | Unison | Chord | Lock-on |
| --- | --- | --- | --- |
| 30 | 0.73–0.77 | 0.79–0.83 | 1.3–2.9 s |
| 300 | 0.69–0.71 | 0.80–0.82 | — |

The 300-phone ceiling is about 0.8 because the sharp, flat, lost and noisy roles can never be in tune. The song run scores 0.57–0.64. Runs at 300 phones send 1.7 messages per phone per second.

## Test checklist

Verified on 23 Oct 2026 with Chromium (Playwright). A synthetic hum WAV was fed in as the fake microphone over the live public broker:

- [x] Presenter creates a room and goes `Live`; the QR code, room code and link are shown; the QR toggle works.
- [x] Real sensor events: the phone detected the hum as A3 at 218.7 Hz ("In tune", 100% confidence) and showed the next segment as A2 at 110.1 Hz with a "−1 oct" tag. Readings crossed the public relay with about 440 ms latency; the presenter showed `singing 1`.
- [x] Leak protection: the drone gated 47 mic frames in 3 s, and the machine-steady filter had zero false positives on the vibrato hum.
- [x] Hold to hear: output reaches full level in 30 ms and falls to silence 10 ms after release (checked by logging the gain automation). Keyboard hold works too.
- [x] *Happy Birthday* at the default 50 bpm: a 250 ms pip at each note change. Pause gave no pips in 4 s, the phone showed "Paused by the presenter", and the HUD showed "· paused". Start resumed with 4 pips in the next 6 s, including the count-in.
- [x] Missing permission: in a browser that refuses the mic, the phone shows "Microphone blocked…", *Listen along*, and a *Blocked* level. The presenter counts it under *muted / no mic*.
- [x] Layout at 375×667 and 390×844, in light and dark: no horizontal scroll, and all three lines are visible.
- [x] 300 virtual singers plus one real phone: the presenter holds **60 fps** with 568–602 msg/s. Before the threads moved to an incrementally scrolled buffer it ran at 17 fps.
- [x] Unison, chord and song rounds render converging ribbons; round changes keep past threads on their old targets.
- [x] Record → Export: mono Opus WEBM at about 13 kb/s (about 6.7 kB for 4 s), VP9 + Opus WEBM of the ribbons with the HUD and synthesis label, and JSONL. Files were checked with `ffprobe`.
- [x] Reveal scorecard on screen and per-phone result; replay; removing virtual singers.

Still to do on real hardware (not possible here):

- [ ] **iPhone Safari over HTTPS:**
  - Mic prompt appears on *Start singing*.
  - Deny it: the listen-along mode works.
  - Allow it: check whether the guide tone plays through the earpiece instead of the speaker. iOS uses the play-and-record route while the mic is open; headphones avoid this.
  - Lock the screen, take a call or switch apps: "Audio paused" appears, and tapping resumes.
- [ ] **Android Chrome over HTTPS:** frames at ≥20 fps in the diagnostics line; Bluetooth earbuds (`outputLatency` is reported, so check that the gate covers it).
- [ ] **Real voices:** low male hums (80–110 Hz), children, whistling, and singing near a loud presenter speaker. The choir from the PA can leak into phones while their singers are silent. Keep the choir moderate, and use **Recalibrate** if a phone shows pitch while you are quiet.
- [ ] **Room scale:** 30+ phones on venue Wi-Fi. Watch `msg/s`, `latency` and *away*; if the public broker throttles, put a private broker first in `BROKERS` in `shared/mqtt.js`.
- [ ] **Projector:** ribbon contrast from the back of the room in both themes.

## Known limitations

- **WebM duration:** Chrome's MediaRecorder writes WEBM without a duration header. Files play everywhere, but some players cannot seek them. Safari records MP4 instead of WEBM.
- **Machine-steady filter:** a singer who holds an exactly equal-tempered note with under 1.5 cents of wobble would be ignored. That is rare in practice, and it is the price of rejecting loudspeakers.
- **Folding:** an out-of-tune singer more than 6 semitones from the target reads as close to the *other* octave. The hint still points the shortest way.
