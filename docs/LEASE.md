# Control lease (`hyprscope control`)

English | [中文](/docs/LEASE.zh.md)

`hyprscope control` lets an agent briefly take over desktop control **after the host consents**, and gives control back when the run ends, the lease times out, or the host presses the shortcut. What it manages is "who is in control", not input interception: that point is spelled out under [boundaries](#边界为什么不做输入拦截) below.

## A full lease lifecycle

```
agent:   hyprscope control run plan.json
host:    a consent card pops up in the middle of the screen (allow / deny; auto-deny after 45 seconds)
host:    clicks allow
agent:   the run executes the plan under the lease, then hands control back when it ends
agent:   hits recoverable interference → writes interference.json and waits for the host's answer
host:    chooses "Continue execution"
agent:   renews the same lease and runs the derived recovery plan (1 by default, at most 3)
host:    SUPER + ALT + ESC          # or press this key at any time to interrupt
```

- `run` is the whole agent workflow: it validates the plan, shows the consent card in the same call, and after approval holds the lease for the run, executes the plan, and releases control; there is no separate acquire or hand-back command.
- A lease has a TTL (120 seconds by default): if the agent crashes, never releases the lease, or the process gets killed, control is returned automatically at expiry.
- The overlay has two faces: during consent it is a full-screen modal card that holds the keyboard exclusively; after approval it shrinks to a narrow strip at the top showing "Agent is controlling the desktop · time remaining", with "Revoke now" on the right. The strip does not intercept the mouse or keyboard, so the agent's injection is not blocked.

Inside an agent or external desktop the human consented once, at `desktop start` or `desktop attach`. There `run` and `baseline --probe` obtain a **programmatic lease** with no card (`grantedBy: desktop`), and only because the desktop record carries that consent; a plan run still binds that lease to the submitted plan and its TTL, and `wl-inject` verifies the same proof. The user's own desktop never takes this path: it keeps the per-run card. A programmatic lease never spawns the overlay.

Closing the desktop's window does not by itself revoke a lease. `desktop stop` explicitly releases the stopped desktop's lease; a run interrupted by the compositor disappearing faults with `target.desktop-closed` and releases in its `finally` path; the internal holder keeps a lease that no run is releasing until its TTL.

## State and files

State machine: `consent` → `granted` → `released` / `denied` / `expired` / `revoked`. After a terminal state the lease never returns to `granted`.

For the user's desktop the state directory is `$XDG_STATE_HOME/hyprlease` (default `~/.local/state/hyprlease`, mode `0700`, files `0600`). An agent or external desktop is keyed by its instance signature and uses `$XDG_STATE_HOME/hyprlease/<signature>/`; the internal `HYPRSCOPE_LEASE_SIGNATURE` selects it, and it is not a user-facing option. The directory keeps the historical name `hyprlease`; that is an on-disk protocol name, not a second command. Every file below lives in the selected directory:

| File | Purpose |
|---|---|
| `state.json` | The single source of truth: phase, reason, start and end times, pids; when a plan is bound it also carries `planBound: true`, `planSummary`, `card` (what the consent card shows: the description and step lines, or the facts of an approval), `attempt`, `maxResumes`, `totalBudgetMs`, `renewals[]`; an approval-only request carries the same `card` with `approvalOnly: true` and `ttlMs: 0` |
| `decision.json` | Written by the overlay or the host during the consent phase as `allow` / `deny` / `panic` |
| `control.json` | Written by the host failsafe (`panic`), or by a run releasing control, to request the hand-back |
| `heartbeat.json` | Refreshed every 500ms by the requester and holder; used to tell whether the lease has lost its owner |
| `lease.lock` | Single-lease mutual exclusion; carries the `leaseId`, and a second lease request is rejected with `LEASE_ACTIVE` |
| `notice.json` | Short-lived notices published by the executor; the overlay shows one only while the `leaseId` matches and it has not expired, and at the start of a recovery it says "recovery N: …" |
| `progress.json` | Execution progress published step by step by the executor: `step`/`total`/`op`, `status`, `attempt`, `maxResumes`, `phase`; a derived attempt is `recovering` throughout, and the overlay renders the banner and receipt from it |
| `interference.json` | The blocking interference prompt published by the executor: id, step k/n, every broken premise, the recovery count, the extra budget, the deadline |
| `interference-decision.json` | `continue` / `abort` written directly by the overlay button, which must echo the prompt's `id` |
| `overlay.log` | The stderr of the Quickshell overlay |

State files all carry a `leaseId` check: a leftover hand-back record from an old lease does not end a new lease (covered by a regression test). Each new lease request also clears the previous round's decision/control/heartbeat at start.

The state directory is not placed in `XDG_RUNTIME_DIR`: the Harness file sandbox may mount `/run/user/<uid>` read-only, while the shortcut process (started from the compositor) and the agent process must reach the same files.

### Renewal and recovery fields

A plan run can recover recoverable interference, but it does not bring up the consent card again: the executor uses `renewLease` to extend the same lease to the next attempt, writing the next attempt and the new expiry back into `state.json`.

| Field | Meaning |
|---|---|
| `planBound` | Whether the lease approves a specific submitted plan: `true` for `run` and `baseline --probe`, `false` for an approval-only lease (internal, used by baseline acceptance) |
| `planSummary` | The consent-card preview the host saw: `steps`, `ops`, `workspace`, `summary` |
| `attempt` | The current attempt: `0` is the original plan, `1..maxResumes` are recovery attempts |
| `maxResumes` | The recovery count consent covers; default `1`, hard maximum `3` |
| `totalBudgetMs` | The total budget counted from `createdAt`, or `null` (unbounded); when `run` requests it, it is `(1 + maxResumes) × 计划 budgetMs` |
| `renewals[]` | One `{ at, attempt, ttlMs, expiresAt }` per renewal, in time order |

Every `renewLease` rule is checked against `state.json` on disk, and any violation reports `LEASE_MISMATCH` without changing the file:

1. Only renew a `granted` and unexpired lease, and the `leaseId` must match;
2. `attempt` must be exactly the current `attempt + 1`; it must not skip a number or exceed `maxResumes`;
3. The new expiry is "now + this TTL" and does not stack on the old expiry; each attempt's TTL for `run` is `计划 budgetMs + 20000ms`, leaving margin for prompts and settling;
4. Time budget: the sum of all recorded renewals' `ttlMs` plus this `ttlMs` must not exceed `totalBudgetMs + (renewals.length + 1) × 20000ms`;
5. On success, write back `attempt`, `expiresAt` and the appended `renewals[]`, and refresh the heartbeat; `leaseId` and `planBound` stay unchanged;
6. When an older `state.json` lacks these fields, use conservative values: `attempt` counts as `0`, `maxResumes` as `1` and `renewals` as empty; a state file that predates `planBound` is not plan-bound, so the executor and the injection helper refuse to run under it.

Renewal does not reopen the consent flow: what the host approves is the plan plus a fixed number of mechanical recoveries, and after every renewal the executor re-reads the lease and requires the attempt the renewal just started. `status --json` carries `planBound`, `planSummary`, `attempt`, `maxResumes`, `totalBudgetMs` and `renewals` (the count); the human-readable output shows `recovery k/maxResumes` when the attempt is greater than 0.

### One consent card

There is one consent card, `card: { title, lines[], acceptLabel, denyLabel }`, and one request path, `requestLease`. A plan lease fills it with the plan's description and steps; an approval-only request fills it with the facts of an act that changes no desktop state (today: the capability-baseline acceptance that a widening `baseline --probe` shows). The card is rendered in the language selected by `--lang <zh|en>`. The overlay renders the same card for both, and both answers travel through the same `decision.json`: the button writes its answer directly and the waiting process records the decision and continues, with no CLI command spawned for the click.

`approvalOnly: true` is the mode difference: the state keeps `ttlMs: 0` and `planBound: false`, the record ends `released` on `allow` (or `denied` / `expired` otherwise), never enters `granted`, starts no holder and grants no TTL, so the executor and `wl-inject` can never inject under it (`phase=granted` and `planBound: true` are both required). `grantedBy` still names who answered: `overlay` for the card, `desktop` for a managed desktop's programmatic consent.

### Interference prompt record

When a recoverable premise is broken, the executor first writes `interference.json` and then stops to wait instead of repairing it automatically. Fields:

| Field | Meaning |
|---|---|
| `leaseId` / `runId` | The owning lease and run |
| `id` | The unique id of this prompt; an answer must echo it, so an old reply cannot cross over |
| `step` / `total` | Which step (1-based) and the total number of steps in this attempt |
| `kind` / `detail` | The kind and description of the first broken premise |
| `attempt` / `maxResumes` | The recovery attempt this prompt would start (`1`-based, so the first is `1`) and how many are allowed in total |
| `budgetMs` | The execution window available to the recovery attempt after continuing (the plan's `budgetMs`) |
| `at` / `expiresAt` | Publish time and answer deadline; when `run` reaches the deadline it treats the answer as `abort` |
| `broken[]` | Every broken premise: `{ kind, detail, expected, observed }` |

The answer is written to `interference-decision.json`: `{ id, decision: "continue" | "abort", at, source }`. The overlay writes it directly when the host picks a button; the waiting process checks that the prompt still exists, that the `id` matches and that it has not expired, and the executor accepts only an answer with a matching `id`, clearing the prompt and the answer once it reads it. The overlay card, the countdown and the "Continue execution / Terminate operation" rendering are in `overlay/shell.qml`; the run semantics are in the next section.

`interferencePromptMs` constrains only this one wait; the wait does not consume the plan budget but does consume the lease TTL, which is why each attempt's TTL includes 20000ms of margin. If the lease is revoked during the wait, the run ends as `revoked`.

Inside an agent or external desktop there is no overlay and therefore no prompt: a restorable conflict faults the attempt, and the agent asks the host in the conversation instead.

## Commands

```
hyprscope control run <plan.json> [--consent 45] [--max-resumes 1] [--dry-run] [--json]   # ask for consent, execute, release
hyprscope control ops [--json]          # the operation catalog a plan can use
hyprscope control status [--json]       # phase, remaining time, holder/overlay pid, stale, recovery progress
hyprscope control panic [--json]        # emergency revoke (the shortcut and `desktop stop` run it)
hyprscope control install-bind [--key "SUPER + ALT + ESC"] [--message-key "SUPER + ALT + M"]
hyprscope control uninstall-bind
hyprscope control baseline --probe [--read-only] [--json]   # measure this machine; a widening result asks the host and writes the accepted baseline on Allow
hyprscope control baseline --show [--diff] [--json]         # review the accepted baseline and any draft
hyprscope control desktop start [--size WxH] [--consent-source chat|card] [--json]
hyprscope control desktop attach --runtime-dir <dir> [--signature <sig>] [--consent-source chat|card] [--json]
hyprscope control desktop status [--json]
hyprscope control desktop stop [--json]
```

Every `hyprscope control ...` command also accepts `--lang <zh|en>`: it selects the language of the consent or confirmation card and of the overlay it spawns. Omitted means the `HYPRSCOPE_LANG` environment value, else `zh`; an unsupported value is a usage error. The card content (plan preview lines, baseline confirmation lines, the reason and the recovery notices) and the overlay's own chrome follow it, while CLI stdout stays English.

`--desktop user|agent|external` selects the desktop that `run`, `ops`, `status`, `panic`, `baseline` and `desktop` address; omitted means `user`. `status` and `panic` operate on that desktop's per-signature lease, so `panic` must name the desktop that holds it.

`run` first reads the accepted capability baseline of the desktop it addresses — the machine-wide `$XDG_STATE_HOME/hyprscope/baseline.json` for `user`, or `$XDG_STATE_HOME/hyprscope/desktop/baseline/<signature>.json` for `agent`/`external` (see [BASELINE.md](/docs/BASELINE.md)): when it is missing, still a draft, `incomplete`, or its staleness verdict is not `fresh`, they fail with `CAPABILITY` before any consent card appears, so the host is never asked to approve something this machine cannot run. `baseline --probe` is the one control path that works without a baseline, because it is what creates one; it still takes its own short lease.

`--max-resumes` takes `0..3` (default `1`) and is the recovery count the consent card covers: `0` means the first recoverable interference faults directly without showing the prompt card. `--dry-run` prints this allowance too. `--consent` applies to `run` and to `baseline --probe`; each attempt's TTL for `run` is the plan's `budgetMs` plus 20000ms of margin.

Exit codes: `run` exits 0 when the plan completes, 1 when it faults, is revoked, or consent is denied or times out; invalid arguments exit 2. The detached lease holder is an internal module entry started by the lease code, not a CLI command and not part of the documented surface.

`install-bind` appends a marked block with two `hl.bind(...)` calls to `~/.config/hypr/hyprland.lua`: the failsafe (`control panic --source shortcut`) and the desktop-message shortcut (`hyprscope message open`, default `SUPER + ALT + M`, `--message-key` overrides it). It first checks neither key is taken, makes a timestamped backup, runs `hyprctl reload`, then confirms both `description` fields in `hyprctl binds -j`; if either is missing it rolls the configuration back and reports `BIND_FAILED`. It also records the message key in the message state directory the overlay reads. `uninstall-bind` removes the block, the shortcut record and the generated Lua file, and reloads. Both the new `hyprscope` marker and the historical `hyprlease` marker are accepted when replacing or uninstalling; a bind installed before the CLI merge points at the deleted `bin/hyprlease.ts` and has to be reinstalled. The desktop-message shortcut is not a control path: it opens the composer and the message is typed through the Host's prompt admission. Because installing or removing either bind changes the bind count the capability baseline records, an accepted baseline becomes stale after `install-bind`/`uninstall-bind`; re-probe before the next control run.

Why inline the bind into `hyprland.lua` instead of a separate file plus `dofile`: on the test machine's 0.57 Lua configuration, indirect registration through `dofile`/`require` does not take effect on reload, and only an inline `hl.bind` is reliable (measured).

## Failsafe chain

From the most reliable to the least:

1. **The shortcut** `SUPER + ALT + ESC`: a compositor-level bind, unaffected by whether the overlay grabs the keyboard. The command is an absolute path and links to `hyprscope control panic`.
2. **"Revoke now" on the overlay**: one mouse click ends it, with no keyboard needed.
3. **TTL expiry**: the holder returns control on time without relying on either side's cooperation.
4. **Heartbeat stale-owner cleanup**: when the holder/requester heartbeat has not been updated for more than 5 seconds, the next `status` or `run` marks the lease `revoked` and clears the overlay and the lock.
5. **`panic`'s forced path**: if no terminal state arrives within 5 seconds after writing `control.json`, it kills the overlay itself (only processes whose `/proc/<pid>/comm` is quickshell), writes the terminal state, and releases the lock.

Input already sent cannot be undone (once injection is enabled), so every path's semantics are "stop subsequent actions + release pressed keys/buttons", not rollback.

## Boundaries: why we do not intercept input

The test machine was measured to have only one `wl_seat`, and the sandbox has no `/dev/input` and no usable `sudo`. The conclusion is direct:

- On the same seat, a layer-shell exclusive keyboard focus intercepts the host's and the agent's virtual keyboards at the same time; a full-screen input region swallows pointer events on both sides. **There is no way to intercept only the host's input without also intercepting injection.**
- Real physical isolation would require giving the agent a separate compositor session (nested or headless), or grabbing the physical device through evdev (which needs input-group/udev permission, and once the keyboard is intercepted the shortcut stops working too, so the failsafe would need a separate design).

So the lease is **protocol-level mutual exclusion plus collaboration**: consent, visibility, interruptibility, expiry. It guarantees that "control has a clear owner and a clear way to end", not that "the host physically cannot move the mouse". Neither the documentation nor the `status` output should let anyone believe the latter.

### Consent is not a security boundary

This has to be written down: the consent card renders on the same seat, so any process able to inject pointer/keyboard input can click the "allow" button. We measured it once: a single click sent to the button's coordinates with `bin/wl-inject` closed the card — that test was checking whether the button was really clickable, but it also proved that the card itself is not authentication.

What can be gated today: the injection helper requires the caller to provide a **granted** lease proof (`--lease-state` + `--lease`), re-reads `state.json` before each injection, and requires `phase=granted`, a matching `leaseId`, `planBound: true` and an unexpired lease. Injection during the consent phase (`consent`) is therefore always rejected, and the agent can no longer use the official helper to click its own consent card. An approval-only lease (internal, used by baseline acceptance) has `planBound: false`, so this proof also fails for "approve first, then click allow".

What it does not stop: under the same uid, an agent able to run arbitrary code can write its own Wayland client and inject with the same protocol, or forge `state.json` or `decision.json` directly. Only two paths give a real boundary: hand the lease state and the injection channel to a broker under a separate uid (so the agent side cannot reach the compositor socket or the state directory), or give the agent a separate compositor session. Until then, the consent card serves **visibility and awareness**, not authentication.

## Interface with the plan executor

There is only one write entry: `hyprscope control run <plan.json | ->`. It reads and validates the plan once, from a file or from stdin, and then puts `planBound` and `planSummary` into the lease request; the consent card therefore shows "which plan is being approved", not "lend me a while".

Before **every** state-changing call the executor re-reads `state.json` and requires all of: the phase is `granted`, the `leaseId` matches the one at request time, `planBound` is `true`, and the lease has not expired. If any fails it ends the whole run as `revoked` — so after a `panic`, a TTL expiry or a lease change, no queued keypress or click lands anymore.

Recoverable interference is not repaired in place. The executor writes `interference.json` and stops to wait: the overlay shows a modal card with the broken premises, the step number, the recovery number and a countdown, and waits for you to choose "Continue execution" or "Terminate operation" (Esc terminates, Enter continues). If you choose continue, the executor does not replay the interrupted step: it first suspends this attempt, then synthesizes a derived plan from the broken premises (the restore steps first, then the remaining steps of the original plan from the interrupted step on), then renews the same lease and executes with the new hash. A recovery attempt gets its own execution window, but only the first attempt can trigger a recovery; a premise broken again during recovery faults directly. If you choose terminate, no answer arrives before the deadline, or the premise cannot be recovered at all, the run ends as a fault and hands the facts back to the upper layer for replanning (which premise, the steps already confirmed, the timeline, and the live screenshot).

The `id` in `interference.json` prevents old replies from crossing over. What the host approves is the root plan plus `maxResumes` mechanical recoveries: hash binding, lease gating and fault-record semantics are unchanged, and a recovery just walks the "another plan" path once.

This also means that when the host touches the desktop in the middle of plan execution, they are asked first rather than silently "corrected". These are collaborative semantics, not a forced freeze; the reason is in the previous section.

Plan format, the predicate table, the recovery model and fault records are in `docs/PLAN.md`.

## Current limitations

- The shortcut is bound only at the Hyprland level; when the bind is not installed, the overlay button and the TTL are the fallback.
- Recovery only covers premises that are observable and rebuildable with the dispatch subset: closing a window, switching the app UI and changing a monitor all fault directly; recovery does not ask the host again, and it does not recover a second time.
- `interferencePromptMs` can be longer than each attempt's TTL margin (20000ms); waiting too long hits lease expiry first, and the run ends as `revoked`.
- Multi-user/multi-seat scenarios are unverified; several unrecorded Hyprland instances of one user share the machine-wide lease directory and its single lease slot distinguished by `leaseId`, while recorded agent and external desktops each get their own per-signature directory.
- The overlay uses Quickshell 0.3.2's layer-shell; an environment without Quickshell reports `OVERLAY_FAILED` (a fake overlay can be injected for headless tests).
- The 500ms heartbeat is process-level evidence; across pid namespaces (for example looking from outside a sandbox into it) it misjudges a lease as `stale`, and `stale` in `status` is only a diagnostic hint.
