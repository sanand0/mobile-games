# Prompts

## Home page and README, 23 Oct 2026

<!--
cd ~/code/mobile-games/
claude --model opus --effort medium
-->

Create a simple home page, index.html, that links to the individual games. Use cards, semantic HTML, make it visually attractive, no thumbnails required.

Create a README.md that briefly describes these games and links to them.

Enable GitHub Pages that efficiently (i.e. quickly, lightweight containers, aligned to GitHub recommendations) publishes the HTML files at https://sanand0.github.io/mobile-games/. Commit, push, and test. Ensure that the "About" section links to the GitHub Page.

<!-- claude --resume 1f225468-3a00-40ce-954b-a9c4bc86f110 -->

## Voice Choir, 23 Oct 2026

<!--
cd ~/code/mobile-games/
claude --model opus --effort medium
-->

Add voice-choir/ - a collaborative humming and harmony game.

Like with human-pixels, the presenter opens a room and allows participants to join via a QR code. A lot of the dynamics can be borrowed from human-pixels, but the audio processing is different.

Each participant grants microphone permission after pressing Start. Analyze audio locally using Web Audio and a reliable fundamental-pitch detector such as YIN/autocorrelation. Do not upload raw audio in the default mode.

Show the target musical note and actual pitch in a meter that allows the participant to increase / decrease pitch to match the target.
Play the target note as a synthesized tone, allowing the participant to hear it and match it. Allow them to control the volume or silence it.
If they sing an octave or few above or below, adjust for that. They should be able to see that they're singing at a different octave,
I think showing three lines - target pitch, actual pitch, and pitch converted to the target's octave (visually shown differently) would work.

Subtly display the target note name, their note name, and their actual pitch in Hz. Include confidence if relevant.
Show a volume level and silence indicator.

Send only pitch, amplitude, confidence, voiced/silent state and timestamps at approximately 10 Hz.

The presenter controls the target note and musical rounds:

1. Everyone hums the same note. Presenter can manually change notes.
2. Divide participants into three harmony groups forming a chord. Presenter can change chords.
3. Sequence notes together to create a simple, short composition. Presenter can change songs and tempo.

On the presenter's screen, play the synthesized audio and show hundreds of pitches converging into visually beautiful coloured ribbons.
Measure how accurately and quickly the group converges.

Synthesize the received notes locally on the presenter dashboard into an audible live choir. Make this reconstruction recordable and downloadable as maximally compressed WEBM audio, with an animated visualization and JSONL measurements.

Handle noise, harmonics, octave errors, latency, missing microphone permission and muted participants gracefully. Test with synthetic pitches, noise and 300 simulated clients (see human-pixels/ for what presenter needs). Do not label synthesized audio as recordings of people's actual voices.

--- <!-- steering -->

Avoid the phone's own tone leaking into the signal sent. Maybe fade it after a bit; avoid sustained perfect matches if the tone is audible; ... think about the most robust way to avoid this.

---

The "Hear note" is too soft. Make it louder. Play it for as long as the hear note button is pressed and fade a second after release.
The default tempo of the song is too fast. Halve it by default. I'll increase later if required.
When the song is playing, play the "Hear note" when the note changes, briefly, maybe for 0.5 seconds.

---

Include "Happy Birthday" as the first song. Include the modern version of "Twinkle Twinkle Little Star" as the second, and "Row Row Row Your Boat" as the third, "Mary Had a Little Lamb" as the fourth. Drop the rest.
When I click on "Pause" the song should pause as well.
Reduce the release fade duration to 0, i.e. releasing the "Hear note" button should stop the sound immediately.
During a song, play the note only for 0.25 seconds.

---

I take back what I said. Play the note for 0.25s every time the note changes - not just in the song.

<!-- claude --resume e59031b2-a8a2-4d0e-9825-0bf29fca6183 -->

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
