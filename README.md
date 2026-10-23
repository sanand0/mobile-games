# Mobile Games

Collaborative browser games for 2 to 300 phones, in person or remote. The presenter opens a room on a big screen, everyone scans one QR code, and the phones' motion sensors and microphones become one shared instrument. No app, no login, no server: phones talk through a public MQTT relay.

**Play: <https://sanand0.github.io/mobile-games/>**

| Game | What happens | Sensor |
| --- | --- | --- |
| [Human Pixels](https://sanand0.github.io/mobile-games/human-pixels/) | Each phone traces one letter by tilting; together the room writes a paragraph. ([details](human-pixels/README.md)) | Tilt |
| [Voice Choir](https://sanand0.github.io/mobile-games/voice-choir/) | Each phone hums a target note; the presenter screen shows voices converging into chords. Pitch is detected on the phone; no audio is uploaded. ([details](voice-choir/README.md)) | Microphone |
| [Tidal Garden](https://sanand0.github.io/mobile-games/tidel-garden/) | A shared generative artwork: tilt bends currents, sway grows light, shake releases blooms. | Tilt, sway, shake |
| [Gravity Lab](https://sanand0.github.io/mobile-games/pendulum-gravity/) | Time a pendulum with the motion sensor or a stopwatch and calculate Earth's gravity. For Classes 6–8. | Motion or stopwatch |

## Run locally

Pages need `http(s)://` (ES modules, WebCrypto, sensors). Phones need HTTPS for motion and microphone access.

```sh
uv run python -m http.server 8765 --bind 127.0.0.1   # open http://127.0.0.1:8765/
node --test tests/                                    # simulations with up to 300 virtual participants
```

## Deploy

Every push to `main` publishes the repository as static files to GitHub Pages via [`.github/workflows/pages.yml`](.github/workflows/pages.yml). There is no build step.
