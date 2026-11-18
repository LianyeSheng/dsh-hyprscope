# dsh-hyprscope

English | [中文](/README.zh.md)

> **Note:** The code in this repository is AI-generated; the author only did the project design and code review.

A CLI tool for Hyprland desktop observation and consent-gated control, plus a native, plug-and-play plugin for DeepSeek Harness (DSH). The observation layer is read-only: it discovers sessions, reads windows, workspaces and monitors, takes screenshots and subscribes to events. When something has to be changed, that goes through a consent-gated control lease: only after the host consents can an agent take over, and it can be revoked at any time.

It starts from a concrete problem: a DSH process is often not inside the graphical session, `WAYLAND_DISPLAY` and `HYPRLAND_INSTANCE_SIGNATURE` are both empty, and it can neither see the desktop nor know which compositor to send a request to. hyprscope finds the session and shapes the state into stable fields, so that DSH's CUA provider can be wired up later.

The project has one entry point: `hyprscope` observes read-only, and `hyprscope control` is the consent-gated control surface. They share session discovery and observation code, but a read-only command never loads the lease, executor or desktop lifecycle paths, and every command that can change the desktop lives under `control`.

## Quick start

You need Node 22 or newer, pnpm, and a running Hyprland. Screenshots rely on `grim`; the lock state is read from `loginctl`, and when it cannot be read the related fields are marked unavailable.

```sh
pnpm install
pnpm test
pnpm run doctor
pnpm run typecheck
```

`pnpm install` installs the two development dependencies, TypeScript and the Node type declarations; at runtime there are still zero dependencies. The code is mainly TypeScript, Node executes the `.ts` files directly, and there is no build step.

`pnpm test` runs the unit tests and the live tests, and the live part is skipped automatically when there is no Hyprland; `pnpm run doctor` prints the session discovery result, the compositor version and the observable items; `pnpm run typecheck` only type-checks and writes no files.

The Wayland probe is optional; only after it is compiled does `doctor` also report the seat count and the injection-related protocols:

```sh
pnpm run build:probe
```

To execute plans with pointer or keyboard actions you also have to compile the injection helper (C, a pure Wayland client, no extra dependencies):

```sh
pnpm run build:inject     # -> bin/wl-inject
```

Control also needs an accepted capability baseline. Before `hyprscope control` may touch the desktop it has to know that this machine really supports what the tool assumes; the probe measures that by opening its own scratch window and sending a few round trips, so it asks for a short lease first:

```sh
pnpm run build:scratch                          # -> bin/wl-scratch, the probe's own window
node bin/hyprscope.ts control baseline --probe          # measure this machine; the consent card says why
node bin/hyprscope.ts control baseline --show           # what was measured, what is missing, the diff
node bin/hyprscope.ts control baseline --accept         # the host confirms on a desktop card; control is gated by this file
```

Until that file is accepted, `hyprscope control run` and `hyprscope control request` refuse before any consent card appears; read-only `hyprscope` works either way.

Day-to-day commands go through the entry scripts:

```sh
node bin/hyprscope.ts state
node bin/hyprscope.ts screenshot --region 0,0,640,360 --output out/region.png
node bin/hyprscope.ts events --match 'workspace|activewindow' --count 2 --timeout 5000
```

## Features

### Lending desktop control to an agent

`hyprscope` observes without mutating; to operate the desktop you use `hyprscope control`, the lease-gated set of tools and behavior-control logic that an agent uses to drive the UI. It forces the agent not to do anything beyond what is expected and at the same time makes it more efficient (see the batch execution section):
```sh
node bin/hyprscope.ts control install-bind                     # install once: SUPER + ALT + ESC revokes at any time
node bin/hyprscope.ts control request --reason "填写登录表单" --ttl 120
node bin/hyprscope.ts control done                             # the agent hands control back when done
```

If the failsafe was installed before the CLI merge, reinstall it: the old bind points at the removed `bin/hyprlease.ts`. `hyprscope control uninstall-bind` still recognises the old marker and removes it; `install-bind` then writes the `hyprscope control panic` command. A managed desktop started before the merge has the same problem in its generated panic bind; stop and start it.

`request` pops a consent card in the centre of the screen (Allow / Deny; no choice within 45 seconds means an automatic deny). After approval the card shrinks into a top banner showing the remaining time, with "Revoke now" on the right. Control can be revoked in four ways: the agent calls `done`, the host presses `SUPER + ALT + ESC`, the banner button is clicked, or the TTL expires.

