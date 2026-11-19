# Desktop annotation session (`hyprscope message annotate`)

English | [中文](/docs/plugin/ANNOTATE.zh.md)

`hyprscope message annotate` is the visual + voice input surface: the host freezes the screen, marks a few regions, holds a key and speaks, and the agent receives one ordinary user message containing the geometry and the words. This page is that surface's design contract. It is deliberately not a second wire format: the session directory, the time base, the file shapes and the pairing table are normative in [PROTOCOL.md](/docs/cli/PROTOCOL.md) §11, and the plugin's tools, settings and degradation story are in [DSH-PLUGIN.md](/docs/plugin/DSH-PLUGIN.md). What this page fixes is ownership, the constraints that follow from it, and the platform boundary an implementation must keep.

## 1. Positioning and boundaries

The surface exists to remove one class of ambiguity from a request: "this thing, here, looks wrong". A screenshot alone leaves the agent guessing which pixel the user means; a text message alone loses the place. The annotation session carries both, but keeps them apart: the picture stays clean and the intent travels as numbers.

| Surface | Owns | Never does |
|---|---|---|
| Quickshell overlay | painting the frozen image, drawing shapes, push-to-talk, the review card, writing session files | capture, recording, transcription, prompt injection, desktop mutation |
| DSH plugin | capture, context, recording, transcription, pairing, the intent card, prompt admission | drawing, taking a lease, changing desktop state, typing into another window |
| CLI | starting the overlay and writing the one request file | owning the session, reading the microphone, injecting |

The overlay is a paint-and-file surface. It never takes a lease, never calls `hyprctl`, never records audio and never captures the screen; every capability it needs has already happened on the plugin side or has been written into `session.json`. Conversely the plugin never draws a pixel and never decides a shape: it reads the geometry the overlay wrote and trusts it. The CLI is the smallest part: `hyprscope message annotate` starts the single-instance overlay, writes `open.json` with `mode: "annotate"`, and exits. Nothing else in the session is the CLI's business.

This is also why the surface can be safe without a consent card: the only thing it changes is the user's own message to their own agent. It adds no tool, no permission and no route to the control surface.

## 2. One session clock

A session has one origin — its `t0` — and one unit.

- `startedAt` is `t0`: the absolute epoch-millisecond instant of the trigger. The plugin writes it once into `session.json`; every later document refers to it and never redefines it.
- Every `at`, `atStart` and `atEnd` in the session documents is an absolute epoch-millisecond instant from the same machine clock; the two older exceptions, `open.json.at` and the desktop-message `ack.json.at`, stay ISO-8601 strings. The card derives `t = at - startedAt` for display, and nothing else converts.
- `audioStartedAt` is the absolute instant of sample zero of the recording. It is `null` when no recorder could start; a session without voice is still a session.
- Byte offsets are derived, never stored: 16 kHz mono s16le is 32 bytes per millisecond, so the offset is `(at - audioStartedAt) × 32`, clamped to the bytes that exist.

