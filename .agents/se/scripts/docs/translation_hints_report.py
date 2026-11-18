#!/usr/bin/env python3
"""Translation sync hints (read-only).

For a pair whose two sides drifted, print exactly two things:
1. changed sections, so the counterpart can be patched minimally;
2. terminology hits and missing translations for those sections only.

The changed-surface baseline prefers the consistency record (so an uncommitted
working tree can still be localized) and falls back to git diff when no record
exists. Workflow guidance lives in the skill, not in this tool.
"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass, field
from typing import Optional

from translation_links import js_trim, scan_markdown
from translation_pairing import (
    is_translation_pairing_manifest_excluded,
    is_translation_scope_file,
    pair_anchor_of_argument,
    parse_translation_pairing_manifest,
    translation_pair_paths,
)
from translation_pairing_check import check_translation_pairing
from translation_pairing_record import (
    TranslationPairingRecordContext,
    compute_translation_pairing_record,
    parse_translation_pairing_record,
    translation_pairing_record_diff,
    translation_side_sections,
)

__all__ = [
    'HintsChangedSection',
    'HintsTermHit',
    'HintsMissingTerm',
    'HintsData',
    'HintsTermSearch',
    'HintsReport',
    'collect_translation_hints',
    'format_translation_hints',
    'hints_json_payload',
]

USAGE = '\n'.join([
    'Usage:',
    '  python3 .agents/se/scripts/docs/translation_hints.py <one of the pair files | stem> [--json]',
    '  python3 .agents/se/scripts/docs/translation_hints.py --term <english term> [--json]',
])

MANIFEST = '.agents/se/scripts/docs/translation-pairing.manifest.json'
TERMINOLOGY = '.agents/se/contracts/i18n/terminology.md'
MAX_ITEMS = 20


@dataclass
class HintsChangedSection:
    """A section that needs translation or re-translation."""

    key: str
    side: str
    kind: str
    line: Optional[int] = None


@dataclass
class HintsTermHit:
    """One glossary term matched on the source side."""

    term: str
    translation: str
    line: Optional[int]
    count: int


@dataclass
class HintsMissingTerm:
    """A term present on the source side but missing its translation."""

    term: str
    translation: str
    direction: str
    line: Optional[int] = None


@dataclass
class HintsData:
    """Full data emitted by --json."""

    source: str
    zh: str
    meta: str
    state: str
    section_counts: dict
    changed_sections: list
    directions: list
    term_hits: list
    missing_terms: list


@dataclass
class GlossaryEntry:
    """Glossary lookup result for one term."""

    translation: str
    line: int


@dataclass
class HintsTermSearch:
    """Result of the --term corpus search."""

    term: str
    en: list
    zh: list
    glossary: Optional[GlossaryEntry] = None


@dataclass
class HintsReport:
    """Result of one hints run."""

    exit_code: int
    mode: str
    summary: str
    json: bool = False
    data: Optional[HintsData] = None
    term_search: Optional[HintsTermSearch] = None


@dataclass
class _CliRequest:
    json: bool = False
    anchor: Optional[str] = None
    term: Optional[str] = None


@dataclass
class _GlossaryRow:
    en: str
    zh: str
    line: int


@dataclass
class _GitFileChange:
    tracked: bool
    ranges: list


@dataclass
class _LineRange:
    start: int
    end: int


def _read_if_exists(root: str, file: str) -> Optional[str]:
    absolute = os.path.join(root, file)
    if not os.path.exists(absolute):
        return None
    try:
        with open(absolute, 'r', encoding='utf-8', newline='') as handle:
            return handle.read()
    except OSError:
        return None


def _snippet(text: str, maximum: int = 160) -> str:
    compact = re.sub(r'[\s\ufeff]+', ' ', js_trim(text))
    return compact[:maximum - 1] + '…' if len(compact) > maximum else compact


def _parse_cli_arguments(argv: list) -> _CliRequest:
    request = _CliRequest()
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == '--json':
            request.json = True
            index += 1
            continue
        if argument == '--term':
            index += 1
            value = argv[index] if index < len(argv) else None
            if value is None or value.startswith('--'):
                raise ValueError('--term needs an English term')
            if request.term is not None:
                raise ValueError('--term may be given once')
            request.term = value
            index += 1
            continue
        if argument.startswith('--'):
            raise ValueError(f'unknown argument: {argument}')
        if request.anchor is not None:
            raise ValueError(f'pass exactly one pair; got extra argument: {argument}')
        request.anchor = argument
        index += 1
    if request.term is None and request.anchor is None:
        raise ValueError(
            'usage: python3 .agents/se/scripts/docs/translation_hints.py '
            '<one of the pair files | stem> [--json], or --term <english term>'
        )
    if request.term is not None and request.anchor is not None:
        raise ValueError('--term searches the corpus for precedents and takes no pair argument')
    return request


def _load_pairing_context(root: str) -> TranslationPairingRecordContext:
    content = _read_if_exists(root, MANIFEST)
    if content is None:
        manifest = type('_Manifest', (), {'excluded': []})()
    else:
        manifest = parse_translation_pairing_manifest(content)
    return TranslationPairingRecordContext(
        lambda source: (
            is_translation_scope_file(source)
            and not is_translation_pairing_manifest_excluded(source, manifest)
        )
    )


def _glossary(root: str) -> list:
    content = _read_if_exists(root, TERMINOLOGY)
    if content is None:
        return []
    rows: list = []
    lines = content.split('\n')
    for index, line in enumerate(lines):
        trimmed = js_trim(line)
        if not trimmed.startswith('|'):
            continue
        body = trimmed[1:] if trimmed.startswith('|') else trimmed
        if body.endswith('|'):
            body = body[:-1]
        cells = [js_trim(cell) for cell in body.split('|')]
        if len(cells) < 4:
            continue
        en = cells[0].replace('`', '')
        zh = cells[1].replace('`', '')
        if en == '' or en == 'English' or re.match(r'^-+$', en) is not None:
            continue
        rows.append(_GlossaryRow(en, zh, index + 1))
    return rows


def _term_pattern(term: str):
    escaped = re.escape(term)
    lead = '(?<![A-Za-z0-9_-])' if re.match(r'^[A-Za-z0-9]', term) is not None else ''
    trail = '(?![A-Za-z0-9_-])' if re.search(r'[A-Za-z0-9]$', term) is not None else ''
    return re.compile(lead + escaped + '(?:s|es|ed|ing)?' + trail, re.IGNORECASE)


def _matching_lines(content: str, pattern) -> list:
    scan = scan_markdown(content)
    lines = content.split('\n')
    out: list = []
    for index in range(len(lines)):
        if scan.fenced[index]:
            continue
        if pattern.search(lines[index]) is not None:
            out.append(index + 1)
    return out


def _collect_terminology(
    source_content: str,
    target_content: Optional[str],
    rows: list,
    direction: str,
    include_line=None,
) -> tuple:
    hits: list = []
    missing: list = []
    for row in rows:
        if direction == 'en-to-zh':
            all_lines = _matching_lines(source_content, _term_pattern(row.en))
            lines = all_lines if include_line is None else [line for line in all_lines if include_line(line)]
            if len(lines) == 0:
                continue
            hits.append(HintsTermHit(row.en, row.zh, lines[0], len(lines)))
            if target_content is not None and row.zh != '' and row.zh not in target_content:
                missing.append(HintsMissingTerm(row.en, row.zh, direction, lines[0]))
        else:
            if row.zh == '':
                continue
            all_lines = _matching_lines(source_content, _term_pattern(row.zh))
            lines = all_lines if include_line is None else [line for line in all_lines if include_line(line)]
            if len(lines) == 0:
                continue
            hits.append(HintsTermHit(row.zh, row.en, lines[0], len(lines)))
            if target_content is not None and _term_pattern(row.en).search(target_content) is None:
                missing.append(HintsMissingTerm(row.zh, row.en, direction, lines[0]))
    return hits, missing


def _git(root: str, args: list) -> Optional[str]:
    try:
        result = subprocess.run(
            ['git', '-C', root] + args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.decode('utf-8', 'replace')


def _compute_git_file_change(root: str, file: str) -> Optional[_GitFileChange]:
    if _git(root, ['rev-parse', '--is-inside-work-tree']) is None:
        return None
    tracked = _git(root, ['ls-files', '--error-unmatch', '--', file]) is not None
    if not tracked:
        return _GitFileChange(False, [])
    output = _git(root, ['diff', '--no-color', '--unified=0', 'HEAD', '--', file])
    if output is None:
        output = _git(root, ['diff', '--no-color', '--unified=0', '--', file])
        if output is None:
            return _GitFileChange(True, [])
    ranges: list = []
    for line in output.split('\n'):
        match = re.match(r'^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', line)
        if match is None:
            continue
        start = int(match.group(2))
        count = 1 if match.group(3) is None else int(match.group(3))
        ranges.append(_LineRange(start, start - 1 if count == 0 else start + count - 1))
    return _GitFileChange(True, ranges)


def _section_at(sections: list, line: int) -> int:
    found = 0
    for index, section in enumerate(sections):
        if section.line <= line:
            found = index
        else:
            break
    return found


def _changed_from_git(ranges: list, sections: list, side: str) -> list:
    out: list = []
    seen: set = set()
    for line_range in ranges:
        start_index = _section_at(sections, max(1, line_range.start))
        end_index = _section_at(sections, max(1, line_range.end))
        for index in range(start_index, end_index + 1):
            if index >= len(sections):
                continue
            section = sections[index]
            key = section.key if side == 'en' else f'zh#{index + 1}'
            if key in seen:
                continue
            seen.add(key)
            out.append(HintsChangedSection(key, side, 'changed', section.line))
    return out


def _best_effort_record_diff(recorded: dict, en_sections: list, zh_sections: list) -> list:
    out: list = []
    en_keys = {section.key for section in en_sections}
    for section in en_sections:
        confirmed = recorded.get(section.key)
        if confirmed is None:
            if not section.empty:
                out.append(HintsChangedSection(section.key, 'en', 'added', section.line))
        elif confirmed.en != section.hash:
            out.append(HintsChangedSection(section.key, 'en', 'changed', section.line))
    recorded_keys = list(recorded.keys())
    # The record omits sections empty on both sides; skip those when aligning the
    # Chinese side by recorded-key order.
    zh_index = 0
    for key in recorded_keys:
        if key not in en_keys:
            out.append(HintsChangedSection(key, 'en', 'removed'))
        while zh_index < len(zh_sections) and zh_sections[zh_index].empty:
            zh_index += 1
        zh_section = zh_sections[zh_index] if zh_index < len(zh_sections) else None
        zh_index += 1
        confirmed = recorded.get(key)
        if zh_section is not None and confirmed is not None and zh_section.hash != confirmed.zh:
            out.append(HintsChangedSection(key, 'zh', 'changed', zh_section.line))
    while zh_index < len(zh_sections) and zh_sections[zh_index].empty:
        zh_index += 1
    for index in range(zh_index, len(zh_sections)):
        section = zh_sections[index]
        if not section.empty:
            out.append(HintsChangedSection(f'zh#{index + 1}', 'zh', 'added', section.line))
    return out


def _record_diff(recorded: dict, current: dict, en_sections: list, zh_sections: list) -> list:
    out: list = []
    index_by_key = {section.key: index for index, section in enumerate(en_sections)}
    for diff in translation_pairing_record_diff(recorded, current):
        index = index_by_key.get(diff.key)
        en_section = en_sections[index] if index is not None else None
        zh_section = zh_sections[index] if index is not None and index < len(zh_sections) else None
        if diff.kind == 'unconfirmed':
            out.append(HintsChangedSection(
                diff.key, 'en', 'added', en_section.line if en_section is not None else None,
            ))
            continue
        if diff.kind == 'stale':
            out.append(HintsChangedSection(diff.key, 'en', 'removed'))
            continue
        side = 'both' if len(diff.sides) == 2 else (diff.sides[0] if diff.sides else 'en')
        if side == 'zh':
            line = zh_section.line if zh_section is not None else (en_section.line if en_section is not None else None)
        else:
            line = en_section.line if en_section is not None else None
        out.append(HintsChangedSection(diff.key, side, 'changed', line))
    return out


def _baseline_sections(
    root: str,
    paths,
    en: str,
    zh: str,
    context: TranslationPairingRecordContext,
    recorded,
    en_sections: list,
    zh_sections: list,
) -> dict:
    if recorded is not None:
        try:
            current = compute_translation_pairing_record(paths, en, zh, context)
            return {'baseline': 'record', 'changed': _record_diff(recorded, current, en_sections, zh_sections)}
        except Exception:  # noqa: BLE001 - fall back to best effort
            return {'baseline': 'record', 'changed': _best_effort_record_diff(recorded, en_sections, zh_sections)}
    en_change = _compute_git_file_change(root, paths.source)
    zh_change = _compute_git_file_change(root, paths.zh)
    changed: list = []
    if en_change is not None and len(en_change.ranges) > 0:
        changed.extend(_changed_from_git(en_change.ranges, en_sections, 'en'))
    if zh_change is not None and len(zh_change.ranges) > 0:
        changed.extend(_changed_from_git(zh_change.ranges, zh_sections, 'zh'))
    return {'baseline': 'git-diff' if len(changed) > 0 else 'none', 'changed': changed}


def _assemble_changed_list(state: str, en_sections: list, zh_sections: list, baseline: list) -> list:
    if state != 'missing':
        return baseline
    if len(zh_sections) == 0:
        return [
            HintsChangedSection(section.key, 'en', 'added', section.line)
            for section in en_sections
            if not section.empty
        ]
    if len(en_sections) == 0:
        return [
            HintsChangedSection(f'zh#{index + 1}', 'zh', 'added', section.line)
            for index, section in enumerate(zh_sections)
            if not section.empty
        ]
    return baseline


def _section_ranges(sections: list) -> list:
    maximum = 2 ** 53 - 1
    result: list = []
    for index, section in enumerate(sections):
        end = (sections[index + 1].line if index + 1 < len(sections) else maximum) - 1
        result.append(_LineRange(section.line, end))
    return result


def _ranges_for_changed(changed_sections: list, sections: list, side: str) -> list:
    all_ranges = _section_ranges(sections)
    out: list = []
    for section in changed_sections:
        if section.kind == 'removed':
            continue
        if side == 'en' and section.side == 'zh':
            continue
        if side == 'zh' and section.side == 'en':
            continue
        index = -1
        if side == 'en':
            for candidate_index, candidate in enumerate(sections):
                if candidate.key == section.key:
                    index = candidate_index
                    break
        else:
            for candidate_index, candidate in enumerate(sections):
                if candidate.line == section.line:
                    index = candidate_index
                    break
        if 0 <= index < len(all_ranges):
            out.append(all_ranges[index])
    return out


def _include_line_filter(ranges: list):
    if len(ranges) == 0:
        return None
    return lambda line: any(line_range.start <= line <= line_range.end for line_range in ranges)


def _build_data(
    root: str,
    paths,
    en: Optional[str],
    zh: Optional[str],
    meta: Optional[str],
) -> HintsData:
    context = _load_pairing_context(root)
    en_sections = [] if en is None else translation_side_sections(en, paths.source, context)
    zh_sections = [] if zh is None else translation_side_sections(zh, paths.zh, context)
    recorded = None if meta is None else parse_translation_pairing_record(meta)
    state = 'missing' if en is None or zh is None else 'out-of-sync'
    if state == 'missing':
        baseline = {'baseline': 'none', 'changed': []}
    else:
        baseline = _baseline_sections(root, paths, en or '', zh or '', context, recorded, en_sections, zh_sections)
    changed_sections = _assemble_changed_list(state, en_sections, zh_sections, baseline['changed'])
    is_ok = (
        state == 'out-of-sync'
        and recorded is not None
        and len(en_sections) == len(zh_sections)
        and len(changed_sections) == 0
    )
    if is_ok:
        return HintsData(
            paths.source,
            paths.zh,
            paths.meta,
            'ok',
            {'en': len(en_sections), 'zh': len(zh_sections), 'recorded': len(recorded)},
            [],
            [],
            [],
            [],
        )
    directions: list = []
    if state == 'missing':
        directions.append('en-to-zh' if zh is None else 'zh-to-en')
    else:
        en_changed = any(section.side in ('en', 'both') for section in changed_sections)
        zh_changed = any(section.side in ('zh', 'both') for section in changed_sections)
        if en_changed or not zh_changed:
            directions.append('en-to-zh')
        if zh_changed or not en_changed:
            directions.append('zh-to-en')
    rows = _glossary(root)
    hits: list = []
    missing_terms: list = []
    en_filter = _include_line_filter(_ranges_for_changed(changed_sections, en_sections, 'en'))
    zh_filter = _include_line_filter(_ranges_for_changed(changed_sections, zh_sections, 'zh'))
    if 'en-to-zh' in directions and en is not None:
        result_hits, result_missing = _collect_terminology(en, zh, rows, 'en-to-zh', en_filter)
        hits.extend(result_hits)
        missing_terms.extend(result_missing)
    if 'zh-to-en' in directions and zh is not None:
        result_hits, result_missing = _collect_terminology(zh, en, rows, 'zh-to-en', zh_filter)
        hits.extend(result_hits)
        missing_terms.extend(result_missing)
    deduped_hits: list = []
    seen: set = set()
    for hit in hits:
        key = f'{hit.term}|{hit.translation}'
        if key in seen:
            continue
        seen.add(key)
        deduped_hits.append(hit)
    return HintsData(
        paths.source,
        paths.zh,
        paths.meta,
        state,
        {'en': len(en_sections), 'zh': len(zh_sections), 'recorded': len(recorded) if recorded is not None else 0},
        changed_sections,
        directions,
        deduped_hits,
        missing_terms,
    )


def _render_changed_sections(data: HintsData) -> list:
    if len(data.changed_sections) == 0:
        return []
    counts = {'added': 0, 'changed': 0, 'removed': 0, 'unknown': 0}
    for section in data.changed_sections:
        counts[section.kind] += 1
    lines = [f'changed sections (+{counts["added"]} ~{counts["changed"]} -{counts["removed"]}):']
    for section in data.changed_sections[:MAX_ITEMS]:
        marker = {'added': '+', 'changed': '~', 'removed': '-'}.get(section.kind, '?')
        where = 'zh' if section.side == 'zh' or section.key.startswith('zh#') else 'en'
        suffix = '' if section.line is None else f'   {where} L{section.line}'
        lines.append(f'  {marker} {section.key}{suffix}')
    if len(data.changed_sections) > MAX_ITEMS:
        lines.append(f'  ... ({len(data.changed_sections) - MAX_ITEMS} more)')
    return lines


def _render_terminology(data: HintsData) -> list:
    if len(data.term_hits) == 0 and len(data.missing_terms) == 0:
        return []
    # One line per glossary term: a term also missing on the target side is marked
    # inline instead of being listed twice (hits once, missing once).
    missing = {f'{term.term}|{term.translation}' for term in data.missing_terms}
    entries: list = []
    seen: set = set()
    for hit in data.term_hits:
        key = f'{hit.term}|{hit.translation}'
        if key in seen:
            continue
        seen.add(key)
        entries.append((hit, key in missing))
    for term in data.missing_terms:
        key = f'{term.term}|{term.translation}'
        if key in seen:
            continue
        seen.add(key)
        entries.append((term, True))
    entries.sort(key=lambda entry: -int(entry[1]))
    label = (
        'both directions' if len(data.directions) == 2
        else 'zh→en' if data.directions and data.directions[0] == 'zh-to-en'
        else 'en→zh'
    )
    hit_count = len(data.term_hits)
    missing_count = len(data.missing_terms)
    lines = [
        f'terminology ({label}: {hit_count} {"hit" if hit_count == 1 else "hits"}'
        f'{"" if missing_count == 0 else f", {missing_count} missing"}):'
    ]
    for entry, is_missing in entries[:MAX_ITEMS]:
        suffix = '' if entry.line is None else f'   L{entry.line}'
        lines.append(
            f'  {entry.term} → {entry.translation}{suffix}{"   [MISSING]" if is_missing else ""}'
        )
    if len(entries) > MAX_ITEMS:
        lines.append(f'  ... ({len(entries) - MAX_ITEMS} more)')
    return lines


def _format_glossary_line(search: HintsTermSearch) -> str:
    if search.glossary is None:
        return 'glossary: not listed'
    return f'glossary: {search.glossary.translation} (terminology.md L{search.glossary.line})'


def format_translation_hints(report: HintsReport) -> str:
    """Render the two hint blocks."""

    if report.mode == 'usage':
        return report.summary
    if report.mode == 'term':
        search = report.term_search
        if search is None:
            return report.summary
        lines = [f'term: {search.term}']
        lines.append(_format_glossary_line(search))
        lines.append(f'en: {len(search.en)}')
        for hit in search.en[:10]:
            lines.append(f'  {hit["path"]}:{hit["line"]}  {hit["text"]}')
        lines.append(f'zh: {len(search.zh)}')
        for hit in search.zh[:10]:
            lines.append(f'  {hit["path"]}:{hit["line"]}  {hit["text"]}')
        return '\n'.join(lines)
    data = report.data
    if data is None:
        return report.summary
    lines = [
        f'{data.source}  {data.state}  '
        f'(en {data.section_counts["en"]} / zh {data.section_counts["zh"]} sections)'
    ]
    if data.state == 'ok':
        return '\n'.join(lines)
    lines.extend(_render_changed_sections(data))
    lines.extend(_render_terminology(data))
    return '\n'.join(lines)


def _search_corpus_term(root: str, term: str) -> HintsTermSearch:
    search = HintsTermSearch(term, [], [])
    glossary_rows = _glossary(root)
    row = None
    for item in glossary_rows:
        if item.en.lower() == term.lower():
            row = item
            break
    if row is not None:
        search.glossary = GlossaryEntry(row.zh, row.line)
    listing = check_translation_pairing(root, ['--list'])
    if listing.exit_code == 2:
        raise ValueError(listing.summary)
    for state in listing.states:
        paths = translation_pair_paths(state.source)
        en = _read_if_exists(root, paths.source)
        if en is not None:
            pattern = _term_pattern(term)
            for index, line in enumerate(en.split('\n')):
                if pattern.search(line) is not None:
                    search.en.append({'path': paths.source, 'line': index + 1, 'text': _snippet(line)})
        zh = _read_if_exists(root, paths.zh)
        if zh is not None:
            needle = term.lower()
            for index, line in enumerate(zh.split('\n')):
                if needle in line.lower():
                    search.zh.append({'path': paths.zh, 'line': index + 1, 'text': _snippet(line)})
    return search


def _usage_report(message: str, json_mode: bool) -> HintsReport:
    return HintsReport(2, 'usage', f'translation-hints: {message}', json_mode)


def collect_translation_hints(root: str, argv: list) -> HintsReport:
    """Collect one hints run."""

    if len(argv) == 1 and argv[0] in ('--help', '-h'):
        return HintsReport(0, 'usage', USAGE, False)
    try:
        request = _parse_cli_arguments(argv)
    except Exception as error:  # noqa: BLE001 - usage error
        return _usage_report(str(error), '--json' in argv)
    if request.term is not None:
        try:
            return HintsReport(
                0,
                'term',
                f'translation-hints: term {request.term}',
                request.json,
                term_search=_search_corpus_term(root, request.term),
            )
        except Exception as error:  # noqa: BLE001 - usage error
            return _usage_report(str(error), request.json)
    anchor = pair_anchor_of_argument(request.anchor or '')
    try:
        listing = check_translation_pairing(root, ['--list'])
    except Exception as error:  # noqa: BLE001 - usage error
        return _usage_report(str(error), request.json)
    if listing.exit_code == 2:
        return _usage_report(listing.summary, request.json)
    state = None
    for item in listing.states:
        if item.source == anchor:
            state = item
            break
    if state is None:
        for item in listing.states:
            if item.source.lower() == anchor.lower():
                state = item
                break
    if state is None:
        return _usage_report(
            f'not an in-scope, non-excluded pair: {anchor} (see .agents/se/contracts/i18n/README.md)',
            request.json,
        )
    paths = translation_pair_paths(state.source)
    en = _read_if_exists(root, paths.source)
    zh = _read_if_exists(root, paths.zh)
    meta = _read_if_exists(root, paths.meta)
    if en is None and zh is None:
        return _usage_report(f'none of the three pair files exists on disk: {paths.source}', request.json)
    try:
        data = _build_data(root, paths, en, zh, meta)
        return HintsReport(
            0,
            'brief',
            f'translation-hints: {state.source} ({data.state})',
            request.json,
            data=data,
        )
    except Exception as error:  # noqa: BLE001 - usage error
        return _usage_report(str(error), request.json)


def _hints_changed_sections_payload(sections: list) -> list:
    payload: list = []
    for section in sections:
        item = {'key': section.key, 'side': section.side, 'kind': section.kind}
        if section.line is not None:
            item['line'] = section.line
        payload.append(item)
    return payload


def hints_json_payload(report: HintsReport):
    """The JSON value the hints CLI emits for --json."""

    if report.mode == 'term':
        search = report.term_search
        if search is None:
            return None
        payload: dict = {'term': search.term}
        payload['en'] = [dict(hit) for hit in search.en]
        payload['zh'] = [dict(hit) for hit in search.zh]
        # JavaScript assigns `glossary` after the literal, so it serializes last.
        if search.glossary is not None:
            payload['glossary'] = {
                'translation': search.glossary.translation,
                'line': search.glossary.line,
            }
        return payload
    data = report.data
    if data is None:
        return None
    payload = {
        'source': data.source,
        'zh': data.zh,
        'meta': data.meta,
        'state': data.state,
        'sectionCounts': {
            'en': data.section_counts['en'],
            'zh': data.section_counts['zh'],
            'recorded': data.section_counts['recorded'],
        },
        'changedSections': _hints_changed_sections_payload(data.changed_sections),
        'directions': list(data.directions),
        'termHits': [
            ({'term': hit.term, 'translation': hit.translation, 'line': hit.line, 'count': hit.count}
             if hit.line is not None else
             {'term': hit.term, 'translation': hit.translation, 'count': hit.count})
            for hit in data.term_hits
        ],
        'missingTerms': [
            ({'term': term.term, 'translation': term.translation,
              'direction': term.direction, 'line': term.line}
             if term.line is not None else
             {'term': term.term, 'translation': term.translation, 'direction': term.direction})
            for term in data.missing_terms
        ],
    }
    return payload