Because Wayland was designed from the start for single-user use, there is no way to block the host's own input while an agent is in control, so the physical keyboard and mouse are not frozen. The full explanation of this boundary and the fallback chain is in [docs/LEASE.md](/docs/LEASE.md).

### Agent desktop

`hyprscope control desktop start` starts a nested Hyprland for this agent and shows it as a single window on the host desktop. The nested compositor is a real Hyprland with its own monitors, workspaces and clients, but it runs under the same uid and filesystem as the agent: it separates desktops, not privileges. The human consents once, at `desktop start` or `desktop attach`; inside that desktop, `run`, `request` and `baseline --probe` take a programmatic lease instead of showing a card for every run, and that lease is still bound to the submitted plan and TTL and still checked by `wl-inject`. `desktop status` re-checks the pid, instance directory and sockets, `desktop attach --runtime-dir <dir>` adopts an instance the user names, and `desktop stop` ends a desktop the tool started (for an attached one it only forgets the record).

```sh
node bin/hyprscope.ts control desktop start --size 1280x800   # one nested Hyprland window
node bin/hyprscope.ts control desktop attach --runtime-dir /run/user/1000 --signature <sig>
node bin/hyprscope.ts control desktop status
node bin/hyprscope.ts control desktop stop
```

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
| `doctor` | Session discovery path, compositor version, observable items, Wayland global objects |
| `state` | One snapshot: focus + monitors + workspaces + clients + layers + cursor + lock |
| `active` | Only the active window and workspace |
| `clients` / `workspaces` / `monitors` / `layers` / `cursor` | Read a single item |
| `screenshot` | Screenshot of the whole layout, a single monitor (`--monitor`) or a region (`--region x,y,w,h`) |
| `events` | Subscribe to the compositor event stream; supports `--match`, `--once`, `--count`, `--timeout` |
| `hyprscope control run <plan.json \| ->` | Validate the plan, bind consent to the submitted plan, execute and hand control back |
| `hyprscope control baseline --probe / --show / --accept` | Measure this machine, review the evidence, accept the capability baseline control is gated by (accept is a confirmation card the host clicks) |
| `hyprscope control request / done / panic / status` | Request, end, force-revoke and inspect the control lease |
| `hyprscope control desktop start / attach / status / stop` | Start a nested agent desktop, attach an existing instance, inspect either, or stop it |
| `hyprscope control install-bind / uninstall-bind` | Install or remove the `SUPER + ALT + ESC` fallback |

Common options: `--json`, `--desktop <user|agent|external>`, `--signature <sig>`, `--runtime-dir <dir>`, `-h`, `-v`; `hyprscope` also accepts `--timeout <ms>`. `--desktop` selects the instance a command addresses; the observation commands and `hyprscope control run`, `request`, `status`, `done`, `panic` and `baseline` accept it, and omitting it means the user's desktop. Use `--json` in scripts; the human-readable output only aims to look decent, and column alignment and wording are not guaranteed stable; a bad argument exits with code 2, any other failure with code 1.

A screenshot can be taken in three ways: by default it captures the whole layout, `--monitor NAME` captures a single output, and `--region x,y,w,h` uses global layout coordinates (`grim` wants `X,Y WxH`, and the tool does the conversion). When the session reports a locked state, screenshots are refused by default; pass `--allow-locked` to let them through; output goes to `hyprscope/` under the cache directory by default, and `--output` can move it elsewhere.

### DSH plugin

`plugins/dsh-hyprscope/` is the project's native, plug-and-play DSH Host bundle; it turns these commands into eight tools for the model, so a session calls tools instead of composing `node bin/hyprscope.ts ... --json` commands. `hyprscope_observe`, `hyprscope_screenshot` and `hyprscope_events` read the desktop; `hyprscope_lease`, `hyprscope_plan`, `hyprscope_act`, `hyprscope_baseline` and `hyprscope_desktop` go through `hyprscope control`; `hyprscope_act` runs one single-step action as a one-step plan. Observation needs no consent; a desktop change still needs the host's consent in the control lease and an accepted capability baseline, and the plugin adds no bypass.

