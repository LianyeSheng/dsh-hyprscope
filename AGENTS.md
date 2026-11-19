# AGENTS.md — hyprscope development rules

hyprscope is one binary with three command groups. `bin/hyprscope.ts` is the only entry point; `src/entry.ts` dispatches to `src/lease/cli.ts` only when the first argument is exactly `control`, and to `src/message/cli.ts` only when it is exactly `message`. To decide where a change belongs, ask one question: **does it change the desktop?**

| Surface | Allowed | Forbidden |
|---|---|---|
| `hyprscope <cmd>` | read-only observation, screenshots, events, `doctor` | any desktop mutation; statically importing lease/plan/control/inject/desktop-lifecycle code |
| `hyprscope control <cmd>` | lease, plan validation and execution, injection, capability baseline, agent desktop | bypassing the lease, the plan binding or the dispatch allowlist |
| `hyprscope message <cmd>` | the desktop hint/composer overlay, message state files, spawning the overlay through the CLI | statically importing lease/plan/control/inject/desktop-lifecycle code; calling `hyprctl`; moving, focusing or closing a window |

The boundary is a gate, not a style: read-only and message code have no route into control code, and control always goes through the lease, the executor and the capability baseline. The message surface only paints a Quickshell overlay and writes files; it never takes a lease, changes desktop state or types into another window. Keep every gate when refactoring; do not turn the router into prefix matching. `bin/hyprlease.ts` stays deleted: if the old name is ever needed, it must be a shim that invokes `hyprscope control`, never a second implementation.

## Understanding the project

The documents are the contract and the code implements it. Read `docs/INDEX.md` first: it gives the reading order, says where the design motivation lives, and maps each contract to its code. Read the English side of a pair only; when a document and the code disagree, the tests establish behavior and the document records intent, so fix both in the same commit.

## Before you start

Three rules gate every task, in this order.

1. **Agree the implementation before starting.** Do not begin editing before the concrete implementation exists: the files and functions that change, the data flow between them, the tests that prove it and the paired documents that record it. Read the code you are about to change first, write the implementation down, and get the human's agreement when the change is more than a small fix. If the request is ambiguous or the contract is unclear, stop and ask; a wrong start costs more than a question, and "I will work it out while editing" is not a plan.
2. **Survey prior art before designing.** Search the web for the projects, papers, standards and issue threads that already solve the same problem — a Wayland layer shell overlay, a global shortcut, an agent message bridge, a capability baseline, whatever the task touches — and analyze them instead of citing them: what each one does better, where it breaks, which parts apply to Hyprland, Quickshell, DSH and the gates above, and what is worth borrowing or deliberately rejecting. Local prior art in this repository (an earlier implementation, a rejected design in the documents, a closed issue) counts too. Record the conclusion with links where the design will be read.
3. **Split the work across subagents.** Decompose the task into independent slices with disjoint write scopes and explicit dependencies, hand as many of them as can run concurrently to subagents, and balance the slices so the parallel branches finish at roughly the same time — a single long tail cancels the speed-up. Keep the planning, the shared task tree, the final diff review and the merge gate with the lead; a subagent's report is evidence to verify, not a result to trust.

## Environment and commands

- **pnpm only**, never npm. Node >= 22 executes TypeScript directly; there is no build step. C is limited to the Wayland interface layer: `probe/wl-globals.c`, `probe/wl-scratch.c`, `tools/inject/wl-inject.c`, `tools/capture/wl-capture.c`.
- `pnpm test` runs unit and live tests; `pnpm run check` is the merge gate (bilingual pairing + type-check + tests); `pnpm run ci:local` mirrors the CircleCI workflow on this machine.
- Live tests skip themselves when no Hyprland session is reachable. Never mock the compositor to make them pass.
- Build the native helpers with `pnpm run build:probe`, `pnpm run build:inject`, `pnpm run build:scratch` and `pnpm run build:capture`; they all need gcc and wayland dev packages.
- In a sandbox `/run/user/1000` may be read-only; install with `TMPDIR=$PWD/.tmp XDG_RUNTIME_DIR=$PWD/.tmp pnpm --store-dir "$PWD/.pnpm-store" install`.

## Documents, artifacts and consistency

- In-scope documents are bilingual triples: `foo.md` (English), `foo.zh.md` (Chinese) and `foo.i18n.yaml` (record). Update both sides in the same change, then re-record with `python3 .agents/se/scripts/docs/verify_translation_pairing.py --write <pair>`; the gate itself runs without arguments. `AGENTS.md` and `SKILL.md` are single-language and outside the pairing scope.
- `README.md` stays a human introduction; verification records go to `docs/VERIFICATION.md`, never the README.
- Code changes update the matching paired document and `.agents/skills/install-hyprscope/SKILL.md` in the same commit. `scripts/check-consistency.ts` holds that mapping and names the likely targets; it fails on stale script or path references, CI gaps, and a document missing from `docs/INDEX.md`, and only warns about document sync.
- Generated artifacts stay gitignored: `out/`, `bin/wl-globals`, `bin/wl-inject`, `bin/wl-scratch`, `bin/wl-capture`, `tools/inject/generated/`, `tools/scratch/generated/`, `tools/capture/generated/`. Never maintain them by hand.

## Git

- Install the checked-in hooks once per clone: `pnpm run hooks:install` sets `core.hooksPath=scripts/git-hooks`. Do not replace them with hand-written files in `.git/hooks`.
- **Every commit runs the pre-commit hook**, in three stages: (1) `pnpm test`, (2) the local CI mirror without tests (`bash scripts/ci-local.sh --skip-tests` builds the native helpers and checks bilingual pairing and types), (3) the consistency check above. Do not use `git commit --no-verify` unless the human explicitly asked; when it is used, say which checks were skipped.
- **Never push without explicit human approval.** The pre-push hook refuses every push unless `HYPRSCOPE_ALLOW_PUSH=1` is set on that single command; set it only after the human approved the push: `HYPRSCOPE_ALLOW_PUSH=1 git push <remote> <ref>`. No force-push to shared branches and no push to upstream without a separate approval.
- Commit only what the task needs; local baseline/probe state, run artifacts and built helpers stay out of the commit.

<!-- se-tools:begin component=bilingual-docs -->
## Bilingual documents

When this repository keeps bilingual documents, every in-scope document is three sibling files: `foo.md` (English), `foo.zh.md` (Chinese) and `foo.i18n.yaml` (the consistency record). Update both sides in the same change and re-record the pair; apply one update as a minimal patch to the counterpart, never as a full re-translation. For understanding or reviewing a document, the English side is enough — do not read the Chinese counterpart alongside it.

Scope, exclusions and the record format are defined by [the bilingual contract](/.agents/se/contracts/i18n/README.md); translation rules are in [translation-rules.md](/.agents/se/contracts/i18n/translation-rules.md) and terms in [terminology.md](/.agents/se/contracts/i18n/terminology.md). Re-record and check a pair with:

```bash
python3 .agents/se/scripts/docs/verify_translation_pairing.py --write <pair>
python3 .agents/se/scripts/docs/verify_translation_pairing.py
```

The pairing gate runs on Python 3 with the standard library, and it makes the adopting repository pair its own in-scope documents; without it the rest of the workflow and the other gates still run. The extended [update-bilingual-docs](/.agents/skills/update-bilingual-docs/SKILL.md) workflow runs only when the user explicitly asks for it.
<!-- se-tools:end component=bilingual-docs -->
