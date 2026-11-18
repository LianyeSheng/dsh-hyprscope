#!/usr/bin/env python3
"""Bilingual pairing gate CLI.

Usage, rules and record format are defined by
.agents/se/contracts/i18n/README.md; the checking logic lives in
translation_pairing_check.py and this file only prints the result and sets the
exit code.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from translation_pairing_check import check_translation_pairing, format_pairing_report


def main(argv: list) -> int:
    root = Path(__file__).resolve().parents[4]
    report = check_translation_pairing(str(root), argv)
    sys.stdout.write(format_pairing_report(report) + '\n')
    return report.exit_code


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
