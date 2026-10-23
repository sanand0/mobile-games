# Human Pixels

A collaborative handwriting game for 3 to 300 phones. Each phone is given one letter of a 300-letter paragraph. Participants trace it by tilting the phone: holding the big button inks, and releasing it lifts the pen. The presenter screen shows every box live, so the paragraph appears as people write. The app adds spaces and punctuation automatically; participants only ever get A–Z.

> AI IS A TEAM SPORT. WORK WITH EACH OTHER. ASK GREAT QUESTIONS. STAY CURIOUS. … NOW WE WRITE THE FUTURE TOGETHER.

## Files

| File | Purpose |
| --- | --- |
| `human-pixels/index.html` | Landing, participant and presenter views (plain HTML/CSS/JS module) |
| `human-pixels/human-pixels.js` | Core with no DOM: paragraph, stroke font, layout, roster/assignment, wire protocol, presenter signing (from `shared/signing.js`), legibility score, SVG/JSONL export, virtual participants |
| `shared/mqtt.js` | Reusable MQTT 3.1.1-over-WebSocket client (ported from `tidel-garden/index.html`) plus an in-memory `LocalBus` for simulations |
| `shared/tilt-pen.js` | Reusable Air Ink tilt pen: iOS permission, relative tilt, smoothing, speed-based ink width, hold button, finger fallback, diagnostics |
| `tests/human-pixels.test.mjs` | Node tests, including 3/30/300-participant simulations |

## Run and deploy

ES modules and WebCrypto need `http(s)://`; `file://` does not work. Phones need **HTTPS** for motion sensors.

```sh
# Local (desktop testing; phones on the LAN will lack sensors without HTTPS)
uv run python -m http.server 8765 --bind 127.0.0.1    # from the repo root; open http://127.0.0.1:8765/human-pixels/

# Deploy: any static HTTPS host. Copy human-pixels/ and shared/ side by side.
# GitHub Pages: push the repo and enable Pages; the URL is https://<user>.github.io/<repo>/human-pixels/
```

There is no server to run. Messages go through public MQTT brokers (`broker.emqx.io`, with `test.mosquitto.org` as the fallback). The QR image comes from `api.qrserver.com`. The page also loads Google Fonts and Bootstrap Icons from jsDelivr.

## How a session runs

1. The presenter opens `human-pixels/` and clicks **Create a room**. This browser generates an ECDSA P-256 key and stores it in `localStorage`. The room code is a hash of the public key.
2. The audience scans the pinned QR code, which links to `?room=CODE` (no secrets). Phones join in order: A, I, I, S, A, T… Each phone sees its letter in context (for example, the **T** in TEAM) over a tracing guide with numbered starting dots.
3. Phones tap **Start drawing**, which prefers tilt. On iPhone, both motion permission requests start inside this tap. The pose at that moment becomes the centre, and **Recenter** resets it at any time. If no orientation events arrive within 2.5 s, or permission is denied, the phone switches to finger drawing. The **Recenter** button then pulses until tapped. The **Finger / Tilt** button in the tools row switches modes at any time; switching back to tilt asks for a recenter again.
4. The presenter presses **Start**. Before that, phones can move the cursor but ink is locked.
5. The presenter grid shows only the sentences reached so far (**Grow with crowd**), or the **Whole paragraph**.
6. **Reveal** shows the whole paragraph and puts the faint printed letter in every box that is empty or below the legibility threshold. **Replay** animates every stroke in reading order using the original timing. **Export** saves PNG/SVG artwork, plus JSONL motion traces from participants who opted in.

Presenter controls on the grid:

- **Show ink or printed letter:** click any box, or select it with the arrow keys and press Enter. Use this when a participant drops out or a drawing is unreadable.
- **Fix unreadable:** does the same for every low-scoring box at once.
- **All ink:** puts everyone's ink back.

Hovering a box shows its status, input mode, point count, fit score and reassignment count.

### Joining, dropping out, rejoining

- A phone that is silent for 12 s shows as *away* (dashed box). After 30 s it is *gone*, and its letter goes to the **next person who joins**. Gone letters are filled before any unassigned letter.
- Letters are kept, not reassigned, if the participant pressed **Done** or the ink already scores as legible.
- A phone that reloads or reconnects keeps the same anonymous ID (`localStorage`) and its ink. If its letter was reassigned meanwhile, it gets the next available one.
- When every letter is taken, newcomers wait and get the next letter that frees up.
- A presenter reload restores the roster and ink from `localStorage`, then broadcasts `hi` so phones re-announce themselves. If storage is full or cleared, phones reclaim their slot and resend their ink.

## Protocol (topic `human-pixels/v1/<ROOM>/…`)

| Direction | Topic | Messages |
| --- | --- | --- |
| phone → presenter | `up` | `hello`, `ink {e, k, p[], c}`, `hb {e, n, c}`, `done`, `bye` |
| presenter → one phone | `c/<id>` | `assign {slot, letter, word, have}`, `need {from}` (signed) |
| presenter → all | `all` | `state {phase, round, live}` every 2 s, `hi` (signed) |

