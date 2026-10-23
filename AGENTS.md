These are collaborative mobile-browser games for 2 to 500 people, in-person or remote.

Each features:

- Mobile-first static HTML pages and a presenter dashboard.
- One QR code and room URL, with an option to pin prominently on the presenter dashboard.
- Anonymous participants, no login.
- Public MQTT relay for live collaboration.
- Browser sensor permission, calibration, diagnostics and reconnection.
- Participant views that are simple, clear and visually delightful.
- Presenter controls: start, pause, reset, reveal, replay and export.
- Secure presenter controls; do not expose control credentials in the audience URL.
- Efficient communication: send small sensor summaries at 5–10 Hz, not raw sensor streams. Never broadcast all participants' raw data to everyone.
- Permission and functionality fallbacks for iPhone Safari and Android Chrome.
- Optional, explicit consent for retaining anonymous measurements.

See existing code for examples.

Keep implementation minimal: plain JavaScript, HTML and CSS where possible.
Prefer one reusable connection and sensor module over separate implementations.

Provide a simulation mode, tests with up to 300 virtual participants, deployment instructions and a documented test checklist.
Test responsiveness, actual sensor event arrival, reconnection, and presenter visuals.
