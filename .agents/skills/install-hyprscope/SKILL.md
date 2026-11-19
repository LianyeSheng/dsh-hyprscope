---
name: install-hyprscope
description: Install, build, and verify a hyprscope checkout on Linux. Use when the user asks to install, set up, bootstrap, provision, deploy, re-verify, or troubleshoot hyprscope (dsh-hyprscope); build its Wayland probe, injection, scratch or window capture helpers; run its doctor/environment check; accept or refresh its capability baseline; or install its native DSH plugin. Apply this skill for hyprscope installation even when the request is only "set this up on my machine", "make hyprscope work", or "why can't hyprscope control my desktop".
---

# install-hyprscope

Install one checkout end to end, and leave a clear record of what worked, what was skipped, and what still needs the host's approval.

The install has six stages:

1. Locate the checkout and detect the environment.
2. Install missing system dependencies, with the host's permission.
3. Install, build, and test.
4. Prove the CLI can see the desktop.
5. Measure and accept the capability baseline.
6. Optionally install the DSH plugin.

Run them in order. A missing compositor makes stage 5 unavailable; it does not justify skipping stages 1-3 or 6.

## Boundaries

These are the product's safety model, not style preferences.

- Consent cards are answered by the host. `control baseline --probe` only raises cards: the lease card for the measurement, then the acceptance card when the measurement widens the accepted baseline. Never click, script, synthesize, or pre-approve a card; never edit `baseline.json` or a pending draft by hand.
- `control baseline --probe` is not read-only. On a machine with an accepted baseline, a re-probe that only narrows rewrites `baseline.json` in place and keeps the old approval, without a second card. Tell the host before running it, and never use it as a harmless check.
- Desktop actions go only through the CLI's plan and lease path. Never call `hyprctl dispatch`, never add `--allow-locked` to get around a refusal, and never bypass the baseline gate. The only Hyprland configuration change this skill may make is the optional shortcut installer in stage 5 (failsafe and desktop-message binds), and only with the host's consent.
- Use pnpm for this repository. Never `npm install` the project or its dependencies.
- Do not regenerate `pnpm-lock.yaml`, edit `out/`, or commit build artifacts.
- If a required check fails, stop and report it. Do not skip a gate to make the install look complete.

## 1. Locate the checkout

Ask for the path if the user has not given one. Resolve the repository root and confirm it is hyprscope:

```sh
repo="$path"
test -f "$repo/bin/hyprscope.ts" || repo="$(git -C "$path" rev-parse --show-toplevel)"
grep -q '"name"[[:space:]]*:[[:space:]]*"dsh-hyprscope"' "$repo/package.json"
```

If there is no checkout yet, ask for the clone URL and a target directory, clone only after the host provides them, and do not guess a remote. If the path is not that checkout, stop and ask; do not install a different project. The checkout must stay where it is: the DSH plugin links to it instead of copying it.

Record the commit for the final report:

```sh
git -C "$repo" rev-parse --short HEAD
```

Run the read-only preflight:

```sh
bash "$repo/.agents/skills/install-hyprscope/scripts/preflight.sh" "$repo"
```

It prints `ok`/`warn`/`MISS` lines and exits non-zero when a required item is missing. That exit code is a report, not a crash. It installs nothing.

Preflight proves install prerequisites, not control readiness. Quickshell and a Hyprland session are warnings there; `doctor` and the baseline decide whether control works.

### What matters

| Check | Why | Missing means |
|---|---|---|
| Node 22.18+ with type stripping | Runs `.ts` directly; there is no build step | The CLI cannot start |
| pnpm 12.20.0 | Pinned package manager; the lockfile is pnpm v9 | Dependencies cannot be installed |
| gcc, pkg-config, wayland-client | Compile the four C helpers | Control, probe and window capture are unusable |
| wayland-scanner, wayland-protocols | Generate protocol bindings | `build:inject`, `build:scratch` and `build:capture` fail |
| Quickshell | Draws the consent card and lease banner | Control and baseline probe fail with `OVERLAY_FAILED` |
| A Hyprland session | `doctor`, probe, baseline, control | Read-only `doctor` fails with `NO_SESSION` |
| grim | Screenshots | Observation still works |
| DSH | Optional plugin stage | Skip stage 6 |

The practical Node floor is 22.18: `node -p "process.features.typescript"` must print `strip` (or `transform`), not `undefined`. The package's `engines` field says >=22, but running `.ts` without flags needs 22.18; CI verifies Node 24.10. A newer local Node works but is not covered by CI.

## 2. Install missing system packages

