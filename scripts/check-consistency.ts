#!/usr/bin/env node
// Document and CI consistency check for hyprscope.
//
// Hard failures (block a commit):
//   - a document mentions "pnpm run <script>" that package.json does not define;
//   - a bilingual pair is incomplete;
//   - the install skill's frontmatter name no longer matches its directory;
//   - AGENTS.md or the install skill names a source path that does not exist;
//   - a build:* script is not covered by the CircleCI verification workflow;
//   - a tools/*/build.sh is not wired into package.json;
//   - the CI jobs and the verify workflow disagree.
//
// Reminders (do not block): staged changes that usually need a paired document
// or the install skill updated in the same commit. That is the sync prompt: the
// check cannot prove a document is still true, so it names the likely target.
//
// Usage: node scripts/check-consistency.ts [changed-path ...]
// With no arguments it reads "git diff --cached --name-only".
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const helperArg = String.fromCharCode(96);
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const exists = (p: string) => existsSync(join(root, p));
const pkg = JSON.parse(read('package.json'));
const scripts = pkg.scripts ?? {};
const ciText = read('.circleci/config.yml');

const failures: string[] = [];
const warnings: string[] = [];
const fail = (msg: string) => { failures.push(msg); };
const warn = (msg: string) => { warnings.push(msg); };

const skillPath = '.agents/skills/install-hyprscope/SKILL.md';
const documents: string[] = ['AGENTS.md', 'README.md', 'README.zh.md', skillPath, '.circleci/config.yml'];
for (const name of readdirSync(join(root, 'docs'))) {
  if (name.endsWith('.md')) documents.push('docs/' + name);
}

// 1. Every document reference to a pnpm script must resolve.
const pnpmBuiltins = new Set([
  'install', 'add', 'remove', 'exec', 'dlx', 'store', 'config', 'env', 'publish',
  'link', 'unlink', 'update', 'outdated', 'why', 'audit', 'licenses', 'list', 'ls',
  'root', 'bin', 'create', 'init', 'patch', 'deploy', 'import', 'rebuild', 'prune',
  'setup', 'version', 'help', 'approve', 'recursive',
]);
const codeContexts = (file: string, text: string) => {
  if (!file.endsWith('.md')) return text;
  const blocks = [...text.matchAll(/\x60{3}[\s\S]*?\x60{3}/g)].map((match) => match[0]);
  const spans = [...text.matchAll(/\x60[^\x60\n]+\x60/g)].map((match) => match[0]);
  return blocks.concat(spans).join('\n');
};
for (const file of documents) {
  const text = codeContexts(file, read(file));
  const ref = /pnpm (?:run )?([a-z][a-z0-9:._-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = ref.exec(text))) {
    const name = match[1];
    if (pnpmBuiltins.has(name)) continue;
    if (!Object.prototype.hasOwnProperty.call(scripts, name)) {
      fail(file + ': references pnpm script "' + name + '" but package.json does not define it');
    }
  }
}

// 2. Bilingual pairs are complete.
const pairStems = ['README'];
for (const name of readdirSync(join(root, 'docs'))) {
  if (name.endsWith('.md') && !name.endsWith('.zh.md')) pairStems.push('docs/' + name.replace(/\.md$/, ''));
}
for (const stem of pairStems) {
  for (const suffix of ['.zh.md', '.i18n.yaml']) {
    if (!exists(stem + suffix)) fail(stem + suffix + ': missing bilingual pair side (update both sides and re-record)');
  }
}

// 3. The install skill's frontmatter name matches its directory.
const skillText = read(skillPath);
const skillName = /^name:\s*(\S+)\s*$/m.exec(skillText);
if (!skillName || skillName[1] !== 'install-hyprscope') {
  fail(skillPath + ': frontmatter name must be "install-hyprscope" to match its directory');
}

// 4. Source paths named in AGENTS.md and the install skill exist.
const checkablePrefixes = ['src/', 'test/', 'docs/', 'plugins/', 'tools/', 'scripts/', '.agents/', 'probe/'];
const codeSpan = new RegExp(helperArg + '([^' + helperArg + '\\n]+)' + helperArg, 'g');
for (const file of ['AGENTS.md', skillPath]) {
  const text = read(file);
  let match: RegExpExecArray | null;
  while ((match = codeSpan.exec(text))) {
    let token = match[1].trim();
    if (!token || token.includes(' ') || token.includes('*') || token.includes('<') || token.includes('$')) continue;
    token = token.replace(/[.,;:]+$/, '');
    if (!checkablePrefixes.some((prefix) => token.startsWith(prefix))) continue;
    if (!exists(token)) fail(file + ': names path "' + token + '" but it does not exist');
  }
}

// 5. Every build:* script runs in CI, and every helper build script is wired.
for (const [name, command] of Object.entries(scripts)) {
  if (typeof command !== 'string' || !name.startsWith('build:')) continue;
  if (!ciText.includes(command) && !ciText.includes('pnpm run ' + name)) {
    fail('.circleci/config.yml: no step covers "' + name + '" (run "' + command + '" or "pnpm run ' + name + '")');
  }
}
for (const entry of readdirSync(join(root, 'tools'))) {
  const buildScript = 'tools/' + entry + '/build.sh';
  if (!exists(buildScript)) continue;
  const wired = Object.values(scripts).some((command) => typeof command === 'string' && command.includes(buildScript));
  if (!wired) fail(buildScript + ': no package.json script builds it');
}

