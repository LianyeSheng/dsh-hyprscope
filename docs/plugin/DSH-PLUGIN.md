# DSH plugin for hyprscope

English | [中文](/docs/plugin/DSH-PLUGIN.zh.md)

`plugins/dsh-hyprscope/` is the project's native, plug-and-play DSH Host bundle; it turns the hyprscope CLI into six tools a model can call. Instead of composing `node bin/hyprscope.ts ...` shell commands — remembering the checkout path, the flag order and the `--json` switch, then parsing the result — a DSH session calls `hyprscope_observe`, `hyprscope_screenshot`, `hyprscope_events`, `hyprscope_plan`, `hyprscope_baseline` or `hyprscope_desktop` with typed arguments and gets a parsed object back.

The bundle is a thin wrapper, not a second implementation: every tool call runs `node bin/hyprscope.ts <command> --json` as a child process, with an argv array and no shell. The CLI keeps every gate, and the plugin adds no way around them. It is Host-only: it registers tools, not a page. It also carries a desktop-message bridge: a floating hint and a shortcut that hands one desktop-composed message, usually with a screenshot of the desktop at that moment, to the conversation without a browser page in front. A second shortcut opens a desktop annotation surface that turns a marked-up screenshot and push-to-talk speech into one structured user message.

## What it is and why

For an agent, the shell route is friction on observation and risk on control. Observation costs a chain of small mistakes to get right: finding the checkout, remembering which flags come before the positional argument, choosing `--json`, telling exit code 2 (bad arguments) from exit code 1 (any other failure), and reading failure JSON on stderr rather than stdout. Control adds the step that matters most: the consent card is shown on the host's screen and answered by the host, not by the process that wants the lease.

The bundle moves command construction back into code. The model sees six tool definitions with JSON-Schema arguments, gets one parsed object back, and on failure gets hyprscope's error code and the next step in the message. What the CLI refuses, the tool call refuses in the same way. Each tool is one subcommand:

```sh
hyprscope_observe     -> node bin/hyprscope.ts <kind> --json
hyprscope_screenshot  -> node bin/hyprscope.ts screenshot --json
hyprscope_events      -> node bin/hyprscope.ts events --json
hyprscope_plan        -> node bin/hyprscope.ts control run <plan.json | -> [--dry-run] [--lang zh|en] --json
hyprscope_baseline    -> node bin/hyprscope.ts control baseline --show|--probe [--lang zh|en] --json
hyprscope_desktop     -> node bin/hyprscope.ts control desktop <action> --json
```

An inline `plan` travels to the CLI on stdin, as `control run -`: the bundle writes no plan file and leaves nothing behind. A `planPath` is passed through as a file and read by the CLI itself.

## Installing the bundle

The bundle lives in this repository and is installed into a DSH profile; it is not published to a registry. Both ways of installing it take the absolute directory of the bundle:

- In DSH, open **Plugins**, choose **Add plugin**, and enter the local directory `/home/jw/workspace/dsh-hyprscope/plugins/dsh-hyprscope`.
- Or have the DSH agent call `plugin_manager` with `action: "install_bundle"` and `target` set to the same absolute directory.

Installation is profile-wide and survives a restart, and it links the checkout rather than copying it, so the directory has to stay where it is. The installed bundle is `@local/dsh-hyprscope`, its plugin row is `hyprscope`, and the Plugins page lists it as **Desktop observation and control**.

The install is the link. In a development checkout the web profile keeps it at `~/.dsh/profiles/web/node_modules/@local/dsh-hyprscope`, pointing at `<checkout>/plugins/dsh-hyprscope`; `$DSH_HOME` may be elsewhere, so read the link instead of assuming the path. Editing the checkout edits the file the next DSH process loads, not the copy the running Host already holds in memory.

Three requirements have to hold:

- The DSH Host runs as the same user, on the same machine, as the Hyprland session. The CLI finds the session through the per-user runtime directory, but it cannot cross a different uid or a container boundary.
- The Node running the DSH Host is version 22 or newer (the plugin defaults to that executable), and the checkout contains `bin/hyprscope.ts`. The plugin runs the CLI from this checkout; it installs no dependencies and builds no C helpers.
- The bundle declares `dsh.bundle.platforms: ["linux"]`, so DSH refuses to activate it on another Host platform. Hyprland is a Wayland compositor, so this is not a practical restriction.