Only after the host agrees. Match the distribution, show the command, then run it:

| Distribution | Command |
|---|---|
| Debian/Ubuntu | `sudo apt-get update && sudo apt-get install -y build-essential pkg-config libwayland-dev wayland-protocols grim` |
| Fedora | `sudo dnf install -y gcc gcc-c++ make pkgconf-pkg-config wayland-devel wayland-protocols-devel grim` |
| Arch | `sudo pacman -S --needed base-devel pkgconf wayland wayland-protocols grim` |
| openSUSE | `sudo zypper install -y gcc gcc-c++ make pkg-config wayland-devel wayland-protocols-devel grim` |

Quickshell is not packaged identically across distributions. Install it from the distribution or upstream, or point `HYPRSCOPE_QUICKSHELL` at an existing `quickshell`/`qs` binary. The CLI looks for `quickshell` by default, so if the system only provides `qs`, export `HYPRSCOPE_QUICKSHELL=qs` (or its absolute path). Without it, observation still works but consent cards cannot appear, so control is unavailable.

For Node and pnpm, prefer the user's version manager. If `pnpm --version` already matches 12.20.0, skip the bootstrap. If neither exists and the host agrees:

```sh
corepack enable
corepack prepare pnpm@12.20.0 --activate
```

If corepack is unavailable, `npm install --global pnpm@12.20.0` installs only the package manager; the project's own dependencies still go through pnpm.

## 3. Install, build, test

```sh
cd "$repo"
pnpm install --frozen-lockfile
pnpm run build:probe
pnpm run build:inject
pnpm run build:scratch
pnpm run build:capture
pnpm run typecheck
pnpm test
```

The lockfile is authoritative. If `--frozen-lockfile` fails, stop and report the mismatch; do not delete the lockfile or run an unfrozen install silently.

Running this stage again is safe: the install and builds are idempotent. If the checkout changed, rebuild the helpers and run `doctor` again; it reports whether the baseline is still fresh.

The build scripts need the packages from stage 2. On success they create `bin/wl-globals`, `bin/wl-inject`, `bin/wl-scratch` and `bin/wl-capture`; those paths are gitignored. `build:capture` generates the vendored ext-foreign-toplevel-list, ext-image-capture-source and ext-image-copy-capture bindings under `tools/capture/generated/` and links `bin/wl-capture`; it needs `wayland-scanner` and the wayland-protocols development files, like the other helper builds.

`pnpm test` runs the unit tests and the live tests. The live tests skip themselves when no Hyprland session is reachable; skipped live tests are expected on a headless machine, not a failure.

If the sandbox makes `$XDG_RUNTIME_DIR` or the default store unwritable, give pnpm a writable temp/store directory for the install only:

```sh
TMPDIR="$repo/.tmp" XDG_RUNTIME_DIR="$repo/.tmp" \
  pnpm --store-dir "$repo/.pnpm-store" install --frozen-lockfile
```

Use both variables for the install only. A fake `XDG_RUNTIME_DIR` would hide the real session from `doctor`, the probe, and the baseline.

## 4. Prove the CLI sees the desktop

With the real session environment — run from the graphical session, or set `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`, and `HYPRLAND_INSTANCE_SIGNATURE` correctly — run:

```sh
node bin/hyprscope.ts doctor --json
```

Success means the JSON has `readOnly: true`, a `compositor` block, and a `baseline` block. `doctor` is read-only. Exit code 1 with `NO_SESSION` means this shell cannot see Hyprland: the install may still be fine, so report it and skip stage 5.

Also run one read-only snapshot to catch discovery errors:

```sh
node bin/hyprscope.ts state --json
```

And one window capture, which is still read-only. Pick a mapped window's class from `state`:

```sh
node bin/hyprscope.ts screenshot --window-app <class> --output "$repo/out/window.png" --json
```

Success means the JSON has `source.scope: "window"`, a `source.window` with `identifier`/`appId`/`title`, and the PNG exists. It only works for mapped windows, so pick one that is not minimized. If the helper is missing the command says to run `pnpm run build:capture`; if the compositor does not advertise `ext-image-copy-capture`, `ext-foreign-toplevel-list` and `ext-image-capture-source`, window capture is unavailable while layout, monitor and region captures still work through `grim`.

When `--window-app` or `--window-title` matches more than one window, the command exits 2 and lists each candidate as `0x… address, app id, workspace, title, on active workspace or off-screen`; pass one of those addresses to `--window-id`. An explicit `--output` must be in a directory that already exists and is writable (the default `$XDG_CACHE_HOME/hyprscope` is created as needed); otherwise the command fails with `SCREENSHOT_FAILED` before capturing and tells you to pass `--output <writable path>`.

