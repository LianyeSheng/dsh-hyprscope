# Plan contract (`hyprscope control run`)

English | [中文](/docs/cli/PLAN.zh.md)

A plan is a bounded, statically reviewable sequence of desktop actions that the
human approves as one unit. This document is the contract between the author who
writes a plan and the executor that runs it under the control lease in
[LEASE.md](/docs/cli/LEASE.md); observation stays read-only as specified in
[PROTOCOL.md](/docs/cli/PROTOCOL.md). The author supplies data, the executor owns the only
code path into the compositor.

## 1. Positioning

A plan is data, not code: no expressions, branches, loops, or dispatch beyond the
catalog in §4. Consent binds to the submitted plan itself (§8), not to a time
window, so an approval cannot be stretched over a different plan or an open-ended
session.

Execution is `preflight -> commit -> verify` per step. The executor is
deterministic and never reasons: an attempt completes, faults with a cause, or
suspends so a derived recovery plan can run (§6); the human can revoke the lease
at any time. It never takes an action the plan did not state and never invents a
recovery outside §6. Steps run in array order, one at a time, and `budgetMs`
bounds one attempt.

| actor | writes | authority |
|---|---|---|
| author (agent) | plan documents, observation reads | proposes actions |
| executor (`hyprscope control run`; internal measure mode) | desktop mutations, run artifacts | sole injector |
| human | consent decisions, physical input | grants and revokes at any time |
| observer (`hyprscope`) | nothing | read-only |

A run addresses one desktop: `--desktop user|agent|external` selects it and defaults to `user`. `--dry-run` takes the same selector, so validation and the capability checks run against the desktop the real run would use.

### Internal measurement mode

The executor can run one plan as a measurement, so the probe's desktop-changing work goes through the same validation, lease binding and per-call lease gate as an authored plan — the executor remains the only injector. The mode is internal: only the probe selects it, its measure plan is built by `src/compat/probeplan.ts` from facts the probe already measured read-only, and its steps are ordinary catalog ops carrying `requires`/`expect`; the plan is shown on the probe's consent card like any plan preview. `runPlanFile` never sets the mode and validation has no field for it, so `hyprscope control run` and plan documents cannot request it.

Measurement changes the failure policy: a step whose premise does not hold, whose dispatcher is rejected, or whose postcondition does not read back is recorded and execution continues, and those records are the measurement evidence. Only safety failures stop the run — a lost or revoked lease, the plan's time budget, or a foreign desktop change. Recovery never runs in measure mode: the run neither suspends for a derived plan nor asks the human through an interference prompt, and the probe keeps its own lease and re-checks it before every mutation. A measure plan targets only the probe's own scratch window through the symbolic `app`/`title` selector `hyprscope-scratch`; no measurement may target a user window.

## 2. Plan schema

```json
{
  "version": 1,
  "id": "live-terminal",
  "reason": "Type one line into a scratch terminal and capture the result",
  "summary": "focus, click, type, Return, capture",
  "workspace": "agent",
  "budgetMs": 8000,
  "settleMs": 800,
  "interferencePromptMs": 12000,
  "steps": [ ... ]
}
```

`reason` and `summary` are the lines the human reads first on the consent card.
The card then lists every step on its own line (`2. click · 在 foot 窗口 内 (0.5,
0.6) 点击左键`), rendered by the tool from the validated plan, so the host approves
what the plan does rather than an op list; a plan longer than ten steps shows the
first ten and a count of the rest. The whole card, including those step lines, is
rendered in the language chosen by `--lang <zh|en>` on `control run` (default
`zh`, or the `HYPRSCOPE_LANG` environment value; an unknown value is a usage
error), while CLI stdout stays English. `id`, `summary`, `workspace` and
`interferencePromptMs` are optional; everything else has a default, and the
defaults are applied once, when the document is validated.

`reason` and `summary` also accept per-language objects instead of one string:

```json
{
  "reason": { "zh": "在终端输入一行并截图", "en": "Type one line and capture it" },
  "summary": { "zh": "聚焦、点击、输入、截图", "en": "focus, click, type, capture" }
}
```

