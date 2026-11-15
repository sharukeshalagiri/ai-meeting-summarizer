# Demo video script (2 minutes)

A shot-by-shot script for a screen recording of the seeded demo. Every
meeting in it is synthetic (`npm --prefix backend run demo:seed`), so the
video can be published as is.

**Setup before recording**

- Backend with `DEMO_MODE=true`, `demo:seed` run, frontend open at
  `/login` in a clean browser window (1280×800, zoom 100%, bookmarks
  bar hidden). Sound on: the chips play the recordings.
- For shot 7, the Chrome extension loaded and a test Meet tab open (or
  skip shot 7 and use the still `docs/images/summary-lecture.png`).
- Record the screen and the voice-over separately; the timings below
  leave room for the cuts.

| # | Time | Screen | Action | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:10 | Sign-in page | Cursor rests near **Try the demo**. | "Meetings end, and the one thing you needed is buried in an hour of audio. This is a meeting companion that keeps the receipts." |
| 2 | 0:10–0:22 | Sign-in → lecture page | Click **Try the demo**. The lecture opens: player, TL;DR, tasks. | "No sign-up: this is a read-only demo with three synthetic meetings. Here's a lecture on hash tables." |
| 3 | 0:22–0:40 | Lecture summary | Scroll slowly to **Exam questions**. Hover the "Flagged by the lecturer" item, then click its **Professor ▶** chip. | "It doesn't just summarize. It found the two things the professor said will be on the exam, and every item cites the moment it was said." |
| 4 | 0:40–0:55 | Transcript tab, highlighted line, audio playing | Let the line play for 4–5 seconds. Point at **Hide noise** and the folded "small talk" pills. | "One click plays the recording from that exact line. Small talk and asides are labelled as noise, so they never end up in the summary." |
| 5 | 0:55–1:15 | **Search feature planning** meeting | Back to meetings, open the project meeting. Show **Tasks**: owners, "by Friday" resolved to a date, one task completed. Click Marcus's chip on the endpoint task. | "A project sync: one decision, five tasks with owners and deadlines, as spoken and resolved to real dates. 'By Friday' is a date you can act on." |
| 6 | 1:15–1:30 | **Backend engineer interview** | Open the interview. Show **Questions and answers**, **Strengths**, **Concerns**; point at a **Needs review** badge. | "Each kind of meeting gets its own sections: for an interview, the questions, how they were answered, strengths and concerns. Anything the model is unsure about is flagged for review." |
| 7 | 1:30–1:45 | Chrome extension popup on a Meet tab, then the desktop recorder tray | Click **Start** in the popup; cut to the tray icon. | "Capture works where you already meet: a Chrome extension for Meet, Zoom or Teams in the browser, and a desktop recorder for the Zoom app. Both send the same stereo audio: my mic on the left, everyone else on the right, so I'm always labelled correctly." |
| 8 | 1:45–1:55 | README accuracy section | Scroll the README to **Accuracy**. | "And it's measured, not eyeballed: summaries are scored against answer keys, including things that must never appear." |
| 9 | 1:55–2:00 | Sign-in page, repo URL as a lower third | End card. | "The code is on GitHub. Try the demo, or run it on your own laptop." |

**Notes**

- Don't click Upload, Delete, Re-summarize or a speaker rename on camera:
  the demo refuses them (that is the point of read-only mode, but it
  reads as an error in a video).
- If the recordings were generated with tones (no text-to-speech on the
  seeding machine), re-seed on Windows (SAPI) or with `espeak-ng`
  installed before recording shot 4.
- Shot 5 goes back through the **Meetings** list. Until the meeting
  list renders schemaVersion 2 summaries (see the w5-demo PR), open the
  project meeting from its URL instead.
- Keep the accuracy shot honest: if the README says "Not yet measured",
  say "measured against answer keys" without quoting a number.
