#!/usr/bin/env python3
"""Markdown scanning and repository-root-relative link resolution for the pairing gate.

The scanner covers the Markdown subset this repository's documents actually use:
ATX headings, fenced code blocks, GFM tables, lists and inline/reference links.
Content inside fenced code blocks and inline code takes no part in link, table or
list recognition.
"""

from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass
from typing import Callable, Optional

__all__ = [
    'MarkdownLink',
    'MarkdownHeading',
    'CodeBlock',
    'MarkdownScan',
    'PairedLinkTarget',
    'LinkContext',
    'LanguageSwitcher',
    'js_trim',
    'mask_inline_code',
    'leading_frontmatter',
    'scan_markdown',
    'list_marker',
    'is_external_destination',
    'split_destination',
    'resolve_destination',
    'paired_link_target',
    'expected_locale_path',
    'expected_switcher',
    'detect_language_switcher',
    'normalize_paired_link_targets',
]


@dataclass
class MarkdownLink:
    """One link target occurrence in a document."""

    line: int
    start: int
    end: int
    destination: str
    image: bool


@dataclass
class MarkdownHeading:
    """One ATX heading."""

    line_index: int
    depth: int
    text: str


@dataclass
class CodeBlock:
    """One fenced code block: opening fence line plus content, 0-based."""

    line_index: int
    text: str


@dataclass
class MarkdownScan:
    """Scan result of one document."""

    fenced: list
    code_blocks: list
    headings: list
    links: list
    masked: list
    problems: list


@dataclass
class PairedLinkTarget:
    """Repository-root-relative paired-document link target."""

    anchor: str
    suffix: str
    destination_path: str


@dataclass
class LinkContext:
    """Context needed to resolve one link target."""

    source_path: str
    is_pair_source: Callable[[str], bool]


@dataclass
class LanguageSwitcher:
    """Recognized language-switcher line."""

    line_index: int
    text: str
    target: str
    locale: str


class _CommentState:
    __slots__ = ('open',)

    def __init__(self) -> None:
        self.open = False


# ECMAScript String.prototype.trim removes U+FEFF as whitespace; Python's
# str.strip does not, so a shared helper keeps the implementations aligned.
_JS_TRIM = re.compile(r'^[\s\ufeff]+|[\s\ufeff]+$')
_JS_SPACES = re.compile(r'[\s\ufeff]+')


def js_trim(text: str) -> str:
    """Trim a string the way ECMAScript String.prototype.trim does."""

    return _JS_TRIM.sub('', text)


def mask_inline_code(line: str) -> str:
    """Replace inline code spans with equal-length spaces."""

    characters = list(line)
    length = len(characters)
    index = 0
    while index < length:
        if characters[index] != '`':
            index += 1
            continue
        run = 0
        while index + run < length and characters[index + run] == '`':
            run += 1
        opener = index
        cursor = index + run
        closed = False
        while cursor < length:
            if characters[cursor] != '`':
                cursor += 1
                continue
            closing = 0
            while cursor + closing < length and characters[cursor + closing] == '`':
                closing += 1
            if closing == run:
                for masked in range(opener, cursor + closing):
                    characters[masked] = ' '
                index = cursor + closing
                closed = True
                break
            cursor += closing
        if not closed:
            index += run
    return ''.join(characters)


def _mask_html_comment_spans(line: str, state: _CommentState) -> str:
    characters = list(line)
    length = len(characters)
    index = 0
    while index < length:
        if state.open:
            if (index + 2 < length and characters[index] == '-'
                    and characters[index + 1] == '-' and characters[index + 2] == '>'):
                characters[index] = ' '
                characters[index + 1] = ' '
                characters[index + 2] = ' '
                index += 3
                state.open = False
                continue
            characters[index] = ' '
            index += 1
            continue
        if (index + 3 < length and characters[index] == '<'
                and characters[index + 1] == '!' and characters[index + 2] == '-'
                and characters[index + 3] == '-'):
            characters[index] = ' '
            characters[index + 1] = ' '
            characters[index + 2] = ' '
            characters[index + 3] = ' '
            index += 4
            state.open = True
            continue
        index += 1
    return ''.join(characters)


def leading_frontmatter(raw_lines: list) -> Optional[tuple]:
    """Return the 0-based inclusive span of leading YAML frontmatter, if any."""

    if js_trim(raw_lines[0] if raw_lines else '') != '---':
        return None
    for index in range(1, len(raw_lines)):
        if js_trim(raw_lines[index]) == '---':
            return (0, index)
    return None