An object may carry `zh`, `en`, or both, and each variant obeys the same length
rule as the plain string. The card renders the variant for `--lang` and falls
back to the other one when a variant is missing; the lease `planSummary`, the
dry-run report and a derived recovery plan keep one string, resolved English
first and then Chinese. An empty object, a non-string variant, an unknown
language key or a malformed value is rejected as `PLAN_INVALID` with the
offending path, and a plain string keeps working unchanged.

| field | rule |
|---|---|
| `version` | exactly `1` |
| `id` | `[A-Za-z0-9._-]{1,64}`, default `plan` |
| `reason` | required, 1–200 characters per variant (plain string or `{zh, en}`) |
| `summary` | optional free text, at most 200 characters per variant; informational only |
| `workspace` | optional `[A-Za-z0-9._-]{1,32}`; shown to the human and copied into derived plans, not an implicit premise |
| `budgetMs` | integer 500–30000, default 8000; wall-clock bound of one attempt |
| `settleMs` | integer 50–5000, default 600; per-step verify deadline |
| `interferencePromptMs` | integer 1000–60000, default 12000; how long the human has to answer an interference prompt before the attempt is terminated |
| `steps` | 1–64 entries, executed in order |
| `text` ops | at most 4096 characters summed over the plan |
| unknown fields | rejected at every depth with a hint naming the closest allowed field and its shape, so validation covers exactly what was read |

A plan document may not carry a `lineage` field: only a plan the tool derived
from an interrupted run has one (§6), and an authored document that claims a
lineage is rejected. The defaults above are applied by validation, and the run
executes the validated document it loaded once — never a file read again later.

Window targets select by address or by exact `app`/`title`:

```json
{ "id": "0x55a1aaa0", "app": "Alacritty", "title": "terminal" }
```

`id` wins when present. Otherwise `app` and/or `title` must match exactly one
mapped client; zero matches is `target.missing`, several is `target.ambiguous`,
and both fault the run.

Window-relative locations are never layout pixels. A pointer anchor or capture
region is resolved against the target window's current rectangle at execution
time:

```json
{ "window": { "app": "foot" }, "point": [0.5, 0.6] }
{ "window": { "app": "foot" }, "rect": [0.0, 0.0, 1.0, 1.0] }
```

Point coordinates are `0..1` of the window width/height; a rect is
`[x, y, width, height]` in the same units and must stay inside the window. A
window that resizes therefore breaks a geometry assertion instead of silently
moving the click. A pointer destination may also be absolute layout pixels:

```json
{ "x": 1512, "y": 900 }
```

Anchored points are preferred: they survive a window move, while an absolute
position silently stops pointing at the same thing.

## 3. Preconditions and expectations

Every step may carry `requires` (checked before commit) and `expect` (checked
after). Predicate kinds are fixed in code; the author supplies parameters only
and cannot introduce kinds or change their severity.

| kind | parameters | cost | allowed in | when broken | capabilities |
|---|---|---|---|---|---|
| `lease.valid` | — | cached | implicit | fatal | — |
| `time.budget` | — | cached | implicit | fatal | — |
| `window.exists` | target | state | requires, expect | fatal | `observe.hyprctl` |
| `window.focused` | target | state | requires, expect | recoverable (focus) | `observe.hyprctl`, `dispatch.focus.window` |
| `window.geometry` | target, optional x/y/width/height, `tol` | state | requires, expect | recoverable (move + resize) while the window is floating; fatal when tiled | `observe.geometry`, `dispatch.window.move`, `dispatch.window.resize` |
| `window.state` | target, `floating`/`pinned`, `fullscreen`/`fullscreenClient` (0\|1\|2) | state | requires, expect | recoverable (fullscreen/float/pin) while the window exists | `observe.hyprctl`, `observe.window.modes`, plus float/pin/fullscreen-state only for the modes the instance asserts |
| `workspace.active` | name | state | requires, expect | recoverable (activate workspace) | `observe.hyprctl`, `dispatch.focus.workspace` |
| `monitor.config` | name, width/height/scale | state | requires, expect | fatal | `observe.hyprctl` |
| `clients.set` | exact window addresses | state | requires | fatal | `observe.hyprctl` |
| `pointer.position` | `target`+`point`, or `x`/`y`; `tol` | pointer query | requires | recoverable (reposition); an anchored point needs its window to still exist | `observe.cursor`, `inject.pointer` |
| `region.unchanged` | target, rect, label | capture | requires | fatal | `capture.grim` |
| `region.changed` | target, rect | capture | expect | fatal | `capture.grim` |
| `no.foreign_event` | — | cached | implicit | fatal | `events.socket` |

