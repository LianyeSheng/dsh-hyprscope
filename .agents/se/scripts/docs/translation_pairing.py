#!/usr/bin/env python3
"""Corpus scope, manifest, CLI arguments and Markdown structure signatures.

The structure signature covers only the Markdown subset this repository's
documents use: ATX headings, fenced code blocks, GFM tables, lists and links;
lines inside fenced code blocks take no part in structural recognition.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Optional

from translation_links import MarkdownLink, MarkdownScan, js_trim, list_marker

__all__ = [
    'TranslationPairingManifest',
    'TranslationPairPaths',
    'TranslationPairingRequest',
    'StructureEntry',
    'TranslationStructureSignature',
    'TranslationStructureDivergence',
    'NON_SOURCE_DIRECTORIES',
    'is_translation_scope_file',
    'is_translation_pairing_manifest_excluded',
    'parse_translation_pairing_manifest',
    'translation_pair_paths',
    'pair_anchor_of_argument',
    'parse_translation_pairing_cli_args',
    'translation_structure_signature',
    'translation_structure_diff',
]


@dataclass
class TranslationPairingManifest:
    """Fields of translation-pairing.manifest.json."""

    excluded: list


@dataclass
class TranslationPairPaths:
    """Three repository-relative paths that make up one bilingual pair."""

    source: str
    zh: str
    meta: str


@dataclass
class TranslationPairingRequest:
    """Parsed request of one gate invocation."""

    mode: str
    scope: str
    anchors: list


@dataclass
class StructureEntry:
    """One structure-signature item: value plus 1-based line number."""

    value: str
    line: int


@dataclass
class TranslationStructureSignature:
    """Structure signature compared between two sides of a pair."""

    headings: list
    code: list
    tables: list
    lists: list
    links: list


@dataclass
class TranslationStructureDivergence:
    """One structural divergence."""

    field: str
    index: int
    en: Optional[StructureEntry] = None
    zh: Optional[StructureEntry] = None


# Dependency and build output directories are never scanned as document corpus.
NON_SOURCE_DIRECTORIES = frozenset([
    'node_modules',
    '.git',
    'dist',
    'lib',
    '.pnpm-store',
    'coverage',
    '.cache',
    '.tmp',
])

README_BASENAME = 'readme.md'


def is_translation_scope_file(file: str) -> bool:
    """Whether a repository-relative path is an in-scope English document."""

    segments = file.split('/')
    if any(segment in NON_SOURCE_DIRECTORIES for segment in segments):
        return False
    lower = file.lower()
    if not lower.endswith('.md') or lower.endswith('.zh.md'):
        return False
    if file.startswith('.agents/notes/archived/'):
        return False
    base = segments[-1].lower() if segments else ''
    if base == README_BASENAME:
        return True
    if re.match(r'^components/[^/]+/agents\.md$', file) is not None:
        return False
    return (
        file.startswith('docs/')
        or file.startswith('.agents/notes/')
        or file.startswith('.agents/se/')
        or file.startswith('components/')
    )


def is_translation_pairing_manifest_excluded(
    file: str,
    manifest: TranslationPairingManifest,
) -> bool:
    """Whether a path is explicitly excluded by the manifest."""

    return any(
        file.startswith(entry) if entry.endswith('/') else file == entry
        for entry in manifest.excluded
    )


def parse_translation_pairing_manifest(content: str) -> TranslationPairingManifest:
    """Parse and validate the exclusion manifest."""

    value = json.loads(content)
    if not isinstance(value, dict):
        raise ValueError('translation-pairing.manifest.json: 期望一个对象')
    unsupported = [field_name for field_name in value.keys() if field_name != 'excluded']
    if len(unsupported) > 0:
        raise ValueError(
            'translation-pairing.manifest.json: 不支持的字段：'
            + '、'.join(unsupported)
            + '；每个在范围文档都必须配对'
        )
    excluded = value.get('excluded')
    if not isinstance(excluded, list) or not all(isinstance(entry, str) for entry in excluded):
        raise ValueError('translation-pairing.manifest.json: excluded 必须是字符串数组')
    return TranslationPairingManifest(excluded)


def translation_pair_paths(source: str) -> TranslationPairPaths:
    """Derive the three pair paths from the English anchor."""

    if not source.lower().endswith('.md') or source.lower().endswith('.zh.md'):
        raise ValueError(f'期望英文 Markdown 路径，收到 {json.dumps(source, ensure_ascii=False)}')
    return TranslationPairPaths(
        source,
        re.sub(r'\.md$', '.zh.md', source, flags=re.IGNORECASE),
        re.sub(r'\.md$', '.i18n.yaml', source, flags=re.IGNORECASE),
    )


def pair_anchor_of_argument(argument: str) -> str:
    """Normalize one CLI pair argument to the English anchor path."""

    normalized = re.sub(r'^\./', '', argument.replace('\\', '/'), count=1)
    lower = normalized.lower()
    if lower.endswith('.zh.md'):
        return normalized[:-len('.zh.md')] + '.md'
    if lower.endswith('.i18n.yaml'):
        return normalized[:-len('.i18n.yaml')] + '.md'
    if lower.endswith('.md'):
        return normalized
    return normalized + '.md'


def parse_translation_pairing_cli_args(argv: list) -> TranslationPairingRequest:
    """Parse and validate the CLI arguments."""

    flags = [argument for argument in argv if argument.startswith('--')]
    anchors = sorted({
        pair_anchor_of_argument(argument)
        for argument in argv
        if not argument.startswith('--')
    })
    unknown = [flag for flag in flags if flag not in ('--list', '--write', '--all')]
    if len(unknown) > 0:
        raise ValueError('未知参数：' + '、'.join(unknown))
    list_mode = '--list' in flags
    write_mode = '--write' in flags
    all_mode = '--all' in flags
    if list_mode and (write_mode or all_mode or len(anchors) > 0):
        raise ValueError('--list 只报告全量语料状态，不能与其他参数或路径组合')
    if all_mode and not write_mode:
        raise ValueError('--all 只能与 --write 一起使用')
    if write_mode:
        if len(anchors) > 0 and all_mode:
            raise ValueError('--write 要么点名配对，要么 --all，不能同时使用')
        if len(anchors) == 0 and not all_mode:
            raise ValueError(
                '--write 需要点名你确认过的配对（三件套之一即可），或用 --all 重录全部完整对；'
                '未审阅的全量重录会把假一致性写进记录'
            )
        return TranslationPairingRequest('write', 'corpus' if all_mode else 'pairs', anchors)
    if list_mode:
        return TranslationPairingRequest('list', 'corpus', [])
    return TranslationPairingRequest('check', 'pairs' if len(anchors) > 0 else 'corpus', anchors)


def _cell_count(line: str) -> int:
    protected_pipes = line.replace('\\|', '\x00')
    trimmed = js_trim(protected_pipes)
    if trimmed.startswith('|'):
        trimmed = trimmed[1:]
    if trimmed.endswith('|'):
        trimmed = trimmed[:-1]
    if js_trim(trimmed) == '':
        return 0
    return len(trimmed.split('|'))


def _is_delimiter_row(line: str) -> bool:
    trimmed = js_trim(line)
    if '|' not in trimmed or '-' not in trimmed:
        return False
    if re.match(r'^[\s|:-]+$', trimmed) is None:
        return False
    cells = [js_trim(cell) for cell in _strip_outer_pipes(trimmed).split('|')]
    return len(cells) >= 1 and all(re.match(r'^:?-+:?$', cell) is not None for cell in cells)


def _strip_outer_pipes(text: str) -> str:
    if text.startswith('|'):
        text = text[1:]
    if text.endswith('|'):
        text = text[:-1]
    return text


@dataclass
class _TableStructure:
    entry: StructureEntry
    lines: list


def _tables(scan: MarkdownScan) -> list:
    found: list = []
    index = 0
    masked = scan.masked
    while index < len(masked) - 1:
        if scan.fenced[index]:
            index += 1
            continue
        header = masked[index]
        delimiter = masked[index + 1]
        if ('|' not in header
                or scan.fenced[index + 1]
                or not _is_delimiter_row(delimiter)
                or _cell_count(delimiter) != _cell_count(header)):
            index += 1
            continue
        lines = [index + 1]
        rows = 1
        cursor = index + 2
        while cursor < len(masked):
            line = masked[cursor]
            if scan.fenced[cursor] or js_trim(line) == '' or '|' not in line:
                break
            if re.match(r'^#{1,6}(?:[ \t]+|$)', line) is not None:
                break
            rows += 1
            lines.append(cursor + 1)
            cursor += 1
        found.append(_TableStructure(StructureEntry(f'{rows}x{_cell_count(header)}', index + 1), lines))
        index = cursor
    return found


def _is_thematic_break(line: str) -> bool:
    return re.match(
        r'^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$',
        line,
    ) is not None


def _indent_width(whitespace: str) -> int:
    return sum(4 if character == '\t' else 1 for character in whitespace)


@dataclass
class _ListLevel:
    indent: int
    ordered: bool
    start: int
    count: int
    line: int
    entry_index: int


def _render_list_value(level: _ListLevel) -> str:
    if level.ordered:
        return f'ordered:start={level.start}:items={level.count}'
    return f'bullet:items={level.count}'


def _lists(scan: MarkdownScan) -> list:
    table_lines = set()
    for table in _tables(scan):
        for line in table.lines:
            table_lines.add(line)
    heading_lines = {heading.line_index + 1 for heading in scan.headings}
    entries: list = []

    def flush(region: list) -> None:
        stack: list = []
        for line_number in region:
            line = scan.masked[line_number - 1]
            if _is_thematic_break(line):
                continue
            marker = list_marker(line)
            if marker is None:
                continue
            indent = _indent_width(marker.group(1))
            ordered = re.search(r'\d', marker.group(2)) is not None
            start = int(re.match(r'\d+', marker.group(2)).group(0)) if ordered else 1
            while len(stack) > 0 and indent < stack[-1].indent:
                stack.pop()
            top = stack[-1] if stack else None
            if top is None or indent > top.indent or top.ordered != ordered:
                if top is not None:
                    stack.pop()
                level = _ListLevel(indent, ordered, start, 1, line_number, len(entries))
                stack.append(level)
                entries.append(StructureEntry(_render_list_value(level), line_number))
                continue
            top.count += 1
            entries[top.entry_index] = StructureEntry(_render_list_value(top), top.line)

    region: list = []
    for line_index in range(len(scan.masked)):
        line_number = line_index + 1
        line = scan.masked[line_index]
        hard_boundary = (
            scan.fenced[line_index]
            or line_number in heading_lines
            or line_number in table_lines
        )
        if hard_boundary:
            if region:
                flush(region)
            region = []
            continue
        if js_trim(line) == '':
            # A blank line between list items keeps the list loose; only a following
            # non-list block ends it.
            lookahead = line_index + 1
            while (lookahead < len(scan.masked)
                   and js_trim(scan.masked[lookahead]) == ''
                   and not scan.fenced[lookahead]):
                lookahead += 1
            next_line = scan.masked[lookahead] if lookahead < len(scan.masked) else ''
            continues_list = (
                len(region) > 0
                and lookahead < len(scan.masked)
                and not scan.fenced[lookahead]
                and (lookahead + 1) not in heading_lines
                and (lookahead + 1) not in table_lines
                and list_marker(next_line) is not None
            )
            if not continues_list:
                if region:
                    flush(region)
                region = []
            continue
        region.append(line_number)
    if region:
        flush(region)
    return entries


def translation_structure_signature(
    scan: MarkdownScan,
    semantic_link_target,
    switcher_line_index: Optional[int],
) -> TranslationStructureSignature:
    """Compute the structure signature of one side of a pair."""

    switcher_line = -1 if switcher_line_index is None else switcher_line_index + 1
    return TranslationStructureSignature(
        headings=[StructureEntry(str(heading.depth), heading.line_index + 1) for heading in scan.headings],
        code=[StructureEntry(block.text, block.line_index + 1) for block in scan.code_blocks],
        tables=[table.entry for table in _tables(scan)],
        lists=_lists(scan),
        links=[
            StructureEntry(
                f'image:{link.destination}' if link.image else semantic_link_target(link),
                link.line,
            )
            for link in scan.links
            if link.line != switcher_line
        ],
    )


_STRUCTURE_FIELDS = [
    ('标题层级', 'headings'),
    ('围栏代码块', 'code'),
    ('表格', 'tables'),
    ('列表', 'lists'),
    ('链接', 'links'),
]


def translation_structure_diff(
    en: TranslationStructureSignature,
    zh: TranslationStructureSignature,
) -> list:
    """Compare two structure signatures, returning the first divergence per field."""

    out: list = []
    for field_name, key in _STRUCTURE_FIELDS:
        en_entries = getattr(en, key)
        zh_entries = getattr(zh, key)
        length = max(len(en_entries), len(zh_entries))
        for index in range(length):
            en_entry = en_entries[index] if index < len(en_entries) else None
            zh_entry = zh_entries[index] if index < len(zh_entries) else None
            en_value = en_entry.value if en_entry is not None else None
            zh_value = zh_entry.value if zh_entry is not None else None
            if en_value == zh_value:
                continue
            out.append(TranslationStructureDivergence(field_name, index + 1, en_entry, zh_entry))
            break
    return out
