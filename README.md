# dsh-hyprscope

English | [中文](/README.zh.md)

> **Note:** The code in this repository is AI-generated; the author only did the project design and code review.

A CLI tool for Hyprland desktop observation and consent-gated control, plus a native, plug-and-play plugin for DeepSeek Harness (DSH). The observation layer is read-only: it discovers sessions, reads windows, workspaces and monitors, takes screenshots and subscribes to events. When something has to be changed, that goes through a consent-gated control lease: only after the host consents can an agent take over, and it can be revoked at any time.

It starts from a concrete problem: a DSH process is often not inside the graphical session, `WAYLAND_DISPLAY` and `HYPRLAND_INSTANCE_SIGNATURE` are both empty, and it can neither see the desktop nor know which compositor to send a request to. hyprscope finds the session and shapes the state into stable fields, so that DSH's CUA provider can be wired up later.

The project has one entry point and three command groups: `hyprscope` observes read-only, `hyprscope control` is the consent-gated control surface, and `hyprscope message` drives the desktop hint, composer and annotation surface that feed a running DSH Host. They share session discovery, but a read-only command never loads the lease, executor or desktop lifecycle paths, the message surface loads none of them either, and every command that can change the desktop lives under `control`.

## Quick start

You need Node 22 or newer, pnpm, and a running Hyprland. Layout, monitor and region screenshots rely on `grim`; a single window is captured through the native `bin/wl-capture` helper (build it with `pnpm run build:capture`). The lock state is read from `loginctl`, and when it cannot be read the related fields are marked unavailable.

```sh
pnpm install
pnpm test
pnpm run doctor
pnpm run typecheck
```

`pnpm install` installs the two development dependencies, TypeScript and the Node type declarations; at runtime there are still zero dependencies. The code is mainly TypeScript, Node executes the `.ts` files directly, and there is no build step.

`pnpm test` runs the unit tests and the live tests, and the live part is skipped automatically when there is no Hyprland; `pnpm run doctor` prints the session discovery result, the compositor version, the observable items and the control runtime it can check without touching the desktop (overlay binary, state-directory writability, window-capture semantics); `pnpm run typecheck` only type-checks and writes no files.

The Wayland probe is optional; only after it is compiled does `doctor` also report the seat count and the injection-related protocols:

```sh
pnpm run build:probe
```

To execute plans with pointer or keyboard actions you also have to compile the injection helper (C, a pure Wayland client, no extra dependencies):

```sh
pnpm run build:inject     # -> bin/wl-inject
```

To capture one window — including a window that sits on another workspace or is covered by another window — also compile the capture helper (C, a pure Wayland client; it asks the compositor to render one toplevel through `ext-image-copy-capture`, so the compositor must advertise that protocol together with the foreign-toplevel list and image-capture-source extensions; verified on Hyprland 0.57.2):

```sh
pnpm run build:capture     # -> bin/wl-capture
```

Layout, monitor and region captures still use `grim`.

Control also needs an accepted capability baseline. Before `hyprscope control` may touch the desktop it has to know that this machine really supports what the tool assumes; the probe measures that by opening its own scratch window and sending a few round trips, so it asks for a short lease first:

```sh
pnpm run build:scratch                          # -> bin/wl-scratch, the probe's own window
node bin/hyprscope.ts control baseline --probe          # measure this machine; when the result widens the baseline, the same command asks the host and writes it on Allow
node bin/hyprscope.ts control baseline --show           # what was measured, what is missing, the diff
```

Until that file is accepted, `hyprscope control run` refuses before any consent card appears; read-only `hyprscope` works either way.

Day-to-day commands go through the entry scripts:

```sh
node bin/hyprscope.ts state
node bin/hyprscope.ts screenshot --region 0,0,640,360 --output out/region.png
node bin/hyprscope.ts screenshot --window-app foot --output out/window.png
node bin/hyprscope.ts events --match 'workspace|activewindow' --count 2 --timeout 5000
```

## Features

### Lending desktop control to an agent