`window.state` takes booleans for `floating` and `pinned`, and numeric modes for
`fullscreen` / `fullscreenClient`: `0` none, `1` fullscreen, `2` maximized; the
client-side mode uses the same encoding. `pointer.position` is either
window-relative (`target` + `point` in 0..1 units) or absolute (`x` + `y` in
layout pixels), never both in one predicate. `tol` defaults to `0` for
`window.geometry` (range 0–64) and to `2` for `pointer.position` (range 0–256).

`window.geometry` with no coordinates compares against the geometry observed at
run start. Evaluation is cheapest-first and short-circuits on a fatal failure, so
a capture predicate only runs when nothing cheaper already broke. An expectation
is never recovered: a failed `expect` faults the attempt even when the same kind
is recoverable as a precondition (§6).

Implicit predicates are not written in plans: the lease is re-read and the budget
re-checked before every step, and the event tap is drained before the declared
requirements.

The `capabilities` column is checked against the accepted capability baseline
before the consent card appears; a missing capability is a `CAPABILITY` failure
naming the id, not a runtime fault. The baseline can only narrow what the code
declares, and a `required` capability that was merely advertised never counts as
measured. A `screenshot` step that names a `window` is gated by `capture.window`
rather than `capture.grim` (see §4). See
[COMPATIBILITY.md](/docs/cli/COMPATIBILITY.md) §5 and
[BASELINE.md](/docs/cli/BASELINE.md) §6.

## 4. Operations

| op | fields | mutating | idempotent | declared `requires` | declared `expect` | capabilities |
|---|---|---|---|---|---|---|
| `movePointer` | `at` | yes | yes | optional | optional | `inject.pointer` |
| `click` | `at`, `button`, `count` | yes | no | required; must include `window.focused` and `window.geometry` | required | `inject.pointer` |
| `scroll` | `value`, `axis` | yes | no | required | required | `inject.pointer` |
| `chord` | `keys` | yes | no | required | required | `inject.keyboard` |
| `text` | `text` | yes | no | required | required | `inject.keyboard` |
| `focusWindow` | `target` | yes | yes | required | optional | `dispatch.focus.window` |
| `workspace` | `name` | yes | yes | optional | optional | `dispatch.focus.workspace` |
| `moveWindow` | `target`, `x`, `y` (absolute) | yes | yes | required | optional | `dispatch.window.move` |
| `resizeWindow` | `target`, `width`, `height` (absolute) | yes | yes | required | optional | `dispatch.window.resize` |
| `floatWindow` | `target`, `floating`, `pinned` | yes | yes | required | optional | `dispatch.window.float` and/or `dispatch.window.pin`, only for the fields the step sets |
| `fullscreenWindow` | `target`, `internal`, `client` (0\|1\|2) | yes | yes | required | optional | `dispatch.window.fullscreen-state` |
| `screenshot` | `label`, plus `region` or `window` (at most one of the two) | no | — | optional | — | `capture.grim` for a region; `capture.window` for a window |
| `pause` | `ms` (1–1000) | no | — | optional | — | — |
| `assert` | `requires` | no | — | optional | forbidden | — (the predicates decide) |
| `waitEvent` | `kind`, `timeoutMs` | no | — | optional | — | `events.socket` |

The catalog is also a command: `hyprscope control ops` prints one line per op and
`hyprscope control ops --json` prints a stable array. Both are derived from
`OP_SPECS` and the `OP_FIELDS` field catalog in `src/plan/model.ts`, so the CLI
reference cannot drift from what validation accepts. A human line reads

```
movePointer · needs none · requires inject.pointer · at:{x,y}|{window,point} [requires?, expect?]
```