_ATX_HEADING = re.compile(r'^(#{1,6})(?:[ \t]+(.*))?$')
_FENCE_OPEN = re.compile(r'^ {0,3}(' + '`' + r'{3,}|~{3,})(.*)$')
_DEFINITION = re.compile(r'^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>]*>|\S+)')
_SETEXT = re.compile(r'^ {0,3}(?:={3,}|-{3,})[ \t]*$')
_LINK_OPENER = re.compile(r'(!?)\[([^\]]*)\]\([ \t]*')
_SWITCHER_EN = re.compile(r'^English \| \[中文\]\(([^()\s]+)\)$')
_SWITCHER_ZH = re.compile(r'^\[English\]\(([^()\s]+)\) \| 中文$')
_LIST_MARKER = re.compile(r'^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+|$)')


def scan_markdown(content: str) -> MarkdownScan:
    """Scan one Markdown document, collecting fenced blocks, headings and links."""

    raw_lines = content.split('\n')
    fenced = [False] * len(raw_lines)
    code_blocks: list = []
    problems: list = []
    frontmatter = leading_frontmatter(raw_lines)
    if frontmatter is not None:
        # Frontmatter lines are opaque structure: marked fenced so headings, tables,
        # lists, links and section hashes ignore them, but kept out of code_blocks
        # because the two sides may legitimately carry different frontmatter.
        for mark in range(frontmatter[0], frontmatter[1] + 1):
            fenced[mark] = True
    index = 0
    while index < len(raw_lines):
        if fenced[index]:
            index += 1
            continue
        line = raw_lines[index]
        opened = _FENCE_OPEN.match(line)
        if opened is None:
            index += 1
            continue
        marker = opened.group(1)
        fence_character = '~' if marker[0] == '~' else '`'
        closer = re.compile(
            r'^ {0,3}' + re.escape(fence_character) + '{' + str(len(marker)) + r',}[ \t]*$'
        )
        end = index + 1
        while end < len(raw_lines) and not closer.match(raw_lines[end]):
            end += 1
        if end >= len(raw_lines):
            problems.append(f'第 {index + 1} 行的围栏代码块没有闭合')
            for mark in range(index, len(raw_lines)):
                fenced[mark] = True
            code_blocks.append(CodeBlock(index, '\n'.join(raw_lines[index:])))
            index = len(raw_lines)
            break
        for mark in range(index, end + 1):
            fenced[mark] = True
        code_blocks.append(CodeBlock(index, '\n'.join(raw_lines[index:end + 1])))
        index = end + 1

    masked: list = []
    headings: list = []
    links: list = []
    line_start = 0
    comment_state = _CommentState()
    for line_index, line in enumerate(raw_lines):
        if fenced[line_index]:
            masked_line = ' ' * len(line)
            comment_state.open = False
        else:
            masked_line = _mask_html_comment_spans(mask_inline_code(line), comment_state)
        masked.append(masked_line)
        if not fenced[line_index]:
            heading = _ATX_HEADING.match(masked_line)
            if heading is not None:
                raw = raw_lines[line_index]
                heading_raw = _ATX_HEADING.match(raw)
                raw_text = (
                    heading_raw.group(2)
                    if heading_raw is not None and heading_raw.group(2) is not None
                    else ''
                )
                text = js_trim(re.sub(r'[ \t]+#+[ \t]*$', '', raw_text))
                headings.append(MarkdownHeading(line_index, len(heading.group(1)), text))
            collect_line_links(raw_lines[line_index], masked_line, line_start, line_index, links)
            definition = _DEFINITION.match(masked_line)
            if definition is not None:
                destination_start = (
                    definition.start() + len(definition.group(0)) - len(definition.group(2))
                )
                raw_destination = definition.group(2)
                unwrapped = (
                    raw_destination[1:-1]
                    if raw_destination.startswith('<') and raw_destination.endswith('>')
                    else raw_destination
                )
                links.append(MarkdownLink(
                    line_index + 1,
                    line_start + destination_start,
                    line_start + destination_start + len(raw_destination),
                    unwrapped,
                    False,
                ))
        line_start += len(line) + 1

    for line_index in range(1, len(raw_lines)):
        if fenced[line_index] or fenced[line_index - 1]:
            continue
        if _SETEXT.match(masked[line_index]) is None:
            continue
        previous = js_trim(masked[line_index - 1])
        if previous == '' or _ATX_HEADING.match(masked[line_index - 1]) is not None:
            continue
        if list_marker(masked[line_index - 1]) is None:
            problems.append(f'第 {line_index + 1} 行使用了不支持的 setext 标题')

    return MarkdownScan(fenced, code_blocks, headings, links, masked, problems)


def collect_line_links(
    line: str,
    masked_line: str,
    line_start: int,
    line_index: int,
    links: list,
) -> None:
    """Collect inline links on one line."""

    position = 0
    length = len(line)
    while True:
        match = _LINK_OPENER.search(masked_line, position)
        if match is None:
            break
        after_paren = match.end()
        cursor = after_paren
        if cursor < length and line[cursor] == '<':
            close = line.find('>', cursor + 1)
            if close < 0:
                position = match.end()
                continue
            links.append(MarkdownLink(
                line_index + 1,
                line_start + cursor + 1,
                line_start + close,
                line[cursor + 1:close],
                match.group(1) == '!',
            ))
            position = close + 1
            continue
        while cursor < length and not re.match(r'[\s)]', line[cursor]):
            cursor += 1
        destination = line[after_paren:cursor]
        if destination == '':
            position = match.end()
            continue
        links.append(MarkdownLink(
            line_index + 1,
            line_start + after_paren,
            line_start + cursor,
            destination,
            match.group(1) == '!',
        ))
        position = cursor