After installation, the tools are available to sessions of that profile. To check the wiring, call `hyprscope_observe` with `kind: "doctor"`: it runs the read-only capability report. If the bundle cannot find the CLI, the plugin still activates, and the call fails with a message that names `projectDir`.

`doctor` also shows which code is loaded. Besides the CLI's report, the result carries two additive top-level fields: `pluginVersion`, the `version` in the bundle's `package.json` read when the Host loaded the plugin, and `cliPath`, the absolute `bin/hyprscope.ts` the plugin spawns. Compare `pluginVersion` with the checkout's `plugins/dsh-hyprscope/package.json` and `cliPath` with the checkout you expect; a mismatch means the Host is running an older in-memory copy.

## Editing the bundle

The Host loads `index.js` into its own process and does not watch the file. Editing the bundle in the checkout changes what the next DSH process will load; the running Host keeps the code and the tool schemas it loaded at startup. **Restart DSH after every plugin edit** — reloading the profile or the page is not enough when the bundle was already loaded.

Without the restart the old schema is what the model sees: a parameter added to a tool definition is absent from the schema, so passing it is silently ignored instead of rejected, and `doctor` keeps reporting the old `pluginVersion`. After restarting, call `hyprscope_observe` with `kind: "doctor"` and check that `pluginVersion` matches the checkout's `package.json` version and `cliPath` names the expected `bin/hyprscope.ts` before trusting a new parameter.

## The six tools