Required fields appear as `name:shape`, optional fields in brackets with `?`,
required clauses appear as bare `requires`/`expect`, and `assert` prints
`expect:forbidden`. The JSON array has one entry per op in catalog order:
`{op, mutating, idempotent, needsTarget, requires: [capability], fields: [{name, required, shape}]}`.
`shape` is a one-line hint such as `at:{x,y}|{window,point}`, `1..1000`, or
`activewindow|workspace|openwindow|closewindow`. A `screenshot` step that names a
`window` is still gated by `capture.window` rather than by the base `capture.grim`
capability the op lists.

`moveWindow` and `resizeWindow` are absolute: `x`/`y` and `width`/`height` are
layout pixels, and the emitted Lua call carries no `relative` field, which is the
optional field that would select relative placement instead. The compositor
refuses either call while the window is fullscreen, so a geometry step has to
clear fullscreen first; the recovery ladder in §6 does that by construction.

`floatWindow` and `fullscreenWindow` set state instead of toggling it:
`floating`/`pinned` become explicit `on`/`off` actions, and a fullscreen step
carries an internal mode and a client mode, each `0` (none), `1` (fullscreen), or
`2` (maximized), with a missing mode defaulting to `0`.

`screenshot` captures a region or one window. With `window` it uses the same
target selector as the other ops — `{ "window": { "app": "foot" } }` — and
`window` and `region` are mutually exclusive; a step with neither captures the
whole layout. The target is resolved against the run snapshot like any other
window target, so zero or several matches fault as `target.missing` /
`target.ambiguous`, and a matching window the compositor reports no
foreign-toplevel identifier for also faults as `target.missing`; the compositor
then renders that one toplevel through `ext-image-copy-capture`, so the window is
captured even when it is on another workspace or covered by another window. Only a mapped window can be captured (a
minimized or unmapped window is refused), the cursor is not composited, and a
window with a `no_screen_share` rule or a denied screenshot permission yields the
compositor's denied placeholder. A capture that fails faults the attempt with the
helper's reason instead of recording a screenshot. The step is gated by
`capture.window`; region and layout captures stay gated by `capture.grim` (§3).
Its card line reads `截图窗口「<app>」`, naming the window by class, then
title, then id.

`chord` and `text` travel through the compositor's normal key dispatch, so `chord`
can trigger the host's own keybind; the plan language deliberately has no generic
`dispatch` op, no `exec`, no config editing, and no escape hatch.

Idempotency is a property of the op in code, not a plan field. Non-idempotent ops
are at-most-once: if a commit may have landed but the expectation cannot be
confirmed, the executor faults rather than replaying. Idempotent ops may be
retried once when an expectation fails inside the budget.

`movePointer` and `workspace` declare no premise requirements (the destination is
part of the step); every other mutating op must declare at least one, and a
non-idempotent op must also declare an expectation.

## 5. Interference policy

The human is treated as an external fault source. Before every step that commits,
the executor re-reads the lease, checks the attempt's `budgetMs`, evaluates the
declared `requires` cheapest-first, and drains the event tap. The non-mutating
`pause` / `screenshot` / `waitEvent` steps skip that preflight but still stop on a
hard external event before they run, and `waitEvent` consumes only the event it
waited for. Only a broken precondition can pause a run; a failed expectation, a
fatal premise, and a hard external event all end the attempt immediately (§6).

An external event is actionable only when it breaks something the plan declared.
The hard exceptions are `openwindow`, `closewindow`, `monitoradded`,
`monitorremoved`, `monitorlayout`, and `submap`: when no declared premise already
accounts for the change, they fault the attempt without a prompt. The other
state-changing events (`workspace`, `activewindow`, `fullscreen`,
`changefloatingmode`, `pin`, `movewindow`, ...) are caught by the premise that
covers them, if any; nothing is corrected speculatively.

When every broken premise is recoverable, the executor stops injecting and asks
the human:

1. publish `interference.json` in the lease directory with a prompt `id`, the
   1-based step (`step`/`total`), the recovery attempt it would start and the
   allowance (`attempt`/`maxResumes`), the budget a recovery attempt would get
   (`budgetMs`), every broken premise with its expected/observed values, and a
   deadline of `interferencePromptMs` (§2);
