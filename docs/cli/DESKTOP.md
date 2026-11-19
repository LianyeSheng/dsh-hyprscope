# The agent desktop (`hyprscope control desktop`)

English | [中文](/docs/cli/DESKTOP.zh.md)

> Status: **implemented**. `hyprscope control desktop start|attach|status|stop` manage a nested or attached instance, `--desktop user|agent|external` selects one on the observation and control surfaces, and the live verification from 2026-11-18 is in [VERIFICATION.md](/docs/VERIFICATION.md). The capability baseline ([COMPATIBILITY.md](/docs/cli/COMPATIBILITY.md), [BASELINE.md](/docs/cli/BASELINE.md)) and the lease ([LEASE.md](/docs/cli/LEASE.md)) are reused here; §12 lists what remains open.

## 1. What it is

A nested Hyprland is a second compositor running as an ordinary Wayland client inside the user's session, drawing its whole desktop into one window. The user sees one window; the agent gets its own window list, workspace, seat and sockets, and input injected into it never reaches the user's seat.

It isolates **input and attention**, not permissions: the same uid and the same filesystem. A program inside the agent desktop can still read the user's files; if that matters, the boundary has to be a separate uid or a container, not this feature.

Three targets, chosen explicitly:

| target | who provides it | consent | plans run |
|---|---|---|---|
| `user` | the user's own Hyprland | one card per run, as today | under a lease |
| `agent` | `hyprscope control desktop start` starts a nested instance | once, at start | without a per-run card |
| `external` | the user names an instance | once, at attach | without a per-run card |

`user` is the default. An existing agent desktop never silently captures a command that was meant for the user's desktop: `agent` and `external` only apply when asked for.

## 2. Target selection and addressing

- `--desktop user|agent|external` is accepted by the observation commands and by the control commands that target a desktop; omitting it means `user`.
- The default `user` resolution excludes the signature recorded in `desktop.json`, so a running nested desktop can never silently become the user's desktop; an explicit `--signature` still wins.
- `agent` must be created explicitly with `desktop start`; `run --desktop agent` fails with `TARGET_UNAVAILABLE` when nothing is running, and never starts a desktop as a side effect.
- `external` is attached with `desktop attach --runtime-dir <dir> [--signature <sig>]`; a signature equal to the user's own instance is rejected, because that case is `user` and needs the per-run card.
- Receipts (`doctor`, `run`, `desktop status`) carry `target` and the resolved `signature`, so a receipt can never be read as belonging to another desktop; the array-shaped observation commands identify the instance through `session`.
- `hyprscope` accepts the same selector for read-only observation; resolving a target reads `desktop.json` and never takes a lease.

## 3. Lifecycle

`desktop start` spawns the nested compositor detached (run the command as a DSH background task), waits for its instance directory and Wayland socket, writes `desktop.json`, and returns. `desktop status` re-checks the recorded pid, instance directory, both sockets and (for a generated config) the config hash, and reports `absent`, `running`, `closed` or `stale`. `desktop stop` is the deliberate version of closing the window.

- There is no systemd unit and no auto restart: the desktop runs until `desktop stop`, the window closes, or the login session ends.
- Closing the window destroys the desktop. It is the only revoke path the desktop itself has, and `desktop stop` is its deliberate form.
- If a plan was running, it faults with `target.desktop-closed`, keeps the confirmed steps, and hands the facts back; the agent asks the user in the conversation whether it was accidental.
- A closed desktop is not restarted automatically. `desktop start` after a close creates a new instance with a new signature, so the new desktop needs its own probe (which asks for acceptance when the measurement widens the baseline).

Two points remain open (§12): whether closing the parent's window really terminates the nested compositor, and whether DSH reaps the background task's children when the session ends. `desktop stop` itself was verified on the machine.

## 4. Directories

```
/run/user/1000/hs/                     # runtime, 0700, recreated on start
  hypr/<signature>/                    # hyprctl and event sockets
  wayland-1                            # the nested compositor's Wayland socket
  desktop.pid

$XDG_STATE_HOME/hyprscope/desktop/     # persistent, agent-editable
  desktop.json                         # signature, display, pid, config hash, consent
  config/hypr/hyprland.lua             # generated, minimal
  config/hypr/agent/*.lua              # the agent's own binds and rules
  logs/
  baseline/<signature>.json            # probe result for this desktop
```

