# DSH plugin for hyprscope

English | [中文](/docs/DSH-PLUGIN.zh.md)

`plugins/dsh-hyprscope/` is the project's native, plug-and-play DSH Host bundle; it turns the hyprscope CLI into eight tools a model can call. Instead of composing `node bin/hyprscope.ts ...` shell commands — remembering the checkout path, the flag order and the `--json` switch, then parsing the result — a DSH session calls `hyprscope_observe`, `hyprscope_screenshot`, `hyprscope_events`, `hyprscope_lease`, `hyprscope_plan`, `hyprscope_act`, `hyprscope_baseline` or `hyprscope_desktop` with typed arguments and gets a parsed object back.

The bundle is a thin wrapper, not a second implementation: every tool call runs `node bin/hyprscope.ts <command> --json` as a child process, with an argv array and no shell. The CLI keeps every gate, and the plugin adds no way around them. It is Host-only: it registers tools, not a page.

## What it is and why

For an agent, the shell route is friction on observation and risk on control. Observation costs a chain of small mistakes to get right: finding the checkout, remembering which flags come before the positional argument, choosing `--json`, telling exit code 2 (bad arguments) from exit code 1 (any other failure), and reading failure JSON on stderr rather than stdout. Control adds the step that matters most: the consent card is shown on the host's screen and answered by the host, not by the process that wants the lease.

The bundle moves command construction back into code. The model sees eight tool definitions with JSON-Schema arguments, gets one parsed object back, and on failure gets hyprscope's error code and the next step in the message. What the CLI refuses, the tool call refuses in the same way. Each tool is one subcommand:

```sh
hyprscope_observe     -> node bin/hyprscope.ts <kind> --json
hyprscope_screenshot  -> node bin/hyprscope.ts screenshot --json
hyprscope_events      -> node bin/hyprscope.ts events --json
hyprscope_lease       -> node bin/hyprscope.ts control <request|status|done|panic> [--lang zh|en] --json
hyprscope_plan        -> node bin/hyprscope.ts control run <plan.json | -> [--dry-run] [--lang zh|en] --json
hyprscope_act         -> node bin/hyprscope.ts control run - [--lang zh|en] --json
hyprscope_baseline    -> node bin/hyprscope.ts control baseline --show|--probe [--lang zh|en] --json
hyprscope_desktop     -> node bin/hyprscope.ts control desktop <action> --json
```

An inline `plan` (and the one-step plan `hyprscope_act` builds) travels to the CLI on stdin, as `control run -`: the bundle writes no plan file and leaves nothing behind. A `planPath` is passed through as a file and read by the CLI itself.

## Installing the bundle

The bundle lives in this repository and is installed into a DSH profile; it is not published to a registry. Both ways of installing it take the absolute directory of the bundle:

- In DSH, open **Plugins**, choose **Add plugin**, and enter the local directory `/home/jw/workspace/dsh-hyprscope/plugins/dsh-hyprscope`.
- Or have the DSH agent call `plugin_manager` with `action: "install_bundle"` and `target` set to the same absolute directory.

Installation is profile-wide and survives a restart, and it links the checkout rather than copying it, so the directory has to stay where it is. The installed bundle is `@local/dsh-hyprscope`, its plugin row is `hyprscope`, and the Plugins page lists it as **Desktop observation and control**.

Three requirements have to hold:

- The DSH Host runs as the same user, on the same machine, as the Hyprland session. The CLI finds the session through the per-user runtime directory, but it cannot cross a different uid or a container boundary.
- The Node running the DSH Host is version 22 or newer (the plugin defaults to that executable), and the checkout contains `bin/hyprscope.ts`. The plugin runs the CLI from this checkout; it installs no dependencies and builds no C helpers.
- The bundle declares `dsh.bundle.platforms: ["linux"]`, so DSH refuses to activate it on another Host platform. Hyprland is a Wayland compositor, so this is not a practical restriction.

After installation, the tools are available to sessions of that profile. To check the wiring, call `hyprscope_observe` with `kind: "doctor"`: it runs the read-only capability report. If the bundle cannot find the CLI, the plugin still activates, and the call fails with a message that names `projectDir`.

## The eight tools