| Tool | Kind | What it does | Arguments |
|---|---|---|---|
| `hyprscope_observe` | Read-only | Reads the session, a snapshot or one collection; never calls `control` | `kind` (required): `doctor`, `state`, `active`, `clients`, `workspaces`, `monitors`, `layers` or `cursor`; `timeoutMs` |
| `hyprscope_screenshot` | Read-only | Captures the layout, one monitor, one region or one window; refuses while the session reports locked | `scope` (`layout` by default, `monitor`, `region`), `monitor`, `region` (`{x,y,width,height}`), `window` (`{id}` or `{app}` or `{title}`, exactly one; off-screen windows included), `output` (absolute PNG path), `allowLocked` (`false` by default) |
| `hyprscope_events` | Read-only | Subscribes to the compositor event stream for a bounded wait | `match`, `count` (1–50), `once`, `timeoutMs` (100–60000, `5000` by default) |
| `hyprscope_plan` | Control | Validates a plan as a dry run, or runs it after consent (the card lists the plan's description and steps); the run itself is the consent step and blocks until it ends; the only way these tools change the desktop | `action` (required): `validate` or `run`; exactly one of `planPath` or `plan`; `maxResumes` (0–3, `1` by default) and `consentSeconds` (5–120, `45` by default), both for `run`; `language` (`zh` or `en`) for `run` |
| `hyprscope_baseline` | Control | Inspects or measures the capability baseline that gates control; a probe that widens the accepted baseline also shows the host's confirmation card and returns after the host answers | `action` (required): `show` or `probe`; `diff` (`show` only), `readOnly` (`probe` only), `consentSeconds` (`probe` only); `language` (`zh` or `en`) for `probe` |
| `hyprscope_desktop` | Lifecycle | Starts, attaches, inspects or stops an agent desktop; never moves a user window | `action` (required): `start`, `attach`, `status` or `stop`; `size` (`start` only), `runtimeDir` (required for `attach`), `consentSource` (`chat` by default, `card`; `start` and `attach` only) |

The observation, screenshot, event, plan and baseline tools also accept `desktop` (`user`, `agent` or `external`), `signature` and `runtimeDir`, and pass them to the CLI only when set; `hyprscope_desktop` is the exception, taking `signature` and `runtimeDir` only for `attach` and no `desktop` selector. `desktop` defaults to the user's desktop; the CLI's user resolution skips the desktop this repository started, so a managed desktop cannot silently become the user's. Omitted arguments keep the CLI defaults.

The two tools that can show a consent card take an optional `language` (`zh` or `en`) and pass it to the CLI as `--lang`: `hyprscope_plan` (`run`) and `hyprscope_baseline` (`probe`). Omitted keeps the CLI default (`zh`), an unsupported value fails before the CLI starts, and CLI stdout stays English.

The three read-only tools are marked safe to run concurrently; the other three are not. Long results are compacted for the model: the text is capped at `maxRenderChars`, and an oversized list comes back as the leading items plus `total` and `omitted` counts. A compacted `doctor` report keeps its stable sections, including `pluginVersion` and `cliPath`.

## Desktop messages, the hint and the shortcut

The bundle also carries a desktop-message bridge that is independent of the tools. When the Host profile provides the `sessionController` service and `desktopMessage` is not disabled, activation writes a heartbeat and starts the Quickshell overlay in `overlay/message/`: a small pill that says DSH is running with hyprscope enabled, and a composer that receives one message from the desktop. A headless profile exposes no `sessionController`, so it simply gets no hint; the tools are unaffected either way.

The shortcuts are compositor binds, installed once by `hyprscope control install-bind` together with the failsafe shortcut: `SUPER + ALT + M` for the composer (`--message-key`) and `SUPER + ALT + A` for the annotation surface (`--annotate-key`). The installer records both normalized keys in the message state directory (`shortcut.txt` and `annotate-shortcut.txt`), so the hint shows the keys that are actually bound; until it does, the pill says the composer shortcut is not installed instead of naming a key that does nothing. The plugin never calls `hyprctl` and never edits the compositor configuration.

Pressing the shortcut runs `hyprscope message open`: it starts the overlay when it is not already running and writes one `open.json` request. On submit the composer hides every overlay surface, writes one JSON document into `outbox/`, and waits for a receipt. The bridge consumes that document exactly once, captures the layout when `messageAttachScreenshot` is true, and injects one ordinary user message through the Host's public `sessionController.prompt` with `mode: "queue"`. The composed text is the message content; the capture travels as an inline PNG block. If the route or the Session refuses the image, the bridge retries once without it. The agent therefore sees the user's text and, normally, a screenshot of the desktop at that moment; without the image it can call `hyprscope_screenshot` (layout) or `hyprscope_observe` before answering. The system-prompt section says so explicitly.

The target Session is the pinned `messageSessionId` when configured; otherwise the most recent root Session observed on the Host, remembered across restarts in `last-session.json`; otherwise the most recently active visible Session; otherwise a newly created one. Subagent Sessions are never targets. The receipt in `ack.json` tells the overlay whether the message was accepted, and the hint shows "Sent" briefly.

The shared state lives in `$XDG_STATE_HOME/hyprscope/message` (default `~/.local/state/hyprscope/message`; `HYPRSCOPE_MESSAGE_DIR` overrides it): `status.json`, `open.json`, `ack.json`, `quit.json`, `shortcut.txt`, `annotate-shortcut.txt`, `outbox/`, `last-session.json`, `overlay.log` and the `annotate/` session tree. The CLI surface is `hyprscope message open|annotate|overlay|stop` (`--json`, `--lang`). None of it takes a lease, changes desktop state or bypasses a tool gate: it paints an overlay, writes files, and types a user message through the Host's own prompt admission.

The overlay needs Quickshell and a reachable Hyprland session, and the message path needs a profile that exposes `sessionController` (the Web and Desktop bundles do). When the overlay cannot start, the tools keep working and `status.json` records the error; the heartbeat retries with a backoff, and an overlay that dies after a successful start is detected and restarted.

## Desktop annotation, push-to-talk and the intent card

The same bridge carries a second desktop surface. The annotation shortcut (default `SUPER + ALT + A`, recorded by the installer) runs `hyprscope message annotate`: the CLI starts the one Quickshell overlay and writes `open.json` with `mode: "annotate"`, and the plugin opens one session per nonce. The overlay freezes a screenshot and owns the drawing tools, the push-to-talk voice and the review card; the plugin owns the capture, the recording, the transcription and the prompt admission, exactly as it does for a composed message. Nothing here takes a lease or changes the desktop.

The bridge is created only when the Host exposes `sessionController` and `desktopMessage` is not disabled; `desktopAnnotate: false` removes only the annotation half. For voice it also needs the Host's `speechToText` service; without it the session still works with typed comments.

**Capture and context.** The plugin gives the overlay 300 ms to hide the hint and composer, then reads `state --json` through the read-only CLI and picks the monitor under the pointer, falling back to the focused monitor. It captures that monitor with `screenshot --monitor` and records the clean PNG path, its pixel size, the monitor's layout rectangle, scale, transform and hash, plus the pointer position, the focused window and up to 24 windows intersecting the capture in z order. The PNG is never drawn on; the shapes, comments and window metadata travel as card text so the agent reads geometry instead of guessing from pixels.

**Push-to-talk and transcription.** The plugin records the whole session as raw 16 kHz mono s16le PCM into the session's `audio.pcm`, preferring `parec` and falling back to `arecord`; when neither starts, `audioStartedAt` is null and the session continues without voice. Holding Space records one push-to-talk segment; each segment is cut from the PCM, split by a frame-energy VAD into phrases, and every phrase is encoded as a canonical 44-byte-header WAV and sent to the Host's `speechToText` service (`resolve` then `transcribe`, with the session's `zh` or `en` language). The transcript, its duration and the phrase boundaries land in `voice/<id>.json`; one segment may produce several phrases, and each phrase is paired separately with the annotations it describes. A segment is capped at 60 seconds and one transcription call at 30 seconds.

**Review and submission.** The review card lists every annotation and transcript. The user can edit a transcript, re-bind a segment to one annotation or to the global note, add an overall note, go back, or submit. On submit the overlay writes `send.json`, whose `segments[].text` is the user's final text and whose optional `segments[].annotationId` is the final re-binding. The bridge waits for the transcription queue (6 seconds at most), applies the edits, pairs phrases with annotations, composes the intent card and injects it through `sessionController.prompt` as one ordinary user message with `mode: "queue"`, at the same target Session the desktop-message bridge resolves. The receipt goes to the session's `ack.json`; a rejected or failed injection keeps the annotations and transcripts on screen for a retry.

**The intent card.** The text block is deterministic: a one-line header (N annotations, M phrases), a statement that the screenshot is clean and the geometry is authoritative, the monitor size and scale, the pointer and focused window, the visible windows in z order with their rectangles, then each annotation with its `t` range, image-pixel rectangle, screen equivalent, hit window and comment, then every phrase in time order with its `t` range and either its bound annotations or "unbound, global note", then the user's note. The clean PNG is attached as an inline image after the text. The card is capped at 8000 characters and the image at 8 MiB; when the image is skipped, the card says so and the agent still has the geometry.

**Configuration and degradation.** `desktopAnnotate` defaults to true and is the only switch for this surface; `messageLanguage` selects the review card and transcription language; `messageDir` (or `HYPRSCOPE_MESSAGE_DIR`) must be the same directory for the Host, the CLI and the overlay, because the session files live under its `annotate/` subtree. `messageAttachScreenshot` applies only to composed desktop messages: an annotation session always attaches its own clean monitor capture, and `attachScreenshotImage` only governs tool results. When `speechToText` is missing, no provider is prepared, or `parec`/`arecord` cannot start, the failure is local to the transcript: the overlay shows "transcription failed", the user can type the words in the review card, and the submission is not blocked. If DSH is not running, the overlay reports that instead of opening a session.

## Capturing one window

`hyprscope_screenshot` can capture one specific window instead of the layout, an output or a region. Pass exactly one selector inside `window`:

- `window.id`: a Hyprland address (`0x...`) or a foreign-toplevel identifier such as `180001c6`.
- `window.app`: the application id, which is the window class.
- `window.title`: the exact window title.

The capture uses ext-image-copy-capture rather than `grim`'s copy of the composited output, so the window is captured even when it is on a hidden workspace or covered by another window. `window` is exclusive with `monitor` and `region`, and `scope` must be omitted or `layout`; any other combination is rejected before the CLI starts. The path is read-only like the other captures: no lease, plan or capability baseline is involved, and the locked-session refusal is unchanged.

It needs the native window-capture helper, which the bundle does not build. Run `pnpm run build:capture` in the checkout once; it produces `bin/wl-capture`, and without it the CLI fails with a message that names the missing helper. The result keeps the same metadata, with `source.scope` set to `window` and `source.window` carrying `{identifier, appId, title}`.

## Capturing a consent card from an agent session

Verifying that a consent card renders needs two things at once: a CLI process that raises the card, and a screenshot taken while the card is on screen. Do not try to get both from one tool call. The two tools that show a card — `hyprscope_plan` (`run`) and `hyprscope_baseline` (`probe`) — intentionally block until the host answers or the card expires. That blocking is the consent contract, not an implementation accident: a plan run returns only after the run ends, so the model cannot fire and forget. Never make the tool asynchronous to make capture easier, and never answer the card from the agent side.

Instead, run the CLI as a background job outside the tools, then take a timed screenshot with a read-only tool call:

```sh
# background job: a no-op plan raises the consent card; the run waits for the host
printf '%s\n' '{"version":1,"id":"card-capture","reason":"card capture","steps":[{"op":"pause","ms":100}]}' > /tmp/hyprscope-card-plan.json
node bin/hyprscope.ts control run /tmp/hyprscope-card-plan.json --consent 120 --lang en
```

The background command is the CLI form of `hyprscope_plan` action `run`; the tool itself blocks the same way, which is why the capture has to run outside it. Control must already be available: a missing or stale baseline fails with `CAPABILITY` before any card appears, so probe and let the host accept it first. From the agent session, after about a second, capture the layout:

```
hyprscope_screenshot(scope: "layout", output: "/tmp/hyprscope-card.png")
```

The screenshot is read-only, so repeating it is safe; timing is the only constraint: wait for the card to appear and stop before the consent window closes. Answer the card or let it expire afterwards and stop the background job; the agent must never approve it. The same recipe captures the baseline probe's acceptance card.

## When a call fails

A failed tool call keeps the CLI's stable error code and, for these known causes, appends one actionable next step instead of only raw stderr:

- `CAPABILITY`: there is no accepted, current baseline — it is missing, stale, incomplete or unverified. Run `hyprscope_baseline` with `action: "probe"`, explain the evidence, and let the host answer the confirmation card the probe may show. Never answer that card yourself and never claim the baseline was accepted.
- A read-only state directory (`EROFS`): the lease and baseline files cannot be written under the current `XDG_STATE_HOME`. Point it at a writable directory in the DSH Host environment and restart DSH. The accepted baseline lives in the real state home (`$XDG_STATE_HOME/hyprscope/baseline.json`, default `~/.local/state/hyprscope`), so an override is not a substitute for that file.
- A usage or unknown-command failure: run `hyprscope_observe` with `kind: "doctor"` to inspect the loaded wiring, including `pluginVersion` and `cliPath`; if the bundle was edited, restart DSH so the new schema replaces the stale one.

## Configuration

The bundle needs no configuration when it sits in this checkout. It resolves these keys when the plugin activates, and it reads them from the plugin row's `config`. To change one, override the `hyprscope` row in the profile's own patch layer (`$DSH_HOME/profiles/<name>/cordis.patch.yml`; a row override replaces the whole `config`):

```yaml
- id: hyprscope
  config:
    projectDir: /home/jw/workspace/dsh-hyprscope
    attachScreenshotImage: false
```

| Key | Default | Meaning |
|---|---|---|
| `projectDir` | the repository root, two levels above the bundle; `HYPRSCOPE_PROJECT_DIR` is the fallback | Checkout that contains `bin/hyprscope.ts` |
| `nodeExecutable` | `process.execPath` | Node binary used to run the CLI |
| `timeoutMs` | `30000` | Timeout for observation and status calls, in milliseconds |
| `controlTimeoutMs` | `180000` | Timeout for consent, control and plan calls, in milliseconds |
| `maxOutputBytes` | `16777216` (16 MiB) | Most stdout and stderr captured from one call |
| `screenshotDir` | `<OS temp directory>/dsh-hyprscope-screenshots` | Where screenshots go by default; created when missing |
| `attachScreenshotImage` | `true` | Attach the captured PNG to the tool result when the session has an attachment store |
| `maxRenderChars` | `7000` | Text budget for one tool result, under the profile's 8192-character pruning threshold |
| `desktopMessage` | `true` | Start the floating hint and accept desktop-composed messages and annotation requests; `false` keeps the tools and removes both bridges |
| `desktopAnnotate` | `true` | Accept `hyprscope message annotate` and run the annotation bridge; `false` removes only the annotation half |
| `messageLanguage` | `zh` | Language of the hint, composer, annotation review card and transcripts: `zh` or `en` |
| `messageAttachScreenshot` | `true` | Capture the layout and send it as an inline image with each desktop *message*; annotation sessions always attach their own clean monitor capture and ignore this key |
| `messageSessionId` | unset | Pin every desktop message to this Session; omitted uses the most recently active root Session |
| `messageDir` | `$XDG_STATE_HOME/hyprscope/message` | Shared state directory of the CLI and the overlay; annotation sessions live under its `annotate/` subtree; `HYPRSCOPE_MESSAGE_DIR` is the fallback |

A few points are worth knowing:

- The config is validated when the plugin activates: a value of the wrong type or outside its range fails activation, and DSH reports the plugin as failing instead of running with a silently wrong value.
- `projectDir` is re-checked on every call. When it does not contain `bin/hyprscope.ts`, the plugin still loads, but every call fails with a message that names the directory; once the CLI exists there, calls start working without a reload. Set `projectDir` when the bundle or the CLI is not where the default expects it.
- `messageDir` (or `HYPRSCOPE_MESSAGE_DIR`) is the contract between three processes: the Host, the CLI the shortcut runs, and the overlay. A custom directory configured only on the plugin makes `hyprscope message open` write into the default directory, so the composer never appears; export the same environment variable for the compositor session too.
- `messageAttachScreenshot` and `attachScreenshotImage` do not change an annotation session: the annotation bridge always renders its own clean capture and one intent card, and only falls back to text when that PNG is missing, unreadable or over 8 MiB.

## How the safety boundary holds

The plugin adds tools; it adds no permission. Everything it can do is one of the CLI's subcommands, and the boundary that decides is the CLI's: the read-only surface and the `control` surface. That boundary is described in [docs/cli/PROTOCOL.md](/docs/cli/PROTOCOL.md), and the lease and baseline contracts are in [docs/cli/LEASE.md](/docs/cli/LEASE.md) and [docs/cli/BASELINE.md](/docs/cli/BASELINE.md).

- **Read-only tools stay read-only.** `hyprscope_observe`, `hyprscope_screenshot` and `hyprscope_events` spawn only the bare `hyprscope` commands, never `hyprscope control`. The CLI's read-only side never loads the lease, the plan executor, the injection path or the desktop lifecycle, and the plugin does not import repository code at all: it starts the CLI as a separate process. The plugin never calls `hyprctl` or `grim` itself, and it never uses a shell.
- **Screenshots keep the locked default.** The screenshot tool refuses while the session reports locked; only a caller that sets `allowLocked: true` makes it pass `--allow-locked`. No retry or default flips it.
- **A plan run is the consent step.** There is no separate lease request tool and no agent-side `done`/`panic`: `hyprscope_plan` action `run` shows the host's consent card on the user desktop and blocks until the run ends. On an agent or external desktop the consent was given once at `desktop start` or `attach`, and the run proceeds programmatically there. The model cannot answer the card, and no tool parameter approves it.
- **Plans are the only way to change the desktop.** `hyprscope_plan` action `run` executes a validated plan after consent. The executor re-reads the lease and checks its plan binding before every mutating call, and the injection helper re-verifies the lease proof itself. `validate` is a dry run: no card, no desktop change. A run that faults returns the facts for replanning, not a bypass.
- **Control is gated by an accepted capability baseline.** When the baseline is missing, still a draft, incomplete, stale or unverified, a plan run (including a dry run) fails with `CAPABILITY` before any consent card appears. The error names the next step: run `hyprscope_baseline` with `action: "probe"` and explain the evidence. When the measurement widens the accepted baseline, that same call asks the desktop for a confirmation card carrying the verdict, the capability counts and the evidence hash, and returns only after the host clicks Allow or Deny; it writes nothing when the card is denied or expires (the draft stays pending, and another probe asks again), and the tool never answers the card itself. The probe itself takes a lease and injects only into its own scratch window.
- **Agent desktops are lifecycle, not mutations.** `hyprscope_desktop` action `start` may only launch its own nested compositor, `attach` only records an instance the host names, and `stop` only ends the desktop it started. They never move, focus or close a window on the host's desktop; `status` is safe to poll.

## Limitations

- **One process per call.** A call starts Node, loads the CLI, rediscovers the session and exits. That is what keeps the gate intact and the result honest, but it costs the process startup and discovery time on every call, and nothing is batched or kept warm. A plan is one call; issuing the same steps as separate tool calls is slower and no safer.
- **Events is a bounded wait, not a subscription.** `hyprscope_events` keeps the call open until `count` or `once` is satisfied or `timeoutMs` runs out; an expired wait is a success with `timedOut: true`, not an error. A DSH session cannot use it to watch the desktop continuously.
- **Results are compacted.** The text a model reads is capped at `maxRenderChars`: a long list is reduced to the leading items plus `total` and `omitted`, the `doctor` view drops `capabilities.wayland.globals`, and an oversized state falls back to a summary. The parsed value keeps the CLI's JSON for programmatic callers, but a model that reads only the text can miss fields; ask for a narrower `kind` when a list matters.
- **It wraps a checkout, not a release.** The tools run this repository's `bin/hyprscope.ts` and depend on its `--json` shapes. The directory has to stay in place, and a CLI change can change what a tool returns. It also does not build the C helpers: plans that inject still need `bin/wl-inject`, the baseline probe still needs `bin/wl-scratch`, and a window capture needs `bin/wl-capture` from `pnpm run build:capture` (the quick start in [README.md](/README.md) covers the first two).
- **Images need an image-capable route.** The screenshot tool attaches the PNG only when the session has an attachment store and the routed model declares image input. Otherwise, with no store, a text-only route, an unresolved route or a failed save, the result still carries the path, size and hash with an `imageError` note, and the capture itself still succeeds.
- **No CUA provider.** The bundle gives the model tools; wiring the same operations into DSH's CUA provider is future work, not part of this plugin.
- **The desktop bridges add no control path.** They spawn only `hyprscope message ...` and the read-only `screenshot`, never `hyprscope control`; they inject through the Host's `sessionController.prompt` as ordinary user messages, never answer a card, take no lease and change no desktop state.
- **Control stays human-gated.** No tool can answer a consent card or skip the lease. When a baseline is missing or stale, an agent can probe and explain; when the probe widens the baseline it asks for the acceptance confirmation card itself, and the host's click is what accepts. No tool can click that card.
- **The hint is best-effort.** It exists only while the Host runs and the overlay stays alive; it never restarts the compositor. The target is the most recently active root Session, not necessarily the page the user last looked at, so pin `messageSessionId` when one conversation must always receive the message. A Host crash after the overlay writes a message loses that message (the outbox is consumed before delivery, so a retry cannot duplicate it), and a screenshot is skipped above 8 MiB or when the route declares no image input.
- **Annotation voice is best-effort.** A session always needs Quickshell and a running Host; voice additionally needs `parec` or `arecord` and a prepared DSH `speechToText` provider. Without them the screenshot, shapes, comments and typed corrections still reach the agent, but the spoken words do not, and the review card says so. A push-to-talk segment stops at 60 seconds, and the intent card is capped at 8000 characters and the image at 8 MiB.
- **Verification status.** This page documents the bundle's contract; it is not a verification record. The repository's [verification record](/docs/VERIFICATION.md) covers the CLI on one test machine and says nothing about the DSH tools on yours; the bundle's own tests live in `plugins/dsh-hyprscope/test/`.