- The runtime root must be short: Hyprland's instance signature is 61 characters on 0.57.2, and a Unix socket path is limited to 107 bytes. A workspace path already exceeds that for `.socket2.sock`, which kills the event stream; the product uses `$XDG_RUNTIME_DIR/hs` (`/run/user/1000/hs` in the test environment), and `HYPRSCOPE_DESKTOP_RUNTIME_DIR` overrides it for tests. The limit check runs before start and fails with a clear message.
- `/run/user/1000` is tmpfs: it lasts for the login session and is cleared on logout or reboot. Sockets, pids and the instance directory belong there; nothing the agent wants to keep.
- `$XDG_STATE_HOME/hyprscope/desktop/` is persistent: the generated configuration, the agent's own snippets, logs, `desktop.json`, and the baseline for this desktop.
- This desktop's baseline is `$XDG_STATE_HOME/hyprscope/desktop/baseline/<signature>.json` (draft `<signature>.pending.json`); the user's desktop keeps the machine-wide `$XDG_STATE_HOME/hyprscope/baseline.json`.
- This desktop's lease state lives in `$XDG_STATE_HOME/hyprlease/<signature>/`; the user's desktop keeps `$XDG_STATE_HOME/hyprlease/`. `HYPRSCOPE_LEASE_SIGNATURE` selects the per-instance directory internally; it is not a user-facing option.
- `desktop.json` and the baseline are `0600`; the runtime root is `0700`.

## 5. Configuration

- The generated `config/hypr/hyprland.lua` is minimal: one monitor rule, no user keybinds, no autostart, and a panic key that runs `hyprscope control panic` for this desktop. `--size` is written into that monitor rule and recorded in `desktop.json`, but it is a request, not a working resize: the live test showed the nested output still followed the host window (1228×1398). Treat it as advisory.
- The agent may add its own binds and window rules under `config/hypr/agent/*.lua`; the generated file embeds them inline, so "the agent configures its own desktop" survives restarts.
- Version 1 generates Lua only. When `hyprctl status` reports a provider other than `lua`, `start` refuses with a clear message instead of handing the compositor a config it cannot parse; when the provider cannot be read, the spawn failure and its log tail are the fallback.
- The user's configuration is not inherited by default: autostart, global binds, monitor rules and the provider format would all come along and make the baseline depend on the user's config again. An explicit appearance-only import can come later.
- Every capability-relevant config change invalidates the desktop's baseline (§6). The generated file and every agent snippet are hashed into `configHash`; editing a snippet changes it and makes the baseline stale until the desktop is restarted and re-probed.

## 6. Capability baseline and staleness

The baseline stays a per-instance verdict. The user's desktop keeps the machine-wide `$XDG_STATE_HOME/hyprscope/baseline.json`; an `agent` or `external` desktop gets its own file at `$XDG_STATE_HOME/hyprscope/desktop/baseline/<signature>.json`, so a probe of one desktop never gates another.

- Drift compares the recorded version, provider, `input:follow_mouse`, bind count, whether a plain F12 is bound, configuration errors as a set, and `configHash` when one is recorded. Any difference is `stale`; a value the baseline does not record is `unverified`; a value the live compositor cannot report is `stale`.
- A baseline written before drift tracking has no `effective` block; it is `unverified`, and control refuses it with `CAPABILITY` until it is re-probed.
- `desktop status` reports a changed generated config as `stale`; `doctor` reports the target, the `fresh`/`stale`/`unverified` verdict, the reasons and the field differences. `run` (including `--dry-run`) refuses a stale or unverified baseline with `CAPABILITY` before any consent card, because control must be decided by a measurement of what is running; read-only observation is unaffected.
- Editing an agent snippet invalidates the baseline. A probe while the running compositor still uses the old configuration is refused with `DESKTOP_FAILED` (`stop and start the desktop before probing it`), so the flow is: stop the desktop, start it again (new signature, so the new desktop needs its own probe), then probe (a widening probe asks the host for the confirmation card). Restoring the snippet before restarting makes the baseline `fresh` again.
- Re-probing a stale baseline otherwise follows the normal probe flow; narrowing still applies automatically, and a widening probe asks the host for acceptance itself.

This is also why the agent desktop is cheaper than the user's desktop: its configuration is generated, so the version-dependent layer can be attested once per Hyprland version while the installation layer collapses to one probe per generated config.

## 7. Consent

- Starting or attaching an agent desktop needs one explicit user confirmation (`--consent-source chat|card`; `chat` is the default); `desktop.json` records when and how (`source: "chat"` or `"card"`), and that record is the basis for everything that happens inside it.
- Inside an `agent` or `external` desktop, `run` still obtains a lease programmatically, bound to the submitted plan and the attempt TTL, but no card is shown: the desktop itself is the consent boundary. `baseline --probe` uses the same programmatic lease. The executor's lease gate and the injection helper's lease proof stay in force; nothing bypasses them.
- The interference prompt belongs to the user desktop's overlay, which a managed desktop does not have. Inside `agent` or `external`, restorable interference therefore faults the run instead of showing a card, and the agent asks the user in the conversation; no recovery plan is derived.
- The `user` target keeps today's model: one card per run, one lease per run, revocable at any time.
- `desktop stop` releases that desktop's lease explicitly. Closing the compositor window kills an in-flight run, which faults with `target.desktop-closed` and releases in its `finally` path; a lease held by a detached holder with no run ends at its TTL. Closing gives no separate revoke path because the compositor is gone, but the holder is a separate process.

