# Prompts

## Human pixels, 23 Oct 2026

<!--
cd ~/code/mobile-games/
claude --model opus --effort medium
-->

Add **Human Pixels** at human-pixels.html - a collaborative handwriting game.

The presenter has a grid of canvases and as each participant joins, they are assigned the next position.
Each participant is assigned one letter based on a paragraph. "AI IS A TEAM SPORT. WORK WITH EACH OTHER." (Extend this to a 300-letter paragraph with short, simple words.)
As people join, they are assigned the next letter. Automatically add spaced and punctionation in the presenter view - don't assign them to participants.

Everyone sees their assigned letter with a faint guide and traces it by tilting their phone, holding a large button to draw and releasing to reposition.
See `~/code/tds-network-games/` - specifically AI Ink - for a working example. This works quite well, so use this as the basis.

Use relative tilt calibration, smoothing and clear cursor feedback. Reuse the Air Ink interaction where appropriate.

On the presenter screen, show everyone's strokes live. They should be able to see the words forming as they draw.
This will gradually reveal the complete sentence as participation grows.
If a participant drops off, re-assign their letter to the next participant who joins. If a participant joins late, they should be assigned the next available letter.
Allow the presenter to toggle any canvas between the participant's strokes vs the actual letter (drawn a bit faintly) in case participants drop off and cannot rejoin or the drawing is too bad.

Add animated replay, downloadable SVG/PNG artwork and optional anonymous JSONL motion-trace export for future ML experiments.

Make it work with 3, 30 or 300 participants.
Simulate late joins, missing sensors, disconnects, rejoins, and unreadable drawings. Verify the final sentence remains legible.

---

A few changes:

As a presenter, after I simulate 300 people, how do I get back to the view where I only have as many canvases as real people?

As a user, when I join:
- The header occupies too much space. The "Human Pixels" navbar is fine, but the "A" or the letter below it occupies too much space. Since the letter is anyway visible on the canvas, maybe we can delete that entire box? Other indicators (like letter 1/300, 1 person writing) could be in the header navbar or footer.
- The "Optional: also share..." is too verbose. Shorten to 1-2 lines, not the 4 lines it has now.
- Allow me to toggle between drawing by finger or by tilt at any time, rather than having to choose up-front. Prefer tilt.

Since there are multiple files, let's move this into `human-pixels/{index.html,human-pixels.js,README.md}`.
Similarly, move pendulum-gravity.html to pendulum-gravity/index.html and tidel-garden.html to tidel-garden/index.html.

--- <!-- steering -->

Include a close icon for the notifications near the bottom.

---

Ensure that the footer (showing the tilt, etc.) never takes up more than 1 line. Else it can change the screen layout, causing a jump.
Also, nudge the user to recenter first.
Drop the notification that appears when I switch between tilt and finger.

---

Drop the notification after recenter (Center Set), etc.
"Hold the phone comfortably..." is too prominent. Drop it. The "Recenter" button highlighting is enough.

<!-- claude --resume 8e3c68f7-f9a9-4f6f-b4de-5ae86130d4ae -->
