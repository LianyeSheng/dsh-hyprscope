#!/usr/bin/env python3
"""Paths, section hashes, parsing and rendering for bilingual consistency records.

Records split a document into sections keyed by the English heading slug path:
edits to independent sections land on different record lines, which Git's default
text merge can combine; only edits to the same section on both sides conflict.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Callable, Optional

from translation_links import (
    LinkContext,
    MarkdownHeading,
    detect_language_switcher,
    js_trim,
    normalize_paired_link_targets,
    scan_markdown,
)
from translation_pairing import TranslationPairPaths

__all__ = [
    'TranslationSectionHashes',
    'TranslationPairingRecordContext',
    'TranslationPairingRecordDiff',
    'TranslationSectionEntry',
    'compute_translation_pairing_record',
    'translation_side_sections',
    'parse_translation_pairing_record',
    'render_translation_pairing_record',
    'translation_pairing_record_diff',
]


@dataclass
class TranslationSectionHashes:
    """Hashes of one section's content on both sides."""

    en: str
    zh: str


@dataclass
class TranslationPairingRecordContext:
    """Link-resolution context needed to compute a record."""

    is_pair_source: Callable[[str], bool]


@dataclass
class TranslationPairingRecordDiff:
    """One divergence between the record and current content."""

    key: str
    kind: str
    sides: list


@dataclass
class TranslationSectionEntry:
    """One section of one side, with its record key and content hash."""

    key: str
    line: int
    hash: str
    empty: bool


@dataclass
class _RawSection:
    heading: Optional[MarkdownHeading]
    lines: list
    line: int


_KEY_LINE = re.compile(r'^(/.*):$')
_HASH_LINE = re.compile(r'^ {2}(en|zh): ([0-9a-f]{16})$')


def _raw_sections(normalized: str) -> list:
    scan = scan_markdown(normalized)
    switcher = detect_language_switcher(scan)
    switcher_line = switcher.line_index if switcher is not None else None
    lines = normalized.split('\n')
    heading_at = {heading.line_index: heading for heading in scan.headings}
    result: list = [_RawSection(None, [], 1)]
    for index in range(len(lines)):
        if scan.fenced[index] or index == switcher_line:
            continue
        heading = heading_at.get(index)
        if heading is not None:
            result.append(_RawSection(heading, [lines[index]], index + 1))
            continue
        result[-1].lines.append(lines[index])
    for section in result:
        while section.lines and js_trim(section.lines[-1]) == '':
            section.lines.pop()
        while section.lines and js_trim(section.lines[0]) == '':
            section.lines.pop(0)
    return result


def _section_keys(sections: list) -> list:
    ancestors: list = []
    keys: set = set()
    result: list = []
    for section in sections:
        path = '/'
        if section.heading is not None:
            depth = section.heading.depth
            while ancestors and ancestors[-1][0] >= depth:
                ancestors.pop()
            ancestors.append((depth, _slug(section.heading.text)))
            path = '/' + '/'.join(slug for _depth, slug in ancestors)
        key = path
        repeat = 2
        while key in keys:
            key = f'{path}~{repeat}'
            repeat += 1
        keys.add(key)
        result.append(key)
    return result


def _slug(text: str) -> str:
    slug = re.sub(r'[^a-z0-9]+', '-', text.lower())
    slug = re.sub(r'^-|-$', '', slug)
    return slug or 'section'


def _section_hash(lines: list) -> str:
    return hashlib.sha256('\n'.join(lines).encode('utf-8')).hexdigest()[:16]