2. the overlay renders a modal card — "检测到外部操作", the broken premises, the
   step line `第 k/n 步 · 第 r/m 次恢复`, a countdown, and two buttons:
   `终止操作` (Escape) and `继续执行` (Return/Enter); the card also says that
   continuing restores the premises and adds a fresh execution window;
3. the answer is written as `interference-decision.json` and must echo the
   prompt `id`; a decision carrying another id is ignored, and an expired prompt
   is refused;
4. `继续执行` suspends the attempt (§6) — nothing is re-established in place and
   the interrupted attempt does not replay the step;
5. `终止操作`, or the deadline passing without an answer, faults the run with
   detail `(host chose to terminate)` and keeps the `committed` set so the author
   can resume around what already happened.

Two cases never prompt. When any broken premise is not recoverable, the run
faults immediately with that premise as `broken`; the tool does not ask the human
to approve something it cannot do. A recovery attempt is also never offered a
second recovery: if a premise breaks there, the attempt faults with detail
`(the recovery attempt may not recover again)`, and with `--max-resumes 0` the
first attempt faults with `(recovery is disabled for this run)` instead.

Inside an agent or external desktop the lease has no overlay and no prompt: a
restorable conflict faults the attempt with its broken premise, and the agent
asks the host in the conversation instead.

Nothing is rolled back. Undoing the human's action is out of scope and often
impossible; recovery re-asserts the tool's own premises by running a derived
plan, not by mutating the interrupted one. A closed application is never
reopened, because the replacement is not the same object, and the plan that
referenced it is over.

## 6. Recovery

Interference is recovered by deriving a new plan, never by correcting the
running one. The standard is deliberately narrow: a premise is recoverable only
when the tool can both observe it and reach it with its own dispatch subset
(§4). A closed window, a changed application surface, or a monitor
reconfiguration is not recoverable — the attempt faults and hands the facts back
to the requester, which is the only party that can reason about application
state.

### Restorability

Restorability is a property of the predicate catalog (`PREDICATE_SPECS` in
`src/plan/model.ts`), not of the document, and it depends on what is observed at
recovery time:

| kind | restorable | restore | condition / why fatal |
|---|---|---|---|
| `window.focused` | yes | focus | target must still exist |
| `window.state` | yes | fullscreen / float / pin | target must still exist |
| `window.geometry` | yes | move + resize | only while the window is floating; tiled geometry belongs to the layout; needs declared geometry or a run-start baseline |
| `workspace.active` | yes | activate workspace | the premise must name a workspace |
| `pointer.position` | yes | move pointer | absolute position, or an anchored point whose window still exists |
| `window.exists` | no | — | a reopened window is not the same object |
| `monitor.config` | no | — | output configuration is outside the tool |
| `clients.set` | no | — | the set of applications changed |
| `region.unchanged` | no | — | the application surface changed |
| `region.changed` | no | — | an expectation is never recovered |
| `time.budget` | no | — | the attempt's wall clock ran out |
| `lease.valid` | no | — | control was revoked |

An expectation failure is always fatal, even when the same kind is recoverable as
a precondition. A window target that no longer matches exactly one window at
recovery time (missing or ambiguous) is final too.

The capability baseline narrows restorability as well. `restorability()` requires
every capability a restore template needs (`RESTORE_CAPABILITIES`), so a machine
without `dispatch.window.pin` cannot rebuild a `state` premise even though the
predicate itself is restorable, and geometry recovery needs both
`dispatch.window.move` and `dispatch.window.resize`. A derived plan is checked
against the same fixed baseline before the lease is renewed; a restore step the
baseline does not grant faults the attempt as `recovery.capability` instead of
silently renewing control.

### Ladder

The derived plan prepends restore steps in a fixed outside-in order, which is the
dependency order the compositor imposes:

1. workspace — switching can move focus;
2. window structure — fullscreen off, then floating and pinned;
3. geometry — `moveWindow` then `resizeWindow`, both requiring the window to be
   floating and neither legal while it is fullscreen;
4. focus — a focus commit raises the window and warps the pointer;
5. pointer — last, because every earlier layer can move the cursor.

Restoring an inner layer therefore never invalidates an outer one. Premises are
merged per window: all broken state premises about one window produce at most one
structure change and one geometry change, and a geometry restore clears a
fullscreen mode first even when the plan never declared fullscreen, because the
compositor refuses move/resize on a fullscreen window.