`hyprscope` observes without mutating; to operate the desktop you use `hyprscope control`, the lease-gated set of tools and behavior-control logic that an agent uses to drive the UI. It forces the agent not to do anything beyond what is expected and at the same time makes it more efficient (see the batch execution section):
```sh
node bin/hyprscope.ts control install-bind                     # install once: SUPER + ALT + ESC revokes at any time
node bin/hyprscope.ts control run plans/live-terminal.json     # show the consent card, execute after approval, release when it ends
node bin/hyprscope.ts control status                           # read-only: current phase and remaining time
```

If the failsafe was installed before the CLI merge, reinstall it: the old bind points at the removed `bin/hyprlease.ts`. `hyprscope control uninstall-bind` still recognises the old marker and removes it; `install-bind` then writes the `hyprscope control panic` command. A managed desktop started before the merge has the same problem in its generated panic bind; stop and start it.

`run` pops a consent card in the centre of the screen (Allow / Deny; no choice within 45 seconds means an automatic deny). After approval the card shrinks into a top banner showing the remaining time, with "Revoke now" on the right, the run executes the plan and hands control back when it ends, so there is no separate acquire or hand-back step. Control can be revoked before that: the host presses `SUPER + ALT + ESC`, clicks the banner button, or the TTL expires. The card and overlay chrome follow `--lang <zh|en>` (default Chinese; `HYPRSCOPE_LANG` is the fallback), while CLI stdout stays English.

Because Wayland was designed from the start for single-user use, there is no way to block the host's own input while an agent is in control, so the physical keyboard and mouse are not frozen. The full explanation of this boundary and the fallback chain is in [docs/LEASE.md](/docs/LEASE.md).

### Agent desktop

`hyprscope control desktop start` starts a nested Hyprland for this agent and shows it as a single window on the host desktop. The nested compositor is a real Hyprland with its own monitors, workspaces and clients, but it runs under the same uid and filesystem as the agent: it separates desktops, not privileges. The human consents once, at `desktop start` or `desktop attach`; inside that desktop, `run` and `baseline --probe` take a programmatic lease instead of showing a card for every run, and that lease is still bound to the submitted plan and TTL and still checked by `wl-inject`. `desktop status` re-checks the pid, instance directory and sockets, `desktop attach --runtime-dir <dir>` adopts an instance the user names, and `desktop stop` ends a desktop the tool started (for an attached one it only forgets the record).

```sh
node bin/hyprscope.ts control desktop start --size 1280x800   # one nested Hyprland window
node bin/hyprscope.ts control desktop attach --runtime-dir /run/user/1000 --signature <sig>
node bin/hyprscope.ts control desktop status
node bin/hyprscope.ts control desktop stop
```

### Desktop messages

A running DSH Host with this plugin also gets a small hint on the desktop: DSH is running in the background, hyprscope is enabled, and the message shortcut is ready. The hint is a Quickshell pill at the top-right; the Host refreshes its heartbeat every few seconds, so the pill disappears when DSH stops.

Press the shortcut (default `SUPER + ALT + M`) and a small composer appears in the centre. Type, press Enter, and the message lands in the conversation the Host saw most recently — as an ordinary user message, with a screenshot of the desktop at that moment attached when the route accepts images. The agent therefore sees the screen without a browser page in front; if the image is skipped it can still call `hyprscope_screenshot` or `hyprscope_observe`. Esc cancels; the composer only steals the keyboard while it is visible.

A second shortcut (default `SUPER + ALT + A`) opens the annotation surface: freeze the screen, draw boxes, ellipses or arrows, hold Space to talk, review, and send. The agent receives a clean screenshot plus a structured intent card — the shapes, comments, window metadata and transcripts stay metadata, not pixels painted on the image.

Install the shortcuts once, together with the failsafe, and restart DSH so the plugin loads the bridge:

```sh
node bin/hyprscope.ts control install-bind          # failsafe, composer and annotator shortcuts
node bin/hyprscope.ts control install-bind --message-key "SUPER + ALT + D" --annotate-key "SUPER + ALT + N"
node bin/hyprscope.ts message open                  # what the composer shortcut runs; also works from a terminal
node bin/hyprscope.ts message annotate              # what the annotation shortcut runs
```