Open **Plugins**, choose **Add plugin**, and enter the absolute directory `/home/jw/workspace/dsh-hyprscope/plugins/dsh-hyprscope`; or ask the DSH agent to call `plugin_manager` `install_bundle` with that directory. The bundle only loads on Linux and needs the checkout and Node 22 on the same machine as DSH. The tool surface, configuration keys and limitations are in [docs/DSH-PLUGIN.md](/docs/DSH-PLUGIN.md).

## Why the session has to be found on its own

A DSH process is started from a service or another chain, so the environment has no `HYPRLAND_INSTANCE_SIGNATURE` and `WAYLAND_DISPLAY` is often empty as well, and it cannot connect to the compositor the way an ordinary client does. hyprscope first scans the instance directories under `$XDG_RUNTIME_DIR/hypr/`, picks one that still has a control socket attached, and then reads the pid from the first line and the Wayland display from the second line of the `hyprland.lock` in that directory; both are written by Hyprland itself at startup and have nothing to do with the caller's environment.

The control socket and `grim` therefore land on the same instance, and a screenshot cannot hit the wrong compositor. Passing `--signature` explicitly pins the target to an instance, `--runtime-dir` and `HYPRSCOPE_*` can override the runtime directory and the display, and the `discovery` field of `doctor` states which path was actually taken this time. The lease reuses the same discovery logic, and the overlay process likewise gets the correct `WAYLAND_DISPLAY`.

Field meanings, coordinate conventions, error codes and the mapping to `dsh-cua` are in [docs/PROTOCOL.md](/docs/PROTOCOL.md), the full lease design is in [docs/LEASE.md](/docs/LEASE.md), and the verification record of the test machine at the time is in [docs/VERIFICATION.md](/docs/VERIFICATION.md). For why it still dares to take over the desktop after changing machines, upgrading Hyprland or changing the configuration, the reasoning is in [docs/COMPATIBILITY.md](/docs/COMPATIBILITY.md) and [docs/BASELINE.md](/docs/BASELINE.md): at install time a probe measures the capabilities and a human accepts them into a baseline, and at run time the tool can only narrow according to it. Control is gated by that baseline: a plan that needs a capability the machine did not measure as working is rejected before the consent card, and a failed run never changes the baseline.

The agent desktop — a nested Hyprland of its own — is implemented; its design and lifecycle are in [docs/DESKTOP.md](/docs/DESKTOP.md).

## Known limitations

- The lease does not intercept physical input: the host can use the keyboard and mouse as usual during a lease, and control is ended by the shortcut, the button or the TTL, not by freezing input.
- An absolute-coordinate click in a plan is a low-confidence action: an irreducible gap remains between the predicate check and the injection (TOCTOU), so such steps require focus, geometry and the result assertion to hold together; actions expressible with the keyboard and dispatch are preferred.
- The lease state and the executor both run under the agent's own uid, so the lease binding and the gating are correctness mechanisms for now, not a security boundary; to become a real boundary the lease state would have to move to a separate broker (see `docs/LEASE.md`).
- Control stays unavailable until a human accepts a capability baseline, and the baseline is only as current as the last probe: `doctor` reports drift, and `run` / `request` refuse a stale or unverified baseline with `CAPABILITY`. Re-run `hyprscope control baseline --probe` after changing machines, upgrading Hyprland or changing the configuration; a baseline written by an older version has no effective values, reads `unverified`, and needs one fresh probe and acceptance.
- An agent desktop is a window on the host, not a separate machine: it runs under the same uid and filesystem, its nested output follows the host window (`--size` is a request, not a guarantee), and closing that window destroys the desktop. A run executing inside it faults with `target.desktop-closed`.
- The agent desktop is not persistent across a DSH restart by default; a new DSH session starts its own desktop or attaches the existing one.
- Editing the generated configuration of a running agent desktop makes its baseline stale, and `baseline --probe` refuses to measure the changed live configuration; restart the desktop, then probe and accept again.
- Recovery covers only premises the compositor can observe and that can be rebuilt with the dispatch subset; when an app's internal state cannot be picked up again the run faults outright and lets the agent re-plan instead of pretending to recover.
- Lock state is best-effort: it only reads logind's `LockedHint`, and `locked: null` means only that there is no evidence, which is not the same as the session being unlocked.
- When several Hyprland instances run on the same machine it picks one by log recency by default without confirming that it still responds; it is better to pass `--signature` explicitly.
- The rest of the fields follow the Hyprland version; for version-sensitive points and field definitions see [docs/PROTOCOL.md](/docs/PROTOCOL.md), and in scripts rely on `--json`.
