#!/usr/bin/env python3
"""Check engine and report renderer for the bilingual pairing gate.

Gate output follows this repository's convention: every finding carries four
parts (发现 / 期望 / 修复 / 契约), and every run - including a green one - ends
with the unchecked-items declaration.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from typing import Optional

from translation_links import (
    LinkContext,
    MarkdownLink,
    MarkdownScan,
    detect_language_switcher,
    expected_locale_path,
    expected_switcher,
    is_external_destination,
    paired_link_target,
    scan_markdown,
    split_destination,
)
from translation_pairing import (
    NON_SOURCE_DIRECTORIES,
    TranslationPairPaths,
    TranslationPairingManifest,
    TranslationPairingRequest,
    TranslationStructureDivergence,
    is_translation_pairing_manifest_excluded,
    is_translation_scope_file,
    parse_translation_pairing_cli_args,
    parse_translation_pairing_manifest,
    translation_pair_paths,
    translation_structure_diff,
    translation_structure_signature,
)
from translation_pairing_record import (
    TranslationPairingRecordDiff,
    compute_translation_pairing_record,
    parse_translation_pairing_record,
    render_translation_pairing_record,
    translation_pairing_record_diff,
)

__all__ = [
    'PairingFinding',
    'PairingState',
    'PairingReport',
    'UNCHECKED_DECLARATION',
    'check_translation_pairing',
    'format_pairing_report',
]


@dataclass
class PairingFinding:
    """One actionable finding."""

    rule: str
    path: str
    line: int
    found: str
    expect: str
    fix: str


@dataclass
class PairingState:
    """Pairing state of one document, as reported by --list."""

    source: str
    state: str


@dataclass
class PairingReport:
    """Full result of one gate run."""

    exit_code: int
    mode: str
    findings: list = field(default_factory=list)
    states: list = field(default_factory=list)
    messages: list = field(default_factory=list)
    summary: str = ''


# Items the gate cannot decide automatically and must leave to review.
UNCHECKED_DECLARATION = '\n'.join([
    '未自动检查（4 项，需 review）',
    '  R1 译文忠实性   R2 术语一致性   R3 中文自然度',
    '  R4 行内代码、列表与表格顺序、图片替代文本与呈现、强调',
    '  清单：.agents/se/contracts/i18n/translation-rules.md',
])

CONTRACT = '.agents/se/contracts/i18n/README.md'
MANIFEST = '.agents/se/scripts/docs/translation-pairing.manifest.json'


@dataclass
class Corpus:
    root: str
    manifest: TranslationPairingManifest
    files: set
    actual_by_lower: dict
    sources: list
    excluded_artifacts: list
    is_pair_source: object


def walk(root: str) -> list:
    out: list = []

    def visit(relative: str) -> None:
        absolute = root if relative == '' else os.path.join(root, relative)
        try:
            entries = list(os.scandir(absolute))
        except OSError:
            return
        for entry in entries:
            child = entry.name if relative == '' else f'{relative}/{entry.name}'
            try:
                is_directory = entry.is_dir(follow_symlinks=False)
            except OSError:
                is_directory = False
            if is_directory:
                if entry.name in NON_SOURCE_DIRECTORIES:
                    continue
                # A nested checkout or worktree carries its own root-relative
                # links; scanning it reports every pair twice and resolves the
                # links against the wrong root.
                if os.path.exists(os.path.join(absolute, entry.name, '.git')):
                    continue
                visit(child)
                continue
            try:
                is_file = entry.is_file(follow_symlinks=False)
            except OSError:
                is_file = False
            if not is_file:
                continue
            lower_child = child.lower()
            if lower_child.endswith('.md') or lower_child.endswith('.i18n.yaml'):
                out.append(child)

    visit('')
    return sorted(out)


def _strip_artifact(artifact: str) -> str:
    lower = artifact.lower()
    if lower.endswith('.zh.md'):
        return artifact[:-len('.zh.md')] + '.md'
    return artifact[:-len('.i18n.yaml')] + '.md'


def _read_utf8(path: str) -> str:
    with open(path, 'r', encoding='utf-8', newline='') as handle:
        return handle.read()


def _read_manifest(root: str) -> TranslationPairingManifest:
    path = os.path.join(root, MANIFEST)
    if not os.path.exists(path):
        raise ValueError(f'缺少 {MANIFEST}')
    return parse_translation_pairing_manifest(_read_utf8(path))


def _build_corpus(root: str) -> Corpus:
    manifest = _read_manifest(root)
    file_list = walk(root)
    files = set(file_list)
    actual_by_lower: dict = {}
    for file in file_list:
        actual_by_lower[file.lower()] = file
    excluded_artifacts: list = []
    source_set: set = set()
    # Frozen archived decision records keep their triplet; links into them still
    # normalize to a locale-neutral anchor.
    archived_anchors: set = set()
    for file in file_list:
        if is_translation_scope_file(file) and not is_translation_pairing_manifest_excluded(file, manifest):
            source_set.add(file)
        lower_file = file.lower()
        if (file.startswith('.agents/notes/archived/')
                and lower_file.endswith('.md')
                and not lower_file.endswith('.zh.md')):
            archived_anchors.add(file)
        if not lower_file.endswith('.zh.md') and not lower_file.endswith('.i18n.yaml'):
            continue
        candidate = _strip_artifact(file)
        anchor = actual_by_lower.get(candidate.lower(), candidate)
        if is_translation_pairing_manifest_excluded(anchor, manifest):
            excluded_artifacts.append(file)
            continue
        if is_translation_scope_file(anchor):
            source_set.add(anchor)
    sources = sorted(source_set)

    def is_pair_source(source: str) -> bool:
        return (
            is_translation_scope_file(source)
            and not is_translation_pairing_manifest_excluded(source, manifest)
        ) or source in archived_anchors

    return Corpus(
        root,
        manifest,
        files,
        actual_by_lower,
        sources,
        excluded_artifacts,
        is_pair_source,
    )


def _read_repository_file(root: str, file: str) -> str:
    return _read_utf8(os.path.join(root, file))


def _finding(rule: str, path: str, line: int, found: str, expect: str, fix: str) -> PairingFinding:
    return PairingFinding(rule, path, line, found, expect, fix)


def _show(value: Optional[str]) -> str:
    if value is None:
        return '（缺失）'
    text = json.dumps(value, ensure_ascii=False)
    return f'{text[:72]}…' if len(text) > 72 else text


def _structure_finding(
    source: str,
    side_path: str,
    divergence: TranslationStructureDivergence,
) -> PairingFinding:
    en = _show(divergence.en.value if divergence.en is not None else None)
    zh = _show(divergence.zh.value if divergence.zh is not None else None)
    line = 1
    if divergence.zh is not None:
        line = divergence.zh.line
    elif divergence.en is not None:
        line = divergence.en.line
    return _finding(
        'P4',
        side_path,
        line,
        f'第 {divergence.index} 个{divergence.field}两侧不一致：英文侧 {en}，中文侧 {zh}',
        f'两侧第 {divergence.index} 个{divergence.field}逐项一致',
        f'让 {side_path} 的{divergence.field}与 {source} 对齐；围栏代码块必须逐字相同，'
        f'标题层级与顺序、表格行列数、列表类型与条目数、链接语义目标都要一一对应',
    )


def _switcher_finding(
    paths: TranslationPairPaths,
    scan: MarkdownScan,
    side: str,
) -> Optional[PairingFinding]:
    path = paths.source if side == 'en' else paths.zh
    counterpart = paths.zh if side == 'en' else paths.source
    expected = expected_switcher(side, counterpart)
    h1 = None
    for heading in scan.headings:
        if heading.depth == 1:
            h1 = heading
            break
    line = 1 if h1 is None else h1.line_index + 1
    detected = detect_language_switcher(scan)
    if detected is None:
        return _finding(
            'P3',
            path,
            line,
            'H1 后的第一段不是规范的语言切换行',
            expected,
            f'在 H1 之后空一行写入 {expected}',
        )
    if h1 is not None and detected.line_index != h1.line_index + 2:
        return _finding(
            'P3',
            path,
            detected.line_index + 1,
            f'语言切换行与 H1 之间隔了 {max(0, detected.line_index - h1.line_index - 2)} 个多余空行',
            f'H1 后恰好一个空行，切换行紧随其后（第 {h1.line_index + 3} 行）',
            f'把切换行移到第 {h1.line_index + 3} 行',
        )
    if detected.text != expected:
        return _finding(
            'P3',
            path,
            detected.line_index + 1,
            f'语言切换行为 {detected.text}（目标 {detected.target}）',
            expected,
            f'把该行改为 {expected}',
        )
    return None


def _semantic_link_target(link: MarkdownLink, side_path: str, corpus: Corpus) -> str:
    target = paired_link_target(
        link.destination,
        LinkContext(side_path, corpus.is_pair_source),
    )
    return link.destination if target is None else f'pair:/{target.anchor}{target.suffix}'


def _locale_findings(
    paths: TranslationPairPaths,
    side: str,
    scan: MarkdownScan,
    corpus: Corpus,
) -> list:
    path = paths.source if side == 'en' else paths.zh
    switcher = detect_language_switcher(scan)
    out: list = []
    for link in scan.links:
        if link.image:
            continue
        if switcher is not None and link.line == switcher.line_index + 1:
            continue
        if is_external_destination(link.destination):
            continue
        target = paired_link_target(
            link.destination,
            LinkContext(path, corpus.is_pair_source),
        )
        if target is None:
            continue
        expected = expected_locale_path(target.anchor, side)
        authored_path = split_destination(link.destination)[0]
        if target.destination_path != expected:
            out.append(_finding(
                'P5',
                path,
                link.line,
                f'成对文档链接指向了 {authored_path}',
                f'/{expected}',
                f'把目标改为 /{expected}',
            ))
            continue
        if not authored_path.startswith('/'):
            out.append(_finding(
                'P5',
                path,
                link.line,
                f'成对文档链接 {authored_path} 没有按仓库根解析',
                f'/{expected}',
                f'改写为 /{expected}',
            ))
    return out


def _record_line(content: str, key: str) -> int:
    lines = content.split('\n')
    try:
        index = lines.index(f'{key}:')
    except ValueError:
        index = -1
    return 1 if index < 0 else index + 1


def _record_findings(
    paths: TranslationPairPaths,
    meta_content: str,
    en: str,
    zh: str,
    context,
) -> list:
    recorded = parse_translation_pairing_record(meta_content)
    if recorded is None:
        return [_finding(
            'P2',
            paths.meta,
            1,
            '一致性记录格式不合法（应为文件头注释 + 每小节三行：键、en、zh）',
            '规范的一致性记录',
            f'重录该对：python3 .agents/se/scripts/docs/verify_translation_pairing.py --write {paths.source}',
        )]
    current = compute_translation_pairing_record(paths, en, zh, context)
    diff = translation_pairing_record_diff(recorded, current)
    if len(diff) == 0:
        if meta_content == render_translation_pairing_record(current):
            return []
        return [_finding(
            'P2',
            paths.meta,
            1,
            '一致性记录的内容正确但不是规范格式',
            '按当前内容渲染出的规范记录',
            f'重录该对：python3 .agents/se/scripts/docs/verify_translation_pairing.py --write {paths.source}',
        )]
    out: list = []
    for entry in diff:
        if entry.kind == 'unconfirmed':
            found = f'小节 {entry.key} 有未确认的内容'
        elif entry.kind == 'stale':
            found = f'小节 {entry.key} 已记录但不再有内容'
        else:
            found = f'小节 {entry.key} 自确认后已变更（{"、".join(entry.sides)}）'
        out.append(_finding(
            'P2',
            paths.meta,
            _record_line(meta_content, entry.key),
            found,
            '记录中的每个小节哈希都等于两侧当前内容的哈希',
            f'先让两侧内容一致，再重录该对：python3 .agents/se/scripts/docs/verify_translation_pairing.py --write {paths.source}',
        ))
    return out


def _pair_texts(root: str, paths: TranslationPairPaths) -> tuple:
    return (
        _read_repository_file(root, paths.source),
        _read_repository_file(root, paths.zh),
    )


def _inspect_pair(corpus: Corpus, paths: TranslationPairPaths, meta_content: Optional[str] = None) -> list:
    findings: list = []
    en, zh = _pair_texts(corpus.root, paths)
    scan_en = scan_markdown(en)
    scan_zh = scan_markdown(zh)
    for path, scan in ((paths.source, scan_en), (paths.zh, scan_zh)):
        for problem in scan.problems:
            findings.append(_finding(
                'P4',
                path,
                1,
                problem,
                '可被结构签名完整分析的 Markdown',
                '改用 ATX 标题并闭合每个围栏代码块',
            ))
    en_switcher = _switcher_finding(paths, scan_en, 'en')
    if en_switcher is not None:
        findings.append(en_switcher)
    zh_switcher = _switcher_finding(paths, scan_zh, 'zh')
    if zh_switcher is not None:
        findings.append(zh_switcher)

    en_switcher_scan = detect_language_switcher(scan_en)
    zh_switcher_scan = detect_language_switcher(scan_zh)
    signature_en = translation_structure_signature(
        scan_en,
        lambda link: _semantic_link_target(link, paths.source, corpus),
        en_switcher_scan.line_index if en_switcher_scan is not None else None,
    )
    signature_zh = translation_structure_signature(
        scan_zh,
        lambda link: _semantic_link_target(link, paths.zh, corpus),
        zh_switcher_scan.line_index if zh_switcher_scan is not None else None,
    )
    for divergence in translation_structure_diff(signature_en, signature_zh):
        findings.append(_structure_finding(paths.source, paths.zh, divergence))

    findings.extend(_locale_findings(paths, 'en', scan_en, corpus))
    findings.extend(_locale_findings(paths, 'zh', scan_zh, corpus))

    if meta_content is not None:
        record_context = _RecordContext(corpus.is_pair_source)
        try:
            findings.extend(_record_findings(paths, meta_content, en, zh, record_context))
        except Exception as error:  # noqa: BLE001 - report the failure as a finding
            findings.append(_finding(
                'P2',
                paths.meta,
                1,
                f'无法计算一致性记录：{error}',
                '两侧分节结构可以被记录',
                f'先修复两侧的标题结构，再运行 python3 .agents/se/scripts/docs/verify_translation_pairing.py --write {paths.source}',
            ))
    return findings


class _RecordContext:
    __slots__ = ('is_pair_source',)

    def __init__(self, is_pair_source) -> None:
        self.is_pair_source = is_pair_source


def _completeness_findings(corpus: Corpus, source: str) -> list:
    paths = translation_pair_paths(source)
    has_source = paths.source in corpus.files
    has_zh = paths.zh in corpus.files
    has_meta = paths.meta in corpus.files
    findings: list = []
    if not has_source:
        artifact = paths.zh if has_zh else paths.meta
        findings.append(_finding(
            'P1',
            artifact,
            1,
            f'存在配对产物但缺少英文锚点 {paths.source}',
            '三件套齐全',
            f'补写 {paths.source}，或删除残留的 {artifact}',
        ))
        return findings
    if not has_zh:
        findings.append(_finding(
            'P1',
            paths.source,
            1,
            f'缺少中文对侧 {paths.zh}',
            '在范围文档必须成对合并',
            f'创建 {paths.zh}（参照 .agents/se/contracts/i18n/translation-rules.md），'
            f'再运行 python3 .agents/se/scripts/docs/verify_translation_pairing.py --write {paths.source}',
        ))
    if not has_meta and has_zh:
        findings.append(_finding(
            'P1',
            paths.source,
            1,
            f'缺少一致性记录 {paths.meta}',
            '每个完整配对都有一份规范记录',
            f'运行 python3 .agents/se/scripts/docs/verify_translation_pairing.py --write {paths.source}',
        ))
    return findings


def _pair_state(corpus: Corpus, source: str) -> PairingState:
    paths = translation_pair_paths(source)
    if paths.source not in corpus.files or paths.zh not in corpus.files or paths.meta not in corpus.files:
        return PairingState(source, 'missing')
    try:
        meta = _read_repository_file(corpus.root, paths.meta)
        findings = _inspect_pair(corpus, paths, meta)
        return PairingState(source, 'ok' if len(findings) == 0 else 'out-of-sync')
    except Exception:  # noqa: BLE001 - an unreadable pair is out of sync
        return PairingState(source, 'out-of-sync')


def _validate_named_anchors(corpus: Corpus, anchors: list) -> list:
    findings: list = []
    for anchor in anchors:
        if (not is_translation_scope_file(anchor)
                or is_translation_pairing_manifest_excluded(anchor, corpus.manifest)):
            findings.append(_finding(
                'P1',
                anchor,
                1,
                '不是在范围、未被排除的配对',
                '.agents/se/contracts/i18n/README.md 定义的在范围文档（任取三件套之一或去后缀 stem）',
                '改传一个在范围配对路径',
            ))
            continue
        paths = translation_pair_paths(anchor)
        if not any(file in corpus.files for file in (paths.source, paths.zh, paths.meta)):
            findings.append(_finding(
                'P1',
                anchor,
                1,
                '磁盘上没有任何该配对的三个文件',
                '至少存在英文源、中文对侧或记录之一',
                f'确认路径，或先创建 {paths.source}',
            ))
    return findings


def _usage_report(summary: str, findings: Optional[list] = None, messages: Optional[list] = None) -> PairingReport:
    return PairingReport(
        2,
        'usage',
        findings or [],
        [],
        messages or [],
        f'verify-translation-pairing: {summary}',
    )


def check_translation_pairing(root: str, argv: list) -> PairingReport:
    """Run one pairing gate."""

    try:
        request = parse_translation_pairing_cli_args(argv)
    except Exception as error:  # noqa: BLE001 - usage error
        return _usage_report(str(error))

    try:
        corpus = _build_corpus(root)
    except Exception as error:  # noqa: BLE001 - configuration error
        return _usage_report(str(error))

    anchors = [
        anchor if anchor in corpus.files
        else corpus.actual_by_lower.get(anchor.lower(), anchor)
        for anchor in request.anchors
    ]
    request = TranslationPairingRequest(request.mode, request.scope, anchors)

    if request.mode == 'list':
        states = [_pair_state(corpus, source) for source in corpus.sources]
        counts = {'ok': 0, 'missing': 0, 'out-of-sync': 0}
        for state in states:
            counts[state.state] += 1
        artifact_lines = [f'excluded-artifact  {artifact}' for artifact in corpus.excluded_artifacts]
        summary = (
            f'verify-translation-pairing: {len(states)} 对文档'
            f'（ok {counts["ok"]}，missing {counts["missing"]}，out-of-sync {counts["out-of-sync"]}）'
        )
        if len(artifact_lines) > 0:
            summary += f'，{len(artifact_lines)} 个被排除路径产物'
        return PairingReport(
            0,
            'list',
            [],
            states,
            [f'{state.state}  {state.source}' for state in states] + artifact_lines,
            summary,
        )

    if request.mode == 'write':
        named_anchors = request.anchors
        invalid = _validate_named_anchors(corpus, named_anchors)
        if len(invalid) > 0:
            return _usage_report('点名了不可重录的配对', invalid)
        targets = named_anchors if request.scope == 'pairs' else corpus.sources
        pending: list = []
        recorded = 0
        skipped = 0
        for source in targets:
            paths = translation_pair_paths(source)
            if paths.source not in corpus.files or paths.zh not in corpus.files:
                if request.scope == 'pairs':
                    missing = f' {paths.zh}' if paths.source in corpus.files else f' {paths.source}'
                    return _usage_report(f'无法重录 {source}：缺少{missing}')
                skipped += 1
                continue
            try:
                en, zh = _pair_texts(root, paths)
                content = render_translation_pairing_record(compute_translation_pairing_record(
                    paths,
                    en,
                    zh,
                    _RecordContext(corpus.is_pair_source),
                ))
                recorded += 1
                pending.append((source, paths.meta, content))
            except Exception as error:  # noqa: BLE001 - report the failure
                return _usage_report(f'无法重录 {source}：{error}')
        messages: list = []
        staged: list = []
        for _source, meta, content in pending:
            meta_path = os.path.join(root, meta)
            if os.path.exists(meta_path) and _read_utf8(meta_path) == content:
                continue
            temp_path = f'{meta_path}.tmp-pairing-{os.getpid()}'
            try:
                os.makedirs(os.path.dirname(meta_path), exist_ok=True)
                with open(temp_path, 'w', encoding='utf-8', newline='') as handle:
                    handle.write(content)
                staged.append((meta_path, temp_path, meta))
            except Exception as error:  # noqa: BLE001 - report the failure
                for meta_path_entry, temp_path_entry, _meta in staged:
                    try:
                        os.unlink(temp_path_entry)
                    except OSError:
                        pass
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
                return _usage_report(f'无法写入 {meta}：{error}')
        for meta_path, temp_path, meta in staged:
            os.replace(temp_path, meta_path)
            messages.append(f'verify-translation-pairing: 已重录 {meta}')
        written = len(staged)
        return PairingReport(
            0,
            'write',
            [],
            [],
            messages,
            f'verify-translation-pairing: 写入 {written} 个记录（处理 {recorded} 对，'
            f'跳过 {skipped} 对不完整配对）；运行检查验证配对。',
        )

    anchors = request.anchors if request.scope == 'pairs' else corpus.sources
    findings: list = []
    if request.scope == 'pairs':
        invalid = _validate_named_anchors(corpus, anchors)
        if len(invalid) > 0:
            return _usage_report('点名了不在范围的配对', invalid)
    if request.scope == 'corpus':
        for artifact in corpus.excluded_artifacts:
            findings.append(_finding(
                'P1',
                artifact,
                1,
                '被排除路径带有配对产物',
                '被排除路径不得有 .zh.md 与 .i18n.yaml',
                f'删除 {artifact}',
            ))
    for source in anchors:
        try:
            findings.extend(_completeness_findings(corpus, source))
            paths = translation_pair_paths(source)
            if paths.source in corpus.files and paths.zh in corpus.files:
                meta = _read_repository_file(root, paths.meta) if paths.meta in corpus.files else None
                findings.extend(_inspect_pair(corpus, paths, meta))
        except Exception as error:  # noqa: BLE001 - report the failure
            findings.append(_finding(
                'P1',
                source,
                1,
                f'无法读取或解析配对：{error}',
                '配对文件可读、为 UTF-8，且 Markdown 可分析',
                '修复文件权限/编码或结构问题后重跑',
            ))
    summary = (
        f'verify-translation-pairing: 通过（检查 {len(anchors)} 对文档，0 处错误）'
        if len(findings) == 0
        else f'verify-translation-pairing: 失败（检查 {len(anchors)} 对文档，{len(findings)} 处错误）'
    )
    return PairingReport(
        0 if len(findings) == 0 else 1,
        'check',
        findings,
        [],
        [],
        summary,
    )


def _render_finding(item: PairingFinding) -> str:
    return '\n'.join([
        f'✗ {item.path}:{item.line}  [{item.rule}]',
        f'  发现：{item.found}',
        f'  期望：{item.expect}',
        f'  修复：{item.fix}',
        f'  契约：{CONTRACT}#{item.rule.lower()}',
    ])


def format_pairing_report(report: PairingReport) -> str:
    """Render a gate result as the gate output text."""

    if report.mode == 'usage':
        blocks = [_render_finding(item) for item in report.findings]
        if len(blocks) > 0:
            blocks.append('')
        blocks.extend(report.messages)
        blocks.append(report.summary)
        blocks.append('')
        blocks.append(UNCHECKED_DECLARATION)
        return '\n'.join(blocks)
    blocks = []
    for item in report.findings:
        blocks.append(_render_finding(item))
    if len(report.findings) > 0:
        blocks.append('')
    blocks.extend(report.messages)
    blocks.append(report.summary)
    blocks.append('')
    blocks.append(UNCHECKED_DECLARATION)
    return '\n'.join(blocks)