The message surface needs Quickshell, a reachable Hyprland session, and a DSH profile that exposes `sessionController` (the Web and Desktop bundles do). It takes no lease and changes no desktop state: it paints an overlay, writes message files, and types through the Host's own prompt admission. Installing the shortcuts changes the bind count, so an accepted capability baseline becomes stale; re-probe and let the host accept the new count before control runs. The plugin-side behavior, target selection and state files are in [docs/DSH-PLUGIN.md](/docs/DSH-PLUGIN.md).

### Batch execution

Whenever an action takes more than a step or two, you should write a plan and let the program execute it:

```sh
node bin/hyprscope.ts control run plans/live-terminal.json --dry-run   # validate only, no consent card
node bin/hyprscope.ts control run plans/live-terminal.json             # show the consent card, execute after approval
```

The plan is read once, when it is submitted: the dry run validates it without asking, and a real run loads and validates the same document once before the consent card, then executes that in-memory plan, so nothing written to disk afterwards can change what the host approved. `control run -` reads the document from stdin, which is how the DSH plugin submits a plan without writing a file.

Every step carries premises (`requires`) and expectations (`expect`). The executor proceeds as `preflight → commit → verify`; if a premise does not hold it fails fast and writes a fault record containing: which assumption was broken, which steps are confirmed to have taken effect, and where the on-scene screenshot is.

Recoverable interference during a run — the host moving the mouse, switching workspaces, stealing focus — first pauses and pops a card asking you to choose "Continue" or "Terminate". If you choose continue, the executor does not repair in place and does not replay the interrupted step: it suspends this attempt, composes a new plan from code-synthesized restore steps plus the remaining steps of the original plan, renews the same lease, gives this attempt its own execution window, and runs on. Recovery only does mechanical things: switching workspace, leaving fullscreen, restoring floating/pinned/position, restoring focus, moving the pointer; a run recovers at most once by default, `--max-resumes 3` relaxes that to 3 and `0` turns recovery off, and every recovery leaves a trace in the overlay receipt and in the run report's `attempts`. Situations that cannot be picked up again — a window closed, a monitor changed, the app's UI changed — do not show a card; the run terminates immediately and hands the facts back to the agent to re-plan: it never "rolls back" on its own initiative.

What a plan can do is kept very narrow: no `exec`, no arbitrary dispatcher, no config changes; coordinates are window-relative by default, and absolute coordinates are a low-confidence action. The complete predicate table, op table, recovery model and fault format are in [docs/PLAN.md](/docs/PLAN.md). Each run's artifacts live in `out/runs/<runId>/` (subdirectories for the plan, timeline, screenshots, fault and recovery attempts).

### Commands

| Command | Purpose |
|---|---|
| `doctor` | Session discovery path, compositor version, observable items, Wayland global objects, and the control runtime (`environment`: overlay binary, state-directory writability, `capture.window` semantics) |
| `state` | One snapshot: focus + monitors + workspaces + clients + layers + cursor + lock |
| `active` | Only the active window and workspace |
| `clients` / `workspaces` / `monitors` / `layers` / `cursor` | Read a single item |
| `screenshot` | Screenshot of the whole layout, a single monitor (`--monitor`), a region (`--region x,y,w,h`) or one window (`--window-id` / `--window-app` / `--window-title`) |
| `events` | Subscribe to the compositor event stream; supports `--match`, `--once`, `--count`, `--timeout` |
| `hyprscope control run <plan.json \| ->` | Validate the plan, bind consent to the submitted plan, execute and hand control back |
| `hyprscope control baseline --probe / --show` | Measure this machine and, when the result widens the accepted baseline, ask the host on a confirmation card and write the new baseline on Allow; `--show` reviews the evidence and the accepted baseline |
| `hyprscope control status / panic` | Inspect the control lease; `panic` is the emergency revoke used by the failsafe shortcut (never an agent workflow step) |
| `hyprscope control desktop start / attach / status / stop` | Start a nested agent desktop, attach an existing instance, inspect either, or stop it |
| `hyprscope control install-bind / uninstall-bind` | Install or remove the managed shortcuts: `SUPER + ALT + ESC` failsafe, `SUPER + ALT + M` desktop message and `SUPER + ALT + A` annotation (`--key`, `--message-key`, `--annotate-key`) |
| `hyprscope message open / annotate / overlay / stop` | Open the desktop composer or the annotation surface (the shortcuts run these), start the hint overlay, or ask it to exit; `--lang zh\|en`, `--json` |