| Tool | Kind | What it does | Arguments |
|---|---|---|---|
| `hyprscope_observe` | Read-only | Reads the session, a snapshot or one collection; never calls `control` | `kind` (required): `doctor`, `state`, `active`, `clients`, `workspaces`, `monitors`, `layers` or `cursor`; `timeoutMs` |
| `hyprscope_screenshot` | Read-only | Captures the layout, one monitor, one region or one window; refuses while the session reports locked | `scope` (`layout` by default, `monitor`, `region`), `monitor`, `region` (`{x,y,width,height}`), `window` (`{id}` or `{app}` or `{title}`, exactly one; off-screen windows included), `output` (absolute PNG path), `allowLocked` (`false` by default) |
| `hyprscope_events` | Read-only | Subscribes to the compositor event stream for a bounded wait | `match`, `count` (1–50), `once`, `timeoutMs` (100–60000, `5000` by default) |
| `hyprscope_lease` | Control | Requests, inspects or ends the control lease; `request` shows the host's consent card on the user desktop and waits | `action` (required): `request`, `status`, `done` or `panic`; `reason` (required for `request`); `ttlSeconds` (5–600, `120` by default) and `consentSeconds` (5–120, `45` by default), both for `request`; `language` (`zh` or `en`) for `request` |
| `hyprscope_plan` | Control | Validates a plan as a dry run, or runs it after consent (the card lists the plan's description and steps); the only way these tools change the desktop | `action` (required): `validate` or `run`; exactly one of `planPath` or `plan`; `maxResumes` (0–3, `1` by default) and `consentSeconds` (5–120, `45` by default), both for `run`; `language` (`zh` or `en`) for `run` |
| `hyprscope_act` | Control | Runs one action as a one-step plan: the submitted step is wrapped in a plan skeleton and submitted through the plan run path, so the same validation, consent card, executor and lease apply; there is no second execution path | `step` (required): one plan step object, `op` plus that op's fields, including any `requires`/`expect`; `reason` (required, 1–200 chars); `planId` (`act` by default), `budgetMs` (500–30000), `maxResumes` (0–3, `1` by default), `consentSeconds` (5–120, `45` by default) and `language` (`zh` or `en`) |
| `hyprscope_baseline` | Control | Inspects or measures the capability baseline that gates control; a probe that widens the accepted baseline also shows the host's confirmation card and returns after the host answers | `action` (required): `show` or `probe`; `diff` (`show` only), `readOnly` (`probe` only), `consentSeconds` (`probe` only); `language` (`zh` or `en`) for `probe` |
| `hyprscope_desktop` | Lifecycle | Starts, attaches, inspects or stops an agent desktop; never moves a user window | `action` (required): `start`, `attach`, `status` or `stop`; `size` (`start` only), `runtimeDir` (required for `attach`), `consentSource` (`chat` by default, `card`; `start` and `attach` only) |

The observation, screenshot, event, lease, plan and baseline tools also accept `desktop` (`user`, `agent` or `external`), `signature` and `runtimeDir`, and pass them to the CLI only when set; `hyprscope_desktop` is the exception, taking `signature` and `runtimeDir` only for `attach` and no `desktop` selector. `desktop` defaults to the user's desktop; the CLI's user resolution skips the desktop this repository started, so a managed desktop cannot silently become the user's. Omitted arguments keep the CLI defaults.

The four tools that can show a consent card take an optional `language` (`zh` or `en`) and pass it to the CLI as `--lang`: `hyprscope_lease` (`request`), `hyprscope_plan` (`run`), `hyprscope_act` and `hyprscope_baseline` (`probe`). Omitted keeps the CLI default (`zh`), an unsupported value fails before the CLI starts, and CLI stdout stays English.

The three read-only tools are marked safe to run concurrently; the other five are not. Long results are compacted for the model: the text is capped at `maxRenderChars`, and an oversized list comes back as the leading items plus `total` and `omitted` counts.

## Capturing one window

`hyprscope_screenshot` can capture one specific window instead of the layout, an output or a region. Pass exactly one selector inside `window`:

- `window.id`: a Hyprland address (`0x...`) or a foreign-toplevel identifier such as `180001c6`.
- `window.app`: the application id, which is the window class.
- `window.title`: the exact window title.

The capture uses ext-image-copy-capture rather than `grim`'s copy of the composited output, so the window is captured even when it is on a hidden workspace or covered by another window. `window` is exclusive with `monitor` and `region`, and `scope` must be omitted or `layout`; any other combination is rejected before the CLI starts. The path is read-only like the other captures: no lease, plan or capability baseline is involved, and the locked-session refusal is unchanged.

It needs the native window-capture helper, which the bundle does not build. Run `pnpm run build:capture` in the checkout once; it produces `bin/wl-capture`, and without it the CLI fails with a message that names the missing helper. The result keeps the same metadata, with `source.scope` set to `window` and `source.window` carrying `{identifier, appId, title}`.

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

Two points are worth knowing:

- The config is validated when the plugin activates: a value of the wrong type or outside its range fails activation, and DSH reports the plugin as failing instead of running with a silently wrong value.
- `projectDir` is re-checked on every call. When it does not contain `bin/hyprscope.ts`, the plugin still loads, but every call fails with a message that names the directory; once the CLI exists there, calls start working without a reload. Set `projectDir` when the bundle or the CLI is not where the default expects it.

## How the safety boundary holds

The plugin adds tools; it adds no permission. Everything it can do is one of the CLI's subcommands, and the boundary that decides is the CLI's: the read-only surface and the `control` surface. That boundary is described in [docs/PROTOCOL.md](/docs/PROTOCOL.md), and the lease and baseline contracts are in [docs/LEASE.md](/docs/LEASE.md) and [docs/BASELINE.md](/docs/BASELINE.md).

- **Read-only tools stay read-only.** `hyprscope_observe`, `hyprscope_screenshot` and `hyprscope_events` spawn only the bare `hyprscope` commands, never `hyprscope control`. The CLI's read-only side never loads the lease, the plan executor, the injection path or the desktop lifecycle, and the plugin does not import repository code at all: it starts the CLI as a separate process. The plugin never calls `hyprctl` or `grim` itself, and it never uses a shell.
- **Screenshots keep the locked default.** The screenshot tool refuses while the session reports locked; only a caller that sets `allowLocked: true` makes it pass `--allow-locked`. No retry or default flips it.
- **Control starts with the lease.** `hyprscope_lease` action `request` is how these tools ask for control. On the user's desktop it shows the host's consent card and waits for the host's decision; the model cannot answer that card, and no tool parameter approves it. Inside an agent or external desktop the consent was given once at `desktop start` or `attach`, and the lease there is programmatic: still bound to the submitted plan and TTL, and never available on the user's desktop.
- **Plans are the only way to change the desktop.** `hyprscope_plan` action `run` executes a validated plan after consent. The executor re-reads the lease and checks its plan binding before every mutating call, and the injection helper re-verifies the lease proof itself. `validate` is a dry run: no card, no desktop change. A run that faults returns the facts for replanning, not a bypass.
- **Single-step actions are one-step plans.** `hyprscope_act` does not implement an action: it puts the submitted step into a plan skeleton (`version`, `id`, `reason`, `steps: [step]`) and submits it through the same run path. The CLI validates it exactly like a multi-step plan, the consent card shows the same one-step preview, and the executor and lease gates are unchanged. `requires`/`expect` stay the caller's responsibility; the wrapper generates no premises.
- **Control is gated by an accepted capability baseline.** When the baseline is missing, still a draft, incomplete, stale or unverified, a plan run (including a dry run) or a lease request fails with `CAPABILITY` before any consent card appears. The error names the next step: run `hyprscope_baseline` with `action: "probe"` and explain the evidence. When the measurement widens the accepted baseline, that same call asks the desktop for a confirmation card carrying the verdict, the capability counts and the evidence hash, and returns only after the host clicks Allow or Deny; it writes nothing when the card is denied or expires (the draft stays pending, and another probe asks again), and the tool never answers the card itself. The probe itself takes a lease and injects only into its own scratch window.
- **Agent desktops are lifecycle, not mutations.** `hyprscope_desktop` action `start` may only launch its own nested compositor, `attach` only records an instance the host names, and `stop` only ends the desktop it started. They never move, focus or close a window on the host's desktop; `status` is safe to poll.

## Limitations

- **One process per call.** A call starts Node, loads the CLI, rediscovers the session and exits. That is what keeps the gate intact and the result honest, but it costs the process startup and discovery time on every call, and nothing is batched or kept warm. A plan is one call; issuing the same steps as separate tool calls is slower and no safer, and `hyprscope_act` is exactly that for a single step: one action, one consent card, one short lease.
- **Events is a bounded wait, not a subscription.** `hyprscope_events` keeps the call open until `count` or `once` is satisfied or `timeoutMs` runs out; an expired wait is a success with `timedOut: true`, not an error. A DSH session cannot use it to watch the desktop continuously.
- **Results are compacted.** The text a model reads is capped at `maxRenderChars`: a long list is reduced to the leading items plus `total` and `omitted`, the `doctor` view drops `capabilities.wayland.globals`, and an oversized state falls back to a summary. The parsed value keeps the CLI's JSON for programmatic callers, but a model that reads only the text can miss fields; ask for a narrower `kind` when a list matters.
- **It wraps a checkout, not a release.** The tools run this repository's `bin/hyprscope.ts` and depend on its `--json` shapes. The directory has to stay in place, and a CLI change can change what a tool returns. It also does not build the C helpers: plans that inject still need `bin/wl-inject`, the baseline probe still needs `bin/wl-scratch`, and a window capture needs `bin/wl-capture` from `pnpm run build:capture` (the quick start in [README.md](/README.md) covers the first two).
- **Images need an image-capable route.** The screenshot tool attaches the PNG only when the session has an attachment store and the routed model declares image input. Otherwise, with no store, a text-only route, an unresolved route or a failed save, the result still carries the path, size and hash with an `imageError` note, and the capture itself still succeeds.
- **No CUA provider.** The bundle gives the model tools; wiring the same operations into DSH's CUA provider is future work, not part of this plugin.
- **Control stays human-gated.** No tool can answer a consent card or skip the lease. When a baseline is missing or stale, an agent can probe and explain; when the probe widens the baseline it asks for the acceptance confirmation card itself, and the host's click is what accepts. No tool can click that card.
- **Verification status.** This page documents the bundle's contract; it is not a verification record. The repository's [verification record](/docs/VERIFICATION.md) covers the CLI on one test machine and says nothing about the DSH tools on yours; the bundle's own tests live in `plugins/dsh-hyprscope/test/`.