def list_marker(line: str):
    """Return the leading list-marker match, or None."""

    return _LIST_MARKER.match(line)


def is_external_destination(destination: str) -> bool:
    """Whether a link target is external, protocol-relative or a pure anchor."""

    return re.match(r'^(?:[a-z][a-z0-9+.-]*:|//|#)', destination, re.IGNORECASE) is not None


def split_destination(destination: str) -> tuple:
    """Split a link target into its path and its query/fragment suffix."""

    cut = re.search(r'[?#]', destination)
    if cut is None:
        return (destination, '')
    index = cut.start()
    return (destination[:index], destination[index:])


_PERCENT_ESCAPE = re.compile(r'%(?![0-9A-Fa-f]{2})')


def _decode_path(path: str) -> str:
    try:
        if _PERCENT_ESCAPE.search(path) is not None:
            raise ValueError('malformed percent escape')
        return urllib.parse.unquote(path, errors='strict')
    except (ValueError, UnicodeDecodeError):
        return path


def resolve_destination(destination: str, source_path: str) -> Optional[str]:
    """Resolve a link target to a repository-root-relative path."""

    path = split_destination(destination)[0]
    if path == '' or is_external_destination(destination):
        return None
    decoded = _decode_path(path).replace('\\', '/')
    if decoded.startswith('/'):
        joined = posix_normalize(decoded[1:])
    else:
        joined = posix_normalize(directory_of(source_path) + '/' + decoded)
    if joined == '' or joined == '.' or joined == '..' or joined.startswith('../'):
        return None
    return joined


def directory_of(path: str) -> str:
    cut = path.rfind('/')
    return '' if cut < 0 else path[:cut]


def posix_normalize(path: str) -> str:
    segments: list = []
    for segment in path.split('/'):
        if segment == '' or segment == '.':
            continue
        if segment == '..':
            if segments:
                segments.pop()
            continue
        segments.append(segment)
    return '/'.join(segments)


def paired_link_target(destination: str, context: LinkContext) -> Optional[PairedLinkTarget]:
    """Resolve a target that points at an in-scope paired document."""

    destination_path = resolve_destination(destination, context.source_path)
    if destination_path is None:
        return None
    if destination_path.endswith('.zh.md'):
        anchor = destination_path[:-len('.zh.md')] + '.md'
    elif destination_path.endswith('.md'):
        anchor = destination_path
    else:
        anchor = None
    if anchor is None or not context.is_pair_source(anchor):
        return None
    suffix = split_destination(destination)[1]
    return PairedLinkTarget(anchor, suffix, destination_path)


def expected_locale_path(anchor: str, locale: str) -> str:
    """The expected localized path of an anchor for one side."""

    return re.sub(r'\.md$', '.zh.md', anchor) if locale == 'zh' else anchor


def expected_switcher(locale: str, counterpart: str) -> str:
    """The canonical text of the language-switcher line."""

    if locale == 'en':
        return f'English | [中文](/{counterpart})'
    return f'[English](/{counterpart}) | 中文'


def detect_language_switcher(scan: MarkdownScan) -> Optional[LanguageSwitcher]:
    """Find the language-switcher line in the first block after the H1."""

    h1 = None
    for heading in scan.headings:
        if heading.depth == 1:
            h1 = heading
            break
    if h1 is None:
        return None
    for index in range(h1.line_index + 1, len(scan.masked)):
        if scan.fenced[index]:
            return None
        text = js_trim(scan.masked[index])
        if text == '':
            continue
        en = _SWITCHER_EN.match(text)
        if en is not None:
            return LanguageSwitcher(index, text, en.group(1), 'en')
        zh = _SWITCHER_ZH.match(text)
        if zh is not None:
            return LanguageSwitcher(index, text, zh.group(1), 'zh')
        return None
    return None


def normalize_paired_link_targets(content: str, scan: MarkdownScan, context: LinkContext) -> str:
    """Replace paired-document link targets with a locale-neutral marker."""

    edits: list = []
    for link in scan.links:
        if link.image:
            continue
        target = paired_link_target(link.destination, context)
        if target is None:
            continue
        edits.append((link.start, link.end, f'pair:/{target.anchor}{target.suffix}'))
    normalized = content
    for start, end, value in sorted(edits, key=lambda edit: -edit[0]):
        normalized = normalized[:start] + value + normalized[end:]
    return normalized