Common options: `--json`, `--desktop <user|agent|external>`, `--signature <sig>`, `--runtime-dir <dir>`, `-h`, `-v`; `hyprscope` also accepts `--timeout <ms>`. `--desktop` selects the instance a command addresses; the observation commands and `hyprscope control run`, `status`, `panic`, `ops` and `baseline` accept it, and omitting it means the user's desktop. `hyprscope control` also accepts `--lang <zh|en>` on every control command: it selects the language of the consent or confirmation card and of the overlay it spawns (default `zh`, or the `HYPRSCOPE_LANG` environment value; an unknown value is a usage error), while CLI stdout stays English. Use `--json` in scripts; the human-readable output only aims to look decent, and column alignment and wording are not guaranteed stable; a bad argument exits with code 2, any other failure with code 1.

A screenshot can be taken in four ways: by default it captures the whole layout, `--monitor NAME` captures a single output, `--region x,y,w,h` uses global layout coordinates (`grim` wants `X,Y WxH`, and the tool does the conversion), and `--window-id <Hyprland address or foreign-toplevel identifier>` / `--window-app <class>` / `--window-title <exact title>` captures one window even when it is on another workspace or covered. A window capture needs the built `bin/wl-capture` (`pnpm run build:capture`) and works only for mapped windows: a minimized or unmapped window is refused, the cursor is not composited into the image, and a window with a `no_screen_share` rule or a denied screenshot permission yields the compositor's denied placeholder. An ambiguous `--window-app` / `--window-title` exits 2 and lists the candidates (address, app id, workspace, on active workspace or off-screen), telling you to pass `--window-id`; an explicit `--output` must be inside an existing, writable directory, preflighted before capture (`SCREENSHOT_FAILED` tells you to pass a writable `--output`). When the session reports a locked state, screenshots are refused by default; pass `--allow-locked` to let them through; output goes to `hyprscope/` under the cache directory by default, and `--output` can move it elsewhere.

### DSH plugin

`plugins/dsh-hyprscope/` is the project's native, plug-and-play DSH Host bundle; it turns these commands into six tools for the model, so a session calls tools instead of composing `node bin/hyprscope.ts ... --json` commands. `hyprscope_observe`, `hyprscope_screenshot` and `hyprscope_events` read the desktop; `hyprscope_plan`, `hyprscope_baseline` and `hyprscope_desktop` go through `hyprscope control`; a plan run is the consent step and also covers what used to be a single-step action. Observation needs no consent; a desktop change still needs the host's consent in the control lease and an accepted capability baseline, and the plugin adds no bypass. The tools that can show a consent card also take an optional `language` (`zh` or `en`; omitted keeps the Chinese default): `hyprscope_plan` `run` and `hyprscope_baseline` `probe`.

Open **Plugins**, choose **Add plugin**, and enter the absolute directory `/home/jw/workspace/dsh-hyprscope/plugins/dsh-hyprscope`; or ask the DSH agent to call `plugin_manager` `install_bundle` with that directory. The bundle only loads on Linux and needs the checkout and Node 22 on the same machine as DSH. Besides the six tools it starts the desktop-message hint and accepts messages from the shortcut while DSH runs in the background. The tool surface, configuration keys and limitations are in [docs/DSH-PLUGIN.md](/docs/DSH-PLUGIN.md).

## Why the session has to be found on its own

A DSH process is started from a service or another chain, so the environment has no `HYPRLAND_INSTANCE_SIGNATURE` and `WAYLAND_DISPLAY` is often empty as well, and it cannot connect to the compositor the way an ordinary client does. hyprscope first scans the instance directories under `$XDG_RUNTIME_DIR/hypr/`, picks one that still has a control socket attached, and then reads the pid from the first line and the Wayland display from the second line of the `hyprland.lock` in that directory; both are written by Hyprland itself at startup and have nothing to do with the caller's environment.

