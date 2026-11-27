import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VerifyError } from '../errors.js';
import { PACKAGE_NAME } from '../version.js';

export const SKILL_NAME = 'revyl-verify';
export const SKILL_DIRECTORIES = ['.agents/skills', '.claude/skills'];

const BLOCK_START = `<!-- verify:start (written by npx ${PACKAGE_NAME} init; re-running init updates this section) -->`;
const BLOCK_PATTERN = /<!-- verify:start[^\n]*-->[\s\S]*?<!-- verify:end -->/;

export interface AgentSetupOptions {
  instructions?: boolean;
  skill?: boolean;
}

export interface AgentSetupResult {
  written: string[];
  unchanged: string[];
}

export async function setUpAgents(cwd: string, options: AgentSetupOptions = {}): Promise<AgentSetupResult> {
  const root = repositoryRoot(cwd);
  const result: AgentSetupResult = { written: [], unchanged: [] };
  const record = async (path: string, content: string) => {
    const absolute = join(root, path);
    if (existsSync(absolute) && (await readFile(absolute, 'utf8')) === content) {
      result.unchanged.push(path);
      return;
    }
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    result.written.push(path);
  };
  if (options.skill !== false) {
    const skill = await readFile(skillSource(), 'utf8');
    for (const directory of SKILL_DIRECTORIES) await record(`${directory}/${SKILL_NAME}/SKILL.md`, skill);
  }
  if (options.instructions !== false) {
    const file = instructionsFile(root);
    const current = existsSync(join(root, file)) ? await readFile(join(root, file), 'utf8') : '';
    const block = instructionsBlock(relative(root, cwd).split(sep).join('/'), ['verify.config.ts', 'verify/example.mts'].map((file) => existsSync(join(cwd, file))));
    await record(
      file,
      BLOCK_PATTERN.test(current)
        ? current.replace(BLOCK_PATTERN, block)
        : `${current}${current === '' ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'}${block}\n`,
    );
  }
  return result;
}

function repositoryRoot(cwd: string): string {
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) return directory;
    if (dirname(directory) === directory) return cwd;
  }
}

function instructionsFile(root: string): string {
  if (existsSync(join(root, 'AGENTS.md'))) return 'AGENTS.md';
  for (const file of ['CLAUDE.md', join('.claude', 'CLAUDE.md')]) if (existsSync(join(root, file))) return file;
  return 'AGENTS.md';
}

function skillSource(): string {
  const candidates = ['../../skills', '../../../../skills'].map((path) => fileURLToPath(new URL(`${path}/${SKILL_NAME}/SKILL.md`, import.meta.url)));
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new VerifyError('CONFIG_INVALID', `The ${SKILL_NAME} skill is missing from this ${PACKAGE_NAME} install. Reinstall ${PACKAGE_NAME}, or re-run init with --no-skill.`);
  return found;
}

function instructionsBlock(projectPath: string, [hasConfig, hasExample]: boolean[]): string {
  const at = (file: string) => `\`${projectPath ? `${projectPath}/` : ''}${file}\``;
  return [
    BLOCK_START,
    '## Checking changes with Verify',
    '',
    `To check that a web page, an iOS or Android app, or a Mac works the way it should, write and run a short Verify script instead of only reading code or fetching HTML. Verify opens a Revyl cloud browser, iOS simulator, Android emulator or Mac computer, does the steps you describe in plain sentences, and checks what is on screen.`,
    '',
    `- Read the \`${SKILL_NAME}\` skill (\`.agents/skills/${SKILL_NAME}/SKILL.md\`) before you write one: it shows the setup, a script for each platform, and what each error means.`,
    ...(hasConfig ? [`- The targets and their Revyl app ids are in ${at('verify.config.ts')}.${hasExample ? ` ${at('verify/example.mts')} is a script that runs as written: \`node verify/example.mts\`${projectPath ? ` from \`${projectPath}/\`` : ''}.` : ''}`] : []),
    '- Each session is billed. When the user asks you to check something, that is the go-ahead for the sessions the check needs; otherwise ask first. Always close the session, and share its link with the user.',
    '<!-- verify:end -->',
  ].join('\n');
}
