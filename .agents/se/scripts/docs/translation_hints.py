#!/usr/bin/env python3
"""CLI for the translation hints tool (read-only).

Prints only changed sections and scoped terminology for a drifted pair.

Usage:
  python3 .agents/se/scripts/docs/translation_hints.py <one of the pair files | stem> [--json]
  python3 .agents/se/scripts/docs/translation_hints.py --term <english term> [--json]

The usage and output contract live in translation_hints_report.py; this file only
prints the result and sets the exit code. Any of the three pair files, or the
suffix-less stem, names the pair; --json emits machine-readable data and
--term <english term> searches the whole corpus for precedents.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from translation_hints_report import (
    collect_translation_hints,
    format_translation_hints,
    hints_json_payload,
)


def main(argv: list) -> int:
    root = Path(__file__).resolve().parents[4]
    report = collect_translation_hints(str(root), argv)
    if report.mode == 'usage':
        sys.stdout.write(report.summary + '\n')
    elif report.json:
        payload = hints_json_payload(report)
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
    else:
        sys.stdout.write(format_translation_hints(report) + '\n')
    return report.exit_code


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