The control socket and `grim` therefore land on the same instance, and a screenshot cannot hit the wrong compositor. Passing `--signature` explicitly pins the target to an instance, `--runtime-dir` and `HYPRSCOPE_*` can override the runtime directory and the display, and the `discovery` field of `doctor` states which path was actually taken this time. The lease reuses the same discovery logic, and the overlay process likewise gets the correct `WAYLAND_DISPLAY`.

Field meanings, coordinate conventions, error codes and the mapping to `dsh-cua` are in [docs/PROTOCOL.md](/docs/PROTOCOL.md), the full lease design is in [docs/LEASE.md](/docs/LEASE.md), and the verification record of the test machine at the time is in [docs/VERIFICATION.md](/docs/VERIFICATION.md). For why it still dares to take over the desktop after changing machines, upgrading Hyprland or changing the configuration, the reasoning is in [docs/COMPATIBILITY.md](/docs/COMPATIBILITY.md) and [docs/BASELINE.md](/docs/BASELINE.md): at install time a probe measures the capabilities and a human accepts them into a baseline, and at run time the tool can only narrow according to it. Control is gated by that baseline: a plan that needs a capability the machine did not measure as working is rejected before the consent card, and a failed run never changes the baseline.

The agent desktop — a nested Hyprland of its own — is implemented; its design and lifecycle are in [docs/DESKTOP.md](/docs/DESKTOP.md).

## Known limitations

- The lease does not intercept physical input: the host can use the keyboard and mouse as usual during a lease, and control is ended by the shortcut, the button or the TTL, not by freezing input.
- An absolute-coordinate click in a plan is a low-confidence action: an irreducible gap remains between the predicate check and the injection (TOCTOU), so such steps require focus, geometry and the result assertion to hold together; actions expressible with the keyboard and dispatch are preferred.
- Single-window capture needs a compositor that advertises `ext-image-copy-capture`, `ext-foreign-toplevel-list` and `ext-image-capture-source`, plus the built `bin/wl-capture`; if the helper is missing the command says to run `pnpm run build:capture`, and a compositor without those protocols cannot capture a window. Layout, monitor and region captures still use `grim`.
- Only mapped windows can be window-captured: a minimized or unmapped window is refused, the cursor is not composited into the image, and a window with a `no_screen_share` rule or a denied screenshot permission yields the compositor's denied placeholder.
- The lease state and the executor both run under the agent's own uid, so the lease binding and the gating are correctness mechanisms for now, not a security boundary; to become a real boundary the lease state would have to move to a separate broker (see `docs/LEASE.md`).
- Control stays unavailable until a human accepts a capability baseline, and the baseline is only as current as the last probe: `doctor` reports drift, and `run` refuses a stale or unverified baseline with `CAPABILITY`. Re-run `hyprscope control baseline --probe` after changing machines, upgrading Hyprland or changing the configuration; a baseline written by an older version has no effective values, reads `unverified`, and needs one fresh probe, which asks the host to confirm the new baseline when it widens.
- An agent desktop is a window on the host, not a separate machine: it runs under the same uid and filesystem, its nested output follows the host window (`--size` is a request, not a guarantee), and closing that window destroys the desktop. A run executing inside it faults with `target.desktop-closed`.
- The agent desktop is not persistent across a DSH restart by default; a new DSH session starts its own desktop or attaches the existing one.
- Editing the generated configuration of a running agent desktop makes its baseline stale, and `baseline --probe` refuses to measure the changed live configuration; restart the desktop, then probe again (a widening probe asks the host for the confirmation card).
- Recovery covers only premises the compositor can observe and that can be rebuilt with the dispatch subset; when an app's internal state cannot be picked up again the run faults outright and lets the agent re-plan instead of pretending to recover.
- Lock state is best-effort: it only reads logind's `LockedHint`, and `locked: null` means only that there is no evidence, which is not the same as the session being unlocked.
- When several Hyprland instances run on the same machine it picks one by log recency by default without confirming that it still responds; it is better to pass `--signature` explicitly.
- The rest of the fields follow the Hyprland version; for version-sensitive points and field definitions see [docs/PROTOCOL.md](/docs/PROTOCOL.md), and in scripts rely on `--json`.