### Derived plan

A derived plan is an ordinary validated document, built by the tool:

| field | value |
|---|---|
| `lineage` | `rootPlanId`, `attempt` (1-based), `interruptedAtStep` (0-based index in the interrupted plan), `broken` (unique premise kinds) |
| `id` | the interrupted plan's id, shortened to make room, plus `-r<attempt>`; at most 64 characters |
| `reason` | the interrupted plan's reason with `(recovery <attempt>)` appended, truncated to 200 characters |
| `summary` | `恢复…后继续第 k/n 步`, replacing the authored summary — shown in the prompt and the lease banner |
| `steps` | synthesized restore steps followed by the interrupted plan's steps from `interruptedAtStep` on |
| `budgetMs` | the interrupted plan's `budgetMs`; every attempt gets its own execution window |
| `workspace` / `settleMs` / `interferencePromptMs` | inherited from the interrupted plan (`workspace` is carried as null when the root declared none) |

The derived plan may not grow past `PLAN_LIMITS.maxSteps` (64). Synthesis reserves
the steps still waiting in the interrupted plan and refuses with
`recovery.too-many-steps` when the restore steps would not fit. An authored
document may not carry `lineage`; only the tool creates one.

### Consent and renewal

Approving a plan also approves a bounded recovery allowance, so a recovery
attempt never re-asks the human. The consent covers:

- `maxResumes` recovery attempts: default `1` (`PLAN_LIMITS.defaultMaxResumes`), hard cap `3` (`PLAN_LIMITS.maxResumes`); `hyprscope control run --max-resumes <0..3>` sets it and `0` disables recovery;
- `totalBudgetMs = (1 + maxResumes) * budgetMs`, a cap on the summed TTL of every attempt; each attempt may also hold one `LEASE_RECOVERY_MARGIN_MS` (20 s) of prompt/settle margin on top, so consent latency cannot starve a later attempt.

The executor renews the same lease for each attempt with the next attempt
number, a fresh expiry (`budgetMs + 20000 ms` for that attempt), and a
`renewals[]` entry; the lease id never changes. The renewal
rules — granted only, same lease id, not expired, attempt advances by exactly
one, attempt at most `maxResumes`, total TTL cap — are in LEASE.md.

A recovery attempt may not recover again: `resumeAllowed` is true only for the
first attempt. If a premise breaks during recovery, the run faults, so the number
of derived plans stays bounded and every attempt under that consent is
traceable through the lease lineage.

### Termination and receipt

A run ends in one of these shapes:

| shape | result |
|---|---|
| completed | every step of some attempt committed |
| faulted on a fatal premise or expectation | `broken` names it; `committed` lists the confirmed steps of the faulting attempt |
| faulted after the host terminated the prompt, or the deadline passed | as above, detail ends with `(host chose to terminate)` |
| faulted because the recovery could not be derived | `broken.kind` is `recovery.unavailable`, `recovery.too-many-steps`, `recovery.invalid`, `recovery.lease`, `recovery.capability`, or `executor-error` |
| faulted because the addressed desktop disappeared | `broken.kind` is `target.desktop-closed`; the interrupted attempt's `committed` and timeline are kept |
| revoked | `broken.kind` is `lease.valid` |

The report is a run report: the final attempt's result plus `rootRunId`,
`rootDir`, `attempts[]` — one entry per attempt with its own `runId`, `dir`,
`status` (`completed`, `faulted`, `revoked`, or `suspended`), step count, and
breaking kind — `target` (`kind`, `signature`, `managed`), the desktop the run
addressed, and `baseline` (`state`, `approvedAt`, `compositorVersion`,
`degraded[]`), the capability baseline this run was gated by. Each attempt writes its own run directory; an interrupted attempt
adds `suspended.json` (interrupted step, broken premises, committed steps,
baseline geometry), and the root directory's `result.json` is the report above.
The root timeline records `run.suspended`, `run.resume` (attempt number,
restore-step count, summary), and `run.recovery-refused`; the lease's
`renewals[]` is the control-side addendum to that lineage. `committed` is always
local to one attempt, never cumulative across attempts.