The rule matters because three processes share the session — the overlay, the plugin and the read-only CLI. A relative timestamp would make each of them add its own clock, and a drift of a few hundred milliseconds would silently change which annotation a phrase binds to. Absolute instants in the session documents leave exactly one conversion point (the card's `t`) and one source of truth (`startedAt`).

## 3. Geometry, not raw input

The annotation record is geometry, not a recording of the pointer.

- A shape is a `rect`, an `ellipse` or an `arrow`, stored as `from`/`to` in the screenshot's own image pixels, plus a display `index`, a time range and an optional comment.
- The overlay converts screen coordinates to image coordinates with the monitor scale on write and back on display; the plugin and the agent only ever read image pixels.
- The window a shape refers to is resolved by hit-testing the global screen point against the window rectangles in `session.json.context`; the result is an optional `windowId`, never a requirement.
- No pointer trajectory, click stream, keystroke or raw input event is recorded. Push-to-talk uses Space and the review card uses Enter/Esc; those are the only keys the surface observes, and they are not part of the record.
- The screenshot is immutable evidence. Comments and shapes are metadata; they are never burned into the PNG, so the agent can crop, re-read or compare the image without the marks hiding the pixels underneath.

The user's marks are authoritative intent, and the geometry is what the agent acts on. A comment that says "this button" is ambiguous; a rectangle plus a window id is not.

## 4. Voice pipeline

Voice is recorded continuously and transcribed per phrase, never streamed.

1. Recorder: the plugin spawns `parec` with 16 kHz mono s16le settings and falls back to `arecord`; the raw PCM goes to `audio.pcm`, and `audioStartedAt` records sample zero. If neither recorder starts, the session continues without audio.
2. Push-to-talk: holding Space opens one segment in `voice-events.json`; releasing it closes the segment with absolute `atStart` and `atEnd`. The overlay writes the segment, the plugin cuts it from the PCM.
3. VAD: each cut segment is scored in 20 ms frames; a 300 ms silent run ends a phrase, a phrase with less than 200 ms of voiced audio is dropped, and each surviving phrase is padded by 200 ms on both sides, with neighbours splitting a shared gap instead of overlapping.
4. WAV: every phrase is encoded as a canonical RIFF/WAVE file with a strict 44-byte header, so the transcriber never has to guess the format.
5. Transcription: each phrase is sent separately to the Host's `speechToText` service (a SenseVoice provider in the current Host) with the session language; the call is non-streaming and bounded at 30 seconds, and its result — text, duration, error and phrase boundaries — lands in `voice/<id>.json`.

Transcription happens after a phrase ends, not while the user speaks, and the phrase — not the whole push-to-talk segment — is the unit the agent sees. That choice follows from the review card: the user can edit one phrase without losing the rest, and one segment can describe two different annotations.

## 5. Alignment rules

Pairing is a best-effort interpretation with an explicit confidence, never a silent guess.

| Rule | Condition | Confidence | Source |
|---|---|---|---|
| 1 | Exactly one annotation overlaps at least 60% of the shorter interval | 0.9 | `overlap` |
| 2 | Several annotations overlap; the largest wins and the link is flagged ambiguous | 0.6 | `overlap` |
| 3 | No usable overlap, but the phrase anchor names an existing annotation | 0.8 | `anchor` |
| 4 | Otherwise, the nearest annotation starts within 2 seconds after the phrase | 0.5 | `sequence` |
| 5 | Nothing matches | — | no link, a global note |

Three design rules sit on top of the table. The threshold is measured against the shorter interval, so a short "this one" spoken while drawing a long arrow still binds. The anchor is a deliberate fallback: it uses what the user had selected or was drawing when the key went down, which survives a pause before speaking. A manual rebind in the review card is authoritative — the submitted `annotationId` replaces the automatic result with confidence 1 and source `manual`, and `null` turns the phrase into a global note.

Ambiguity is surfaced, not hidden: an ambiguous link is shown in the review card before submission, and the user can re-bind or leave it unbound. The agent sees the confidence and the source in the card, so it can ask instead of assuming.

## 6. Clean image and intent card

The default artifact is a clean screenshot plus a deterministic text card; the marks exist only as text.

- The card opens with the counts and the statement that the image is clean and the geometry is authoritative.
- It prints the monitor, scale, pointer, focused window and the visible windows in z order with their rectangles.
- Each annotation appears with its `t` range, image rectangle, screen equivalent, hit window and comment; each phrase appears with its `t` range, text and either its bound annotations or "unbound, global note".
- The user's overall note and the final edited transcripts close the card.
- The clean PNG is attached after the text. The card is capped at 8000 characters and the image at 8 MiB; when the image is skipped the card says so and the geometry remains complete.

The card is deterministic on purpose: the same session files must always produce the same prompt. It is generated by the plugin from the submitted files, not by the model and not by the overlay, so the agent's input is reproducible and reviewable.

## 7. Failure and degradation

Failures are local: a missing optional piece narrows what the user can do, it never corrupts the session or blocks the surviving paths.

- No Wayland session or no Quickshell: the CLI fails with `NO_SESSION` or `OVERLAY_FAILED` and writes no request.
- DSH not running: the overlay says so and does not open a session; the request is not silently queued.
- No `parec` and no `arecord`: `audioStartedAt` stays `null`, every transcript carries an error, and typed comments still reach the agent.
- No `speechToText` service or a failed transcription: the phrase keeps its error and empty text, the review card asks the user to type the words, and submission is not blocked.
- Screenshot over 8 MiB or unreadable: the prompt travels as text only and the card states that the screenshot is not attached.
- User cancel, overlay death or a quit request: the plugin stops the recorder, cleans child processes and removes `active.json`; no microphone is left open and no prompt is injected.

The rule behind all of them is the same: the session directory is the only state, and an incomplete session is recoverable by reading what exists. Nothing is held in memory that a crash could leave ambiguous.

## 8. Limits

| Limit | Value | Why |
|---|---|---|
| One push-to-talk segment | 60 seconds | keeps one cut, one VAD pass and the review card bounded |
| Attached screenshot | 8 MiB | a prompt image has to stay within the Host's admission budget |
| Intent card | 8000 characters | the agent must read the geometry without truncating it in a model context |
| Visible windows in context | 24 | keeps the window list readable; z-order and intersection still make the cut |
| One transcription call | 30 seconds | a stuck provider must not hang the session |

## 9. Platform adapter

The design is portable only if the platform-specific parts are named. An adapter provides five capabilities and nothing else:

| Capability | Responsibility |
|---|---|
| `capture` | produce the clean screenshot of the monitor under the pointer, with pixel size, layout rectangle, scale, transform and hash |
| `windows` | report the focused window and up to 24 intersecting windows in z order with their rectangles and workspaces |
| `recorder` | start and stop raw 16 kHz mono s16le PCM and report the absolute instant of sample zero |
| `overlay` | start one overlay, give it the session directory, and stop or detect its death |
| `hotkey` | register the annotation trigger and report the normalized key the user sees |

Phase 0 implements all five on Linux/Hyprland: Wayland capture through the read-only CLI, Hyprland window metadata, `parec`/`arecord`, the Quickshell overlay and a compositor bind installed by `hyprscope control install-bind`. The adapter boundary is a design obligation, not yet a package: the Hyprland implementation lives behind these five operations today.

Phase 1 defers, deliberately:

- the extracted adapter interface as a separate module with a conformance test;
- non-Linux capture and hotkey backends (X11, macOS, Windows), including portal/PipeWire capture instead of compositor-specific capture;
- a compositor-independent hotkey path that does not require a config file and a reload;
- an overlay toolkit other than Quickshell;
- streaming transcription and a transcription path that can start before push-to-talk ends;
- multi-monitor spanning capture, annotation of a window rather than a monitor, and audio-device selection.

None of the deferred items changes the session contract: they replace an implementation behind the same five capabilities, and the files, clock, geometry and pairing rules stay as they are.

## 10. Related contracts

- [PROTOCOL.md](/docs/cli/PROTOCOL.md) §11 — the normative session files, time base, records, pairing table, submission and overlay states.
- [DSH-PLUGIN.md](/docs/plugin/DSH-PLUGIN.md) — the plugin half: tools, bridge, settings and the degradation it documents.
