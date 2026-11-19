# Documentation index

English | [中文](/docs/INDEX.zh.md)

This index ([INDEX.md](/docs/INDEX.md)) is the entry point for understanding what hyprscope does, how it is designed, and why the design is what it is. Start with [README.md](/README.md) for positioning, the feature set, the two surfaces and the quick start. The documents are the contract and the code implements it; read the English side of a pair only, because the Chinese side carries the same content. The numbering below is the single recommended reading order: the CLI contracts first, then the plugin and annotation surfaces.

## 1. CLI software

The CLI is the product: it observes the desktop, owns the control gate and executes consented plans. These documents are its contract, in the order to read them.

1. [PROTOCOL.md](/docs/cli/PROTOCOL.md) — what is observed and how it is reported: snapshot, coordinates, event stream, error codes, capability report; §8–§9 declare the control surface, and §11 records the annotation session that the plugin drives.
2. [LEASE.md](/docs/cli/LEASE.md) — why control is consent-gated: lifecycle, state and files, failsafe chain, boundaries ("why we do not intercept input") and limitations.
3. [PLAN.md](/docs/cli/PLAN.md) — plan schema, preconditions and expectations, ops, interference policy, recovery, fault record, consent binding, limits and non-goals.
4. [BASELINE.md](/docs/cli/BASELINE.md) and [COMPATIBILITY.md](/docs/cli/COMPATIBILITY.md) — why control refuses without a measured baseline: state computation, reader rules, human approval and narrowing, drift and staleness.
5. [DESKTOP.md](/docs/cli/DESKTOP.md) — why an agent gets its own nested compositor: addressing, lifecycle, directories, consent, failures and what it is not.

## 2. Plugin

The plugin is the DSH Host half: a thin wrapper over the CLI plus the desktop-message and annotation surfaces. Read these after the CLI contracts.

6. [DSH-PLUGIN.md](/docs/plugin/DSH-PLUGIN.md) — the agent-facing wrapper and why it stays thin: the six tools, the desktop-message hint and shortcut, and how the safety boundary holds.
7. [ANNOTATE.md](/docs/plugin/ANNOTATE.md) — the annotation session's design contract: ownership and boundaries, one session clock, geometry-only records, the voice pipeline, alignment, the clean image and intent card, degradation, limits and the platform adapter.

## 3. Cross-cutting records

8. [VERIFICATION.md](/docs/VERIFICATION.md) — one recorded real-machine verification; evidence for that machine, not an ongoing guarantee.

## 4. Where the motivation lives

Design intent is written down, not left implicit in the code. Look for the sections that name it: Positioning, Boundaries, Limits and non-goals, and What it is not. Do not infer intent from the code alone. When a document and the code disagree, the tests establish behavior and the document records intent, so fix both in the same commit.

## 5. Contract to code map

| Area | Contract | Code |
|---|---|---|
| read-only commands | `docs/cli/PROTOCOL.md` | `src/cli.ts` |
| control lease | `docs/cli/LEASE.md` | `src/lease/` |
| plan language | `docs/cli/PLAN.md` | `src/plan/` |
| capability baseline | `docs/cli/BASELINE.md`, `docs/cli/COMPATIBILITY.md` | `src/compat/` |
| agent desktop | `docs/cli/DESKTOP.md` | `src/desktop/` |
| DSH plugin | `docs/plugin/DSH-PLUGIN.md` | `plugins/dsh-hyprscope/`, `overlay/message/` |
| desktop annotation and intent card | `docs/plugin/ANNOTATE.md`, `docs/cli/PROTOCOL.md` §11 | `plugins/dsh-hyprscope/annotate.js`, `overlay/message/` |