// 6. CI jobs and the verify workflow agree.
const jobsBlock = ciText.slice(ciText.indexOf('jobs:'), ciText.indexOf('workflows:'));
const jobNames = [...jobsBlock.matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gm)].map((match) => match[1]);
const workflowBlock = ciText.slice(ciText.indexOf('workflows:'));
const listedJobs = [...workflowBlock.matchAll(/^\s{6}- ([a-z][a-z0-9-]*)\s*$/gm)].map((match) => match[1]);
for (const job of jobNames) {
  if (!listedJobs.includes(job)) fail('.circleci/config.yml: job "' + job + '" is not in the verify workflow');
}
for (const job of listedJobs) {
  if (!jobNames.includes(job)) fail('.circleci/config.yml: workflow lists unknown job "' + job + '"');
}

// 7. Sync reminders: changed areas that usually need a document or skill update.
const args = process.argv.slice(2);
let changed: string[] = [];
if (args.length > 0) {
  changed = args.map((arg) => arg.replace(/^\.\//, ''));
} else {
  const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRT'], { encoding: 'utf8' }).trim();
  changed = staged ? staged.split('\n') : [];
}
const touched = new Set(changed);
const touchedDoc = (target: string) => {
  if (touched.has(target)) return true;
  if (target.endsWith('.md') && !target.endsWith('.zh.md')) return touched.has(target.slice(0, -3) + '.zh.md');
  return false;
};
const rules = [
  { match: /^(src\/cli\.ts|src\/screenshot\.ts|src\/format\.ts)$/, needs: ['README.md', 'docs/PROTOCOL.md', skillPath], why: 'the read-only surface changed' },
  { match: /^src\/plan\//, needs: ['docs/PLAN.md', 'docs/PROTOCOL.md'], why: 'the plan language or executor changed' },
  { match: /^src\/lease\//, needs: ['docs/LEASE.md'], why: 'the lease protocol changed' },
  { match: /^src\/compat\//, needs: ['docs/COMPATIBILITY.md', 'docs/BASELINE.md'], why: 'the capability baseline changed' },
  { match: /^src\/desktop\//, needs: ['docs/DESKTOP.md'], why: 'the agent desktop changed' },
  { match: /^src\/inject\//, needs: ['docs/LEASE.md', 'docs/PLAN.md'], why: 'the injection helper changed' },
  { match: /^plugins\/dsh-hyprscope\//, needs: ['docs/DSH-PLUGIN.md', skillPath], why: 'the DSH plugin changed' },
  { match: /^(tools\/|probe\/)/, needs: ['AGENTS.md', skillPath], why: 'a C helper or the Wayland probe changed' },
  { match: /^package\.json$/, needs: ['AGENTS.md', skillPath], why: 'the scripts changed' },
];
const reminded = new Set<string>();
for (const path of changed) {
  for (const rule of rules) {
    if (!rule.match.test(path)) continue;
    for (const needed of rule.needs) {
      if (touchedDoc(needed)) continue;
      const key = needed + ' <- ' + path;
      if (reminded.has(key)) continue;
      reminded.add(key);
      warn(needed + ': not touched although ' + path + ' changed (' + rule.why + '); update it if the behavior or instructions changed');
    }
  }
}

// 8. docs/INDEX.md indexes every in-scope document and nothing stale.
const indexEn = read('docs/INDEX.md');
const indexZh = read('docs/INDEX.zh.md');
const markdownLinks = (text: string) => [...text.matchAll(/\]\((\/[^)]*\.md)\)/g)].map((match) => match[1]);
const enLinks = markdownLinks(indexEn);
const zhLinks = markdownLinks(indexZh);
const indexedStems = pairStems.filter((stem) => stem !== 'docs/INDEX');
for (const stem of indexedStems) {
  const enTarget = '/' + stem + '.md';
  const zhTarget = '/' + stem + '.zh.md';
  if (!enLinks.includes(enTarget)) fail('docs/INDEX.md: no reading-order entry for ' + enTarget + ' (index every document)');
  if (!zhLinks.includes(zhTarget)) fail('docs/INDEX.zh.md: missing the Chinese link for ' + enTarget + ' (keep both sides in sync)');
}
const seenLinks = new Set<string>();
for (const link of enLinks) {
  if (seenLinks.has(link)) warn('docs/INDEX.md: lists ' + link + ' more than once');
  seenLinks.add(link);
  if (link === '/docs/INDEX.zh.md') continue;
  if (link.endsWith('.zh.md')) {
    fail('docs/INDEX.md: links to ' + link + '; the English side links the English document');
    continue;
  }
  if (link === '/docs/INDEX.md') continue;
  if (link !== '/README.md' && !link.startsWith('/docs/')) continue;
  if (!exists(link.slice(1))) fail('docs/INDEX.md: links to ' + link + ' but that document does not exist');
}
const indexCodePath = new RegExp(helperArg + '([^' + helperArg + '\\n]+)' + helperArg, 'g');
let indexMatch: RegExpExecArray | null;
while ((indexMatch = indexCodePath.exec(indexEn))) {
  const token = indexMatch[1].trim();
  if (!token.startsWith('src/') && !token.startsWith('plugins/')) continue;
  if (!exists(token)) fail('docs/INDEX.md: the contract-to-code map names ' + token + ' but that path does not exist');
}

// Report.
for (const failure of failures) process.stdout.write('FAIL ' + failure + '\n');
for (const warning of warnings) process.stdout.write('WARN ' + warning + '\n');
process.stdout.write('\nconsistency: ' + failures.length + ' failure(s), ' + warnings.length + ' reminder(s)\n');
process.stdout.write('Not checked automatically: document accuracy and translation quality, runtime CLI behavior, hook behavior outside this repository.\n');
process.exit(failures.length > 0 ? 1 : 0);