- **Ink:** each phone keeps an append-only point list per *epoch*. A point is `[x, y, r, t, start]`: x, y and r are in thousandths of the cell, and t is in ms. Undo and clear start a new epoch.
- **Sending:** phones send only new points, in chunks of up to 150, at about 6.7 Hz while drawing. While idle they send a cursor/heartbeat message at most every 3 s.
- **Resync:** on QoS 0, the presenter detects gaps (`k > have`) or heartbeats that are ahead, and asks for a resend from where it has data. Phones never receive other participants' data.
- **Authenticity:** phones accept presenter messages only if they are signed by the key whose hash is the room code. Messages older than 10 minutes are rejected.

## Privacy

- **No accounts:** no login, name or account. The phone ID is random and stored only on the device.
- **What leaves the phone:** only pen points and cursor position, at 5–10 Hz. Raw sensor streams never leave the phone.
- **Research traces:** these are opt-in, and the checkbox is off by default. It is shown only before the phone starts drawing. Only participants who opt in add relative tilt angles (β, γ, 0.1° precision) to their points. The presenter's JSONL export contains only those participants, with no client IDs (fields: `letter, input, platform, fields, units, points`). Tilt values from participants who did not opt in are discarded on arrival.
- **Public relay:** the brokers are public, so anyone who knows the room code can read the room's topics, and a determined attacker could spoof a participant's ink. Presenter controls cannot be forged. Do not use this game for sensitive content.

## Simulation

**Presenter → Simulate → Add 3 / 30 / 300 virtual phones**, or bookmark `?room=CODE&present&sim=300`. **Simulate → Remove virtual phones** frees their letters and ink at once (also after a presenter reload, since virtual ids are recognisable). Real participants who have not inked yet move down into the freed letters, so *Grow with crowd* shrinks back to the real crowd. Real participants with ink keep their letter. Virtual phones run the real `ParticipantSession` protocol and signature checks over an in-memory bus with 2% message loss. With *chaos* on, about 8% scribble, 6% have no sensors (finger, shakier), 6% leave for good, 6% drop and return, and 15% join late, after the leavers' letters free up.

## Tests

```sh
node --test tests/                  # 13 tests, ~10 s
```

The tests cover:

- **Text and layout:** exactly 300 letters, word-safe wrapping, layout bounds at 3/120/all characters on desktop and phone sizes, and stroke-font bounds.
- **Legibility:** traced letters score ≥ 0.8, while scribbles and tiny letters score below `LEGIBLE` (0.55).
- **Roster:** removing virtual phones frees their letters and compacts inkless real participants; join order, rejoin, done letters kept, dropped letter reassigned to the waiting list, and a returning participant moved to the waiting list.
- **Lossy network:** with 35% message loss, plus undo, the presenter's ink converges to exactly the phone's ink.
- **Signatures:** valid signatures are accepted; tampered ones, other rooms' keys and swapped keys are rejected; the private key never appears in messages.
- **JSONL export:** opt-in only, with no IDs.
- **Simulations:** full runs at **3, 30 and 300** participants with all failure modes. These check unique ownership, reassignment, ink identical between phone and presenter, and no illegible box left after auto-fix. They also check that the SVG contains all 392 non-space characters.

## Test checklist

Verified on 23 Oct 2026, with Chrome desktop and mobile emulation against the live public broker:

- [x] Presenter creates a room and connects (`Live`); QR, code and link are shown.
- [x] Participant at 390×844 and 375×667: compact header, letter in word context in the footer, tracing guide, no horizontal scroll, light/dark themes.
- [x] Synthetic `deviceorientation` events move the cursor relative to the starting pose, and holding the button inks (220 points crossed the public relay to the presenter).
- [x] Missing sensor: no events for 2.5 s triggers finger mode; finger strokes arrive.
- [x] Reconnection: socket killed mid-stroke, 104 points drawn offline, then auto-reconnect; the presenter caught up to 386/386.
- [x] Phone reload restores its letter and ink; presenter reload restores roster and ink.
- [x] 300 virtual phones in the browser: the paragraph grows by sentence, reassignment works, about 60–120 messages/s, smooth rendering.
- [x] Reveal + fix: Tesseract OCR of the revealed 300-letter screen read 299/300 letters (the "AI" was read as "Al").
- [x] Notifications have a close button; Finger/Tilt toggle switches modes silently; starting tilt pulses the Recenter button until tapped (no message or notification); footer lines stay one line (ellipsis), so the layout never jumps.
- [x] Replay animation, PNG (2560×1440), SVG and JSONL exports, and keyboard toggling (arrows + Enter).

Still to do on real hardware (not possible here):

- [ ] **iPhone Safari over HTTPS:** permission prompt on *Start drawing with tilt*; deny, then fall back to finger; allow, then the cursor follows the tilt; Recenter; locking the screen mid-stroke lifts the pen; returning re-announces the phone.
- [ ] **Android Chrome over HTTPS:** event rate shown in diagnostics (expect ≥ 15 Hz); landscape rotation swaps axes correctly.
- [ ] **Room scale:** 30+ real phones on venue Wi-Fi; check whether the public broker throttles (watch `msg/s` and the away count). If it does, edit `BROKERS` in `shared/mqtt.js` to put the fallback or a private broker first.
- [ ] **Projector:** legibility from the back of the room in both themes.