## 7. Fault record

A fault is data, not an exception: the executor writes it to
`out/runs/<runId>/fault.json` and returns the same record.

```json
{
  "runId": "20261117T165012-a1b2c3",
  "status": "faulted",
  "step": 4,
  "broken": {
    "kind": "window.exists",
    "detail": "target window is not present",
    "expected": "present",
    "observed": "absent",
    "detectedAt": "2026-11-17T16:50:12.345Z"
  },
  "committed": [0, 1, 2],
  "lastConfirmedEffect": "step 2 (text): typed 18 characters",
  "screenshot": "out/runs/20261117T165012-a1b2c3/step-04-fault.png",
  "timeline": "out/runs/20261117T165012-a1b2c3/timeline.jsonl"
}
```

When the addressed agent or external desktop disappears, the fault keeps the
broken premise's facts but `broken.kind` becomes `target.desktop-closed` and
`detail` names the desktop state; the agent has to ask the host in the
conversation what happened. `committed` lists the steps whose effects were confirmed in this attempt, so the
author can resume by writing a new plan around what already happened instead of
repeating it. `lastConfirmedEffect` names the last confirmed action. A revoked run
uses the same shape with `status: "revoked"` and `kind: "lease.valid"`. A fault
raised because recovery could not be derived keeps the interrupted attempt's facts
(`step`, `committed`, `lastConfirmedEffect`) and uses the refusal kind for
`broken.kind`, with the reason as `detail` and null `expected`/`observed`.

## 8. Consent binding

`hyprscope control run` reads and validates the plan once — from a file, or from
stdin with `run -` — and passes `planBound: true`, the summary and the card
preview (`card`: the description plus one line per step) to `requestLease`; the
consent card shows that description and those step lines. Inside an
`agent` or `external` desktop the human already approved the desktop, so the run
takes a programmatic lease instead: no card appears, but the plan binding and
TTL, the per-call lease check and `wl-inject`'s proof are unchanged. `user`
keeps the per-run card. A stale or unverified baseline is refused with
`CAPABILITY` before either path. The validated plan, with defaults applied, is
serialized canonically (object keys sorted recursively, no whitespace) and stored
next to the run in `plan.json`, so the artifact is exactly the document that was
approved. A localized `reason`/`summary` stays in that artifact exactly as
authored; only the lease summary, the lease record's `reason`, and the dry-run
report resolve it to one string (English first, then Chinese).

Before every mutating call the executor re-reads the lease and requires: phase
`granted`, same lease id, `planBound` true, not expired. A mismatch ends the run
as `revoked`. The same card also approves the bounded recovery allowance above; a
derived plan is covered by renewing the same lease instead of a second card, so
the human approves one plan and a fixed number of mechanical attempts to
re-assert it. Consent, the lease binding and the mutation gate are correctness
mechanisms today, not a security boundary: lease state lives in the
agent's uid until a broker owns it (§9, LEASE.md). In particular the consent card
shares the seat with injected input, so the helper now demands a granted lease
proof and refuses to inject while the card is open; a process that writes its own
Wayland client can still bypass that, which is exactly why the broker/uid split is
the real fix.

## 9. Limits and non-goals

- TOCTOU between the last predicate read and the injection is unavoidable. It is
  kept small by evaluating in-process against one snapshot plus a fence read, and
  absolute-coordinate clicks are low-confidence by construction: they need
  `window.focused`, `window.geometry`, and an expectation that the effect landed.
- No undo, and no application-internal assertions: everything is observable at the
  compositor only, so "the save dialog appeared" is a region or window assertion,
  not a widget check.
- Recovery is mechanical: it re-establishes observable compositor premises in a
  derived plan and never reasons about application state. Anything that needs a
  decision ends the run so the author can re-plan from the fault record.
- Single seat: physical input and injected input interleave. The engine detects
  and recovers; it cannot prevent.
- The plan language is deliberately small. Adding an op or a predicate kind is a
  code change with a fixed severity, never a document change.
- Run artifacts (`plan.json`, `timeline.jsonl`, screenshots, `suspended.json`,
  `fault.json`, `result.json`) are diagnostics, not a stability contract; only the
  fault record above is promised to callers.