def compute_translation_pairing_record(
    paths: TranslationPairPaths,
    en: str,
    zh: str,
    context: TranslationPairingRecordContext,
) -> dict:
    """Compute the consistency record for a pair's current content."""

    normalized_en = normalize_paired_link_targets(
        en,
        scan_markdown(en),
        LinkContext(paths.source, context.is_pair_source),
    )
    normalized_zh = normalize_paired_link_targets(
        zh,
        scan_markdown(zh),
        LinkContext(paths.zh, context.is_pair_source),
    )
    en_sections = _raw_sections(normalized_en)
    zh_sections = _raw_sections(normalized_zh)
    if len(en_sections) != len(zh_sections):
        raise ValueError(
            f'{paths.source} 有 {len(en_sections) - 1} 个标题节，'
            f'{paths.zh} 有 {len(zh_sections) - 1} 个'
        )
    keys = _section_keys(en_sections)
    record: dict = {}
    for index, en_section in enumerate(en_sections):
        zh_section = zh_sections[index]
        if not en_section.lines and not zh_section.lines:
            continue
        record[keys[index] if index < len(keys) else '/'] = TranslationSectionHashes(
            _section_hash(en_section.lines),
            _section_hash(zh_section.lines),
        )
    return record


def translation_side_sections(
    content: str,
    source_path: str,
    context: TranslationPairingRecordContext,
) -> list:
    """Compute one side's section list and hashes without its counterpart."""

    normalized = normalize_paired_link_targets(
        content,
        scan_markdown(content),
        LinkContext(source_path, context.is_pair_source),
    )
    sections = _raw_sections(normalized)
    keys = _section_keys(sections)
    return [
        TranslationSectionEntry(
            keys[index] if index < len(keys) else '/',
            section.line,
            _section_hash(section.lines),
            len(section.lines) == 0,
        )
        for index, section in enumerate(sections)
    ]


def parse_translation_pairing_record(content: str) -> Optional[dict]:
    """Parse a consistency record; None when the format is invalid."""

    record: dict = {}
    lines = [
        line for line in content.split('\n')
        if line != '' and not line.startswith('#')
    ]
    index = 0
    while index < len(lines):
        key_match = _KEY_LINE.match(lines[index])
        en_match = _HASH_LINE.match(lines[index + 1]) if index + 1 < len(lines) else None
        zh_match = _HASH_LINE.match(lines[index + 2]) if index + 2 < len(lines) else None
        key = key_match.group(1) if key_match is not None else None
        if (key is None
                or key in record
                or en_match is None
                or zh_match is None
                or en_match.group(1) != 'en'
                or zh_match.group(1) != 'zh'):
            return None
        record[key] = TranslationSectionHashes(en_match.group(2), zh_match.group(2))
        index += 3
    return record


def render_translation_pairing_record(record: dict) -> str:
    """Render the canonical text of a consistency record."""

    lines = [
        '# Bilingual-pair consistency record (sections keyed by the English heading slug path):',
        "# one entry per heading section, hashing each side's lines outside fenced code",
        '# blocks and excluding the language-switcher line, with paired-document link',
        '# targets normalized to a locale-neutral form. The header names no path, so the',
        "# same record is valid beside a pair's source and beside its installed copy.",
        '# After editing either side, re-record the pair:',
        '#   python3 .agents/se/scripts/docs/verify_translation_pairing.py --write <pair>',
    ]
    for key, hashes in record.items():
        lines.append(f'{key}:')
        lines.append(f'  en: {hashes.en}')
        lines.append(f'  zh: {hashes.zh}')
    lines.append('')
    return '\n'.join(lines)


def translation_pairing_record_diff(recorded: dict, current: dict) -> list:
    """Compare a confirmed record with the record of the current content."""

    out: list = []
    for key, hashes in current.items():
        confirmed = recorded.get(key)
        if confirmed is None:
            out.append(TranslationPairingRecordDiff(key, 'unconfirmed', []))
            continue
        sides = [side for side in ('en', 'zh') if getattr(confirmed, side) != getattr(hashes, side)]
        if len(sides) > 0:
            out.append(TranslationPairingRecordDiff(key, 'changed', sides))
    for key in recorded.keys():
        if key not in current:
            out.append(TranslationPairingRecordDiff(key, 'stale', []))
    return out