## 5. Capability baseline

**A probe is not read-only.** On a machine with an accepted baseline, a re-probe whose measurements only narrow the effective set rewrites `baseline.json` in place (a `narrow` revision) and keeps the old approval, without any card. A probe that adds or upgrades capability evidence writes a pending draft and, in the same run, shows the host the acceptance card and waits for the answer; a denied or expired card leaves the draft pending and another probe asks again. Tell the host which case may occur before you run it.

Control is gated by a human-approved capability baseline. It answers "does this machine support what a plan needs", not "is this action allowed"; the lease answers the second question separately.

A plan that takes a window screenshot is gated by the optional `capture.window` capability, which a baseline accepted before this feature does not grant. Adding a capability id is a widening, so after updating an existing checkout that already had an accepted baseline, probe again and have the host answer the acceptance card that probe shows before plans that capture a window can run; the read-only `screenshot` command is unaffected and needs no baseline.

Check freshness through `doctor`, not `--show` alone. `--show` reports the file's state; `doctor` compares it with the running compositor:

```sh
node bin/hyprscope.ts doctor --json
```

Read `.baseline.present`, `.baseline.state`, `.baseline.staleness.verdict` (`fresh`, `stale`, or `unverified`), and `.baseline.staleness.reasons`. If `present` is true, `state` is `usable`, and the verdict is `fresh`, the baseline is current; skip to stage 6.

If `present` is false, or `.baseline.staleness` is absent, a probe is needed. If the verdict is `stale` or `unverified`, the file exists but no longer describes this machine; probe again.

If the verdict is `fresh` but `state` is `degraded`, control is available with a missing safety path (for example `safety.failsafe-bind`); report the degraded capabilities instead of calling the machine clean. If `state` is `incomplete`, required capabilities are missing and control is refused; report the missing required set before suggesting another probe.

For detail, which is also read-only:

```sh
node bin/hyprscope.ts control baseline --show --json
```

This shows `pending` (a draft from an earlier probe), `missingRequired`, `degraded`, and `reason`. A usable state with a stale verdict still needs a probe; the file is valid but no longer matches this machine. `--show` cannot compare a pending draft with the running compositor; only a probe does that. If you cannot show the draft was measured on this machine and configuration, re-probe rather than accept an old draft.

### Managed shortcuts (recommended)

Install the `SUPER + ALT + ESC` hand-back and the `SUPER + ALT + M` desktop-message shortcut before probing so the baseline measures the final bind count; installing them afterwards changes the bind count and makes the baseline stale.

```sh
node bin/hyprscope.ts control install-bind                              # failsafe + desktop message
node bin/hyprscope.ts control install-bind --message-key "SUPER + ALT + D"
```

This edits the user's Hyprland configuration (with a timestamped backup), adds a marked Lua block with both binds, verifies both descriptions, records the message key where the overlay reads it, and runs `hyprctl reload`; ask first. It applies only to the user's desktop and expects the Lua config provider. If the host declines or the configuration is not Lua, skip it: the baseline reports `safety.failsafe-bind` as degraded, and the TTL, `done`, and the banner button still end control. The desktop-message shortcut is optional: if the host only wants the failsafe, say that `--message-key` still installs both binds today, so the only way to omit it is to leave the whole installer out.

The message shortcut runs `hyprscope message open`. Test the command itself (it is read-only and takes no lease) once the overlay runtime is installed:

```sh
node bin/hyprscope.ts message open --json
```

A result with `"dsh": "unavailable"` is expected while no `hyprscope` DSH Host is running; it still proves the overlay can start and the request file was written. `NO_SESSION` means this shell cannot reach the compositor, and `OVERLAY_FAILED` means Quickshell is missing.

Before probing, confirm Quickshell is available (stage 2). Without it the consent card cannot appear and the probe fails with `OVERLAY_FAILED`.

When a probe is needed, explain what will happen — a short-lived scratch window, a lease consent card and, if the measurement widens the baseline, an acceptance card in the same run, about a minute — and run it only when the host is ready to answer:

```sh
node bin/hyprscope.ts control baseline --probe
```

Wait for the lease card. On approval the probe measures; a result that only narrows applies itself, while a widening result shows the acceptance card in the same run and waits. The command then prints the resulting state, missing capabilities and the evidence directory (`out/baseline/<probeId>/`), so there is nothing left for a separate acceptance step. Review the result:

```sh
node bin/hyprscope.ts control baseline --show --json
```

If the acceptance card was denied or expired, nothing is accepted: the draft stays pending, so explain what is missing or degraded and re-run the probe later to ask again; there is no separate acceptance command to fall back on. Never click the card yourself and never hand-edit the baseline. After the host allowed the card, run `doctor --json` again and report the new verdict.

Re-probe after a machine change, a Hyprland upgrade, or a configuration change that affects binds, layout, or input. A probe that only narrows capabilities applies itself; anything wider asks for a fresh acceptance in the same run.

If there is no session, skip the rest of this stage with "baseline skipped: no Hyprland session". Control stays unavailable, which is the correct state, not an install defect; stage 6 can still run.

## 6. Optional: DSH plugin

Skip this stage unless DSH is present. DSH is present if any `hyprscope_*` tool is available, `$DSH_HOME` is set, `~/.local/share/deepseek-harness` exists, or `dsh` is on `PATH`.

If `hyprscope_observe`, `hyprscope_plan`, and the other `hyprscope_*` tools are already available, the plugin is installed; do not reinstall it. Verify the wiring instead:

```
hyprscope_observe(kind: "doctor")
```

That call runs the CLI through the plugin and proves the plugin, Node, and session discovery agree. The result also carries `pluginVersion` (the bundle's `package.json` version read when the Host loaded it) and `cliPath` (the absolute `bin/hyprscope.ts` it spawns): compare them with the checkout to prove the Host is running the code you edited, not a stale in-memory copy.

Otherwise install the bundle from this checkout. It is a Host-only, Linux-only bundle and links the checkout, so the path must stay valid. First check the profile's Plugins list (or `plugin_manager` list) for `@local/dsh-hyprscope`: if it is already listed but its tools are absent, reload the profile instead of installing a second copy.

- If the `plugin_manager` tool is available, call `install_bundle` with
  `target: "<absolute repo>/plugins/dsh-hyprscope"`.
- Otherwise tell the host to open **Plugins → Add plugin** and enter
  `<absolute repo>/plugins/dsh-hyprscope`.

The install is a symlink, not a copy. In the web profile of a development checkout it usually sits at `~/.dsh/profiles/web/node_modules/@local/dsh-hyprscope`, pointing at `<absolute repo>/plugins/dsh-hyprscope`; `$DSH_HOME` may be elsewhere, so read the link instead of assuming the path.

After installation the profile has six `hyprscope_*` tools. If they do not appear, reload the plugin or restart DSH; a bundle installed without HMR can report `restart-required`. Then call `hyprscope_observe(kind: "doctor")` again.

**Restart DSH after editing the plugin.** The Host loads `plugins/dsh-hyprscope/index.js` into its own process and does not watch the file: the running Host keeps the old code and the old tool schemas. Without a restart, a parameter added to a tool definition is absent from the schema and passing it is silently ignored, and `doctor` keeps reporting the old `pluginVersion`. After restarting, call `hyprscope_observe(kind: "doctor")` and check that `pluginVersion` equals the checkout's `plugins/dsh-hyprscope/package.json` version and `cliPath` names the checkout's `bin/hyprscope.ts`; a mismatch means the Host is still on the stale in-memory copy.

The same restart starts the desktop-message bridge when the profile exposes `sessionController` (the Web and Desktop bundles do) and `desktopMessage` is not disabled. To verify it after the restart, run `node bin/hyprscope.ts message open --json`: `"dsh": "available"` means the Host heartbeat is fresh and the composer request was written; the hint pill should be visible at the top-right with the key recorded by the installer. A headless profile has no hint because it has no `sessionController`, which is not a failure. If the overlay starts and then dies, the bridge notices on the next heartbeat and starts it again; check `$XDG_STATE_HOME/hyprscope/message/overlay.log` and `status.json` when it keeps failing. Do not leave the composer open while talking to the host; Esc closes it.

If the plugin loads but every call fails naming `projectDir`, set `projectDir` in the profile's `hyprscope` row to this checkout instead of moving the checkout. Do not install DSH itself, and do not change the user's Hyprland configuration for the plugin.

### Capturing a consent card from an agent session

A consent-showing tool call intentionally blocks until the host answers or the card expires: `hyprscope_plan` (`run`) and `hyprscope_baseline` (`probe`) both wait for the human decision. There is no separate lease request tool and no agent-side done/panic. That blocking is the consent contract; never make the tool asynchronous to simplify capture, and never answer the card yourself.

To capture a card, raise it outside the tools as a background job and screenshot with a timed read-only call:

```sh
# background job (not a tool call): a no-op plan raises the consent card; the run waits for the host
printf '%s\n' '{"version":1,"id":"card-capture","reason":"card capture","steps":[{"op":"pause","ms":100}]}' > /tmp/hyprscope-card-plan.json
node bin/hyprscope.ts control run /tmp/hyprscope-card-plan.json --consent 120 --lang en
```

The background command is the CLI form of the `hyprscope_plan` `run` tool; the tool itself blocks the same way, which is why the capture has to run outside it. Control must already be available: a missing or stale baseline fails with `CAPABILITY` before any card appears, so probe and let the host accept it first. From the agent session, after about a second:

```
hyprscope_screenshot(scope: "layout", output: "/tmp/hyprscope-card.png")
```

Screenshots are read-only, so repeat one if the first is early. Have the host answer the card or let it expire, then stop the job; the agent must never approve it. The same recipe captures the baseline probe's acceptance card.

## 7. Report

End with a short factual report, not an assurance:

```
Checkout: <path> (commit <short sha>)
Environment: <distro>, Node <version>, pnpm <version>, Hyprland <version or "not visible">
Built: wl-globals, wl-inject, wl-scratch, wl-capture | or what failed
Tests: pnpm test <pass/fail/skip counts>
Failsafe: <installed|skipped>
Desktop message: <installed|"SUPER + ALT + M" recorded|skipped>
Baseline: <none|usable|degraded|incomplete>, freshness <fresh|stale|unverified|n/a>, approved <time or "—">, missing <capabilities or none>
DSH plugin: <not detected|already installed|installed|needs restart|not verified>
Desktop message bridge: <hint visible|no sessionController|disabled by config|not verified>
Needs you: <approve probe card / approve acceptance card / install packages / restart DSH / refresh stale baseline / fix a lockfile mismatch / nothing>
```

Mark anything skipped as skipped. Never report "installed" for a stage that did not complete, and never claim the baseline is accepted unless `doctor` reports a fresh, usable verdict.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `doctor` exits 1 with `NO_SESSION` | This shell cannot see the compositor | Run from the graphical session, or set `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`, `HYPRLAND_INSTANCE_SIGNATURE`; do not fabricate a session |
| Build fails on `wayland-client` or `wayland-scanner` | Development packages missing | Install the stage 2 packages |
| `build:scratch` cannot find `xdg-shell.xml` | `wayland-protocols` missing | Install it; the script reads `pkg-config --variable=pkgdatadir wayland-protocols` |
| `pnpm install` fails with permissions under `/run/user` | Sandboxed runtime directory | Use `TMPDIR` and `--store-dir` as shown; keep the real session for runtime commands |
| Control fails with `CAPABILITY` before a consent card | Baseline missing, stale, or unverified | Probe; when it widens the baseline, the host answers the acceptance card in the same run; do not bypass |
| `OVERLAY_FAILED` when a card should appear | Quickshell missing, or `HYPRSCOPE_QUICKSHELL` points nowhere | Install Quickshell or set the variable to the real binary; check the overlay log in the lease state directory |
| Probe fails because `wl-scratch` is missing | C helpers were not built | Re-run `pnpm run build:scratch` |
| Window capture says the helper is not built, or plan/window capture fails with `SCREENSHOT_FAILED` | `bin/wl-capture` was not built this time, or the compositor does not advertise the ext capture protocols | Run `pnpm run build:capture`; if the protocols are missing, report that window capture is unsupported on this compositor and use `grim` captures instead |
| Plugin calls fail naming `projectDir` | The checkout moved | Set `projectDir` in the profile's hyprscope row; do not move the checkout |
| New tools are absent after install | The profile needs a reload or restart | Reload the plugin or restart DSH, then re-check `hyprscope_observe` |
| A plugin edit has no effect, or a new tool parameter is ignored | The Host still has the old bundle in memory; it does not watch `index.js` | Restart DSH, then compare `doctor` `pluginVersion` and `cliPath` with the checkout |
| A tool error mentions `EROFS` or a read-only state directory | The Host's `XDG_STATE_HOME` is not writable | Point `XDG_STATE_HOME` at a writable directory and restart DSH; the accepted baseline lives in the real state home |
| A card-showing tool call seems to hang | It is waiting for the host to answer the consent card | Intentional: capture the card with a background CLI job plus a timed screenshot, and never answer it for the host |

For the design behind the baseline, read `docs/BASELINE.md` and `docs/COMPATIBILITY.md`; for the plugin's configuration keys, read `docs/DSH-PLUGIN.md`.