`desktop.json`'s consent record is visibility, not authentication: the agent runs under the same uid and could write the same file.

## 8. Failures and cleanup

- `start` waits for the instance directory, `.socket.sock` and the Wayland socket with a bounded timeout; a timeout kills the process, removes the runtime root and reports `DESKTOP_FAILED` with the captured log tail.
- A record that no longer matches the running instance (a missing socket, a changed config hash, or a dead pid with sockets still around) is reported as `stale`; a record whose pid and sockets are all gone is `closed`; `start` cleans a non-running record before creating a new instance.
- `attach` rejects a signature equal to the user's own desktop with `USAGE`, an ambiguous runtime directory with `USAGE`, the managed runtime root with `DESKTOP_FAILED`, and a runtime directory with no usable instance with `TARGET_UNAVAILABLE`; it only writes the record and never touches the external runtime directory.
- `stop` sends SIGTERM to the process group, waits, then SIGKILL, removes the runtime root, marks the record `closed` and releases that desktop's lease; if the runtime root cannot be removed, the failure is reported rather than hidden. On an `external` desktop, `stop` only forgets the record and never kills the process.
- A plan running against a desktop that disappears faults with `target.desktop-closed`; the run directory keeps the timeline and the confirmed steps. A restorable conflict inside a managed desktop faults instead of prompting (no overlay exists), keeping the confirmed steps and the timeline.

## 9. Command surface

```
hyprscope control desktop start [--size 1280x800] [--consent-source chat|card] [--json]
hyprscope control desktop attach --runtime-dir <dir> [--signature <sig>] [--consent-source chat|card] [--json]
hyprscope control desktop status [--json]
hyprscope control desktop stop [--json]
hyprscope control run plan.json --desktop user|agent|external [--json]
hyprscope control status --desktop user|agent|external [--json]
hyprscope control panic --desktop user|agent|external [--json]   # emergency only (failsafe shortcut / desktop stop)
hyprscope control baseline --probe / --show --desktop user|agent|external [--json]
hyprscope <command> --desktop user|agent|external [--json]
```

The commands exist under `hyprscope control` only; the read-only `hyprscope` commands accept the selector but never start or stop a desktop. `--size` is advisory (§5).

## 10. Code map

| location | what it does |
|---|---|
| `src/desktop/lifecycle.ts` | start, attach, status, stop, readiness, cleanup, Lua-host check |
| `src/desktop/record.ts` | `desktop.json` read/write, paths, socket-length check |
| `src/desktop/config.ts` | generated Lua, inline agent snippets, monitor mode |
| `src/desktop/hash.ts` | `configHash`: hashes the generated file and every snippet; importable by the read-only commands |
| `src/desktop/target.ts` | `--desktop` resolution, managed-desktop exclusion, baseline/lease keys |
| `src/compat/baseline.ts` | per-instance baseline path, reader and writer |
| `src/compat/staleness.ts` | effective-config measurement and the `fresh`/`stale`/`unverified` comparison |
| `src/lease/cli.ts` | `desktop` subcommands; `--desktop` on the other commands |
| `src/plan/run.ts` | target-aware run, programmatic lease, `target.desktop-closed` |
| `test/desktop-config.test.ts`, `test/desktop-lifecycle.test.ts`, `test/desktop-target.test.ts`, `test/staleness.test.ts` | fixtures without a compositor |

## 11. What it is not

- Not a security boundary: same uid, same files, no sandbox.
- Not a clipboard, portal, audio or session-bus bridge; those start separate and are later work.
- Not headless or remote: the first version is a window in the user's session, so closing it is the kill switch.
- Not multi-seat: the nested compositor has its own seat, but the machine still has one physical one.
- Not persistent across a DSH restart by default: the compositor is a detached process, and a new DSH session does not adopt it.

## 12. Open questions

- Whether closing the parent window terminates the nested compositor, or only removes its output.
- Whether DSH reaps the background task's children when the session ends, and whether `desktop start` should detach with `setsid` for a `--persist` mode.
- What an `external` instance the user names may contain, and whether it should carry a weaker consent than `agent`.
- How coarse `configHash` should be when the agent edits its snippets often; today every edit makes the baseline stale and needs a restart plus a re-probe, and a reload marker could be cheaper.
- Pointer origins on a multi-monitor layout, which the single-monitor spike could not cover.
