import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert(process.argv.length <= 3 && !process.argv[2]?.startsWith('--'), 'Usage: node scripts/tui-smoke.mjs [pluginDirectory]');
const pluginDirectory = resolve(process.argv[2] ?? repository);
const modules = process.env.OPENCODE_TUI_TEST_MODULES;
assert(modules, 'Set OPENCODE_TUI_TEST_MODULES to an existing node_modules directory containing @lydell/node-pty and @xterm/headless. This harness does not install dependencies.');
const require = createRequire(join(resolve(modules), '__image_tui_smoke__.cjs'));
const pty = require('@lydell/node-pty');
const { Terminal } = require('@xterm/headless');
const executable = process.env.OPENCODE_BIN ?? (process.platform === 'win32'
  ? join(dirname(process.execPath), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
  : 'opencode');
const tempBase = join(tmpdir(), 'opencode');
await mkdir(tempBase, { recursive: true });
const root = await mkdtemp(join(tempBase, 'image-tui-smoke-'));
const workspace = join(root, 'workspace');
const password = `synthetic-${randomUUID()}`;
const token = `synthetic-${randomUUID()}`;
const providerID = 'image-smoke-fixture';
const statusType = 'rpc.opencode-chatgpt-image.toggle.status';
const statuses = [];
const screenshots = [];
const eventAbort = new AbortController();
const deadline = AbortSignal.timeout(120_000);
let stage = 'prepare';
let host;
let hostURL = '';
let hostOutput = '';
let eventTask;
let eventConnected = false;
let failure;
let requests = 0;
let terminal;
let child;
let exited;
let exitCode;
let rendered = Promise.resolve();
let recording = '';
let passed = false;

const provider = createServer((request, response) => {
  requests++;
  failure = `Unexpected synthetic network request: ${request.method} ${request.url}`;
  request.resume();
  response.writeHead(500).end('No model or image requests are allowed in the palette test.');
});

async function until(condition, message, timeout = 25_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    deadline.throwIfAborted();
    assert(!failure, failure);
    assert(!host || host.exitCode === null, 'Owned host exited unexpectedly.');
    assert(exitCode === undefined, 'Owned TUI exited unexpectedly.');
    if (await condition()) return;
    await delay(100);
  }
  throw new Error(message);
}

async function bounded(promise, message, timeout = 12_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeout);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function api(path, method = 'GET', body) {
  const response = await fetch(`${hostURL}${path}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
    redirect: 'error',
  });
  assert(response.ok, `Private API ${path} failed (${response.status}).`);
  return response.status === 204 ? null : response.json();
}

async function subscribe() {
  try {
    const response = await fetch(`${hostURL}/api/event?types=${encodeURIComponent(statusType)}`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
      signal: AbortSignal.any([eventAbort.signal, deadline]), redirect: 'error',
    });
    assert(response.ok && response.body, 'Status event subscription failed.');
    let buffered = '';
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffered += chunk;
      assert(buffered.length < 1024 * 1024, 'Status stream exceeded its bound.');
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end).trimEnd();
        buffered = buffered.slice(end + 1);
        if (!line.startsWith('data:')) continue;
        const event = JSON.parse(line.slice(5).trim());
        if (event.type === 'server.connected') eventConnected = true;
        if (event.type === statusType) statuses.push(event);
      }
    }
    if (!eventAbort.signal.aborted) failure = 'Status stream ended unexpectedly.';
  } catch (error) {
    if (!eventAbort.signal.aborted) failure = error.message;
  }
}

async function screen() {
  await rendered;
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').join('\n');
}

async function seen(text) {
  await until(async () => (await screen()).includes(text), `TUI did not display: ${text}`);
}

function keys(value) {
  assert(exitCode === undefined, 'Owned TUI exited before input.');
  child.write(value);
}

async function palette(title) {
  keys('\x10');
  await seen('Commands');
  keys(title);
  await until(async () => {
    const text = await screen();
    return text.includes('Images') && text.split(title).length >= 3;
  }, `Palette action was not ready: ${title}`);
  screenshots.push({ stage: `${title}: palette`, screen: await screen() });
}

try {
  await Promise.all(['workspace', 'home', 'config', 'data', 'state', 'cache', 'temp', 'programdata', 'appdata', 'localappdata'].map(name => mkdir(join(root, name))));
  const manifest = JSON.parse(await readFile(join(repository, 'node_modules', '@opencode', 'plugin', 'package.json'), 'utf8'));
  assert.equal(manifest.version, '2.2.5', 'Harness baseline requires @opencode/plugin 2.2.5.');
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const origin = `http://127.0.0.1:${provider.address().port}`;
  const configPath = join(root, 'config', 'opencode.json');
  const config = {
    $schema: 'https://opencode.ai/config.json',
    plugins: [
      '-opencode.provider.ollama', '-opencode.provider.lmstudio', '-opencode.provider.vllm',
      { package: pathToFileURL(join(repository, 'tests/fixtures/network')).href, options: { origin, token, account: 'synthetic-unused', mode: 'api' } },
    ],
    model: `${providerID}/synthetic`,
    providers: {
      [providerID]: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `${origin}/v1`, apiKey: 'synthetic-model-key', encoding: 'none', transport: 'http' },
        models: { synthetic: { capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 100_000, output: 4096 } } },
      },
    },
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: providerID, effect: 'allow' }],
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    snapshots: false, formatter: false, compaction: { auto: false }, warming: false,
  };
  await writeFile(configPath, JSON.stringify(config));
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), OPENCODE_TEST_HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), ProgramData: join(root, 'programdata'),
    TEMP: join(root, 'temp'), TMP: join(root, 'temp'), TMPDIR: join(root, 'temp'),
    OPENCODE_CONFIG_DIR: join(root, 'config'), OPENCODE_CONFIG_PROJECT_DISABLE: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_FFF: 'true',
    OPENCODE_PASSWORD: password, OPENCODE_LOG_LEVEL: 'ERROR', OPENCODE_DB: join(root, 'data', 'smoke.db'),
    LANG: 'C.UTF-8', TERM: 'xterm-256color',
  });
  stage = 'private host startup';
  host = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  host.on('error', error => { failure = error.message; });
  const capture = chunk => {
    hostOutput = (hostOutput + chunk.toString()).slice(-128 * 1024);
    hostURL ||= hostOutput.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? '';
  };
  host.stdout.on('data', capture);
  host.stderr.on('data', capture);
  await until(() => hostURL, 'Private host startup timed out.');
  const info = await api('/api/info');
  assert.equal(info.version, '2.2.5');
  assert.equal(info.pid, host.pid);
  assert(resolve(info.paths.tmp).startsWith(root + sep), 'Host temporary path is not isolated.');
  stage = 'synthetic network guard';
  await until(async () => (await api('/api/plugin')).data.some(plugin => plugin.id === 'synthetic-image-network' && plugin.state.status === 'active'), 'Synthetic guard did not load.');
  await writeFile(configPath, JSON.stringify({ ...config, plugins: [...config.plugins, { package: pathToFileURL(pluginDirectory).href, options: { mode: 'api', apiKey: token, enabledByDefault: false } }] }));
  stage = 'production plugin loading';
  await until(async () => (await api('/api/plugin')).data.some(plugin => plugin.id === 'opencode-chatgpt-image' && plugin.state.status === 'active' && plugin.features.tui), 'Production TUI companion was not discovered.');
  const plugins = (await api('/api/plugin')).data;
  assert(plugins.every(plugin => plugin.source.type === 'builtin' || ['synthetic-image-network', 'opencode-chatgpt-image'].includes(plugin.id)), 'Unexpected external plugin loaded.');
  const models = (await api('/api/model?types=chat&types=image')).data;
  assert.equal(models.length, 1);
  assert.equal(models[0].providerID, providerID);
  assert.equal((await api('/api/credential')).data.length, 0);
  eventTask = subscribe();
  await until(() => eventConnected, 'Status subscription was not ready.');
  const session = (await api('/api/session', 'POST', {
    title: 'Synthetic palette draft test', location: { directory: workspace }, model: { providerID, id: 'synthetic' },
  })).data.id;
  const history = JSON.stringify(await api(`/api/session/${session}/context`));
  const inbox = JSON.stringify(await api(`/api/session/${session}/inbox`));
  stage = 'actual TUI startup';
  terminal = new Terminal({ cols: 120, rows: 36, allowProposedApi: true, scrollback: 0 });
  child = pty.spawn(executable, ['--server', hostURL, '--session', session, workspace], { cols: 120, rows: 36, cwd: workspace, env, name: 'xterm-256color' });
  exited = new Promise(done => child.onExit(event => { exitCode = event.exitCode; done(event.exitCode); }));
  terminal.onData(value => { if (exitCode === undefined) child.write(value); });
  child.onData(value => {
    recording += value;
    rendered = rendered.then(() => new Promise(done => terminal.write(value, done)));
  });
  await seen('Synthetic palette draft test');
  stage = 'palette registration readiness';
  await palette('Enable image tools');
  keys('\x1b');
  await until(async () => !(await screen()).includes('Commands'), 'Palette did not close.');
  const draft = 'IMAGE_DRAFT_SENTINEL_8a27 Keep this drafted prompt unsent.';
  keys(draft);
  await seen(draft);
  const draftLine = (await screen()).split('\n').find(line => line.includes(draft));
  screenshots.push({ stage: 'draft before actions', screen: await screen() });
  for (const [title, enabled] of [['Enable image tools', true], ['Image tools status', true], ['Disable image tools', false], ['Image tools status', false]]) {
    stage = title;
    const before = statuses.length;
    await palette(title);
    keys('\r');
    await until(() => statuses.length > before, `${title} emitted no status event.`);
    assert.equal(statuses.length, before + 1, 'Palette action emitted duplicate status events.');
    assert.deepEqual(statuses[before].data, { sessionID: session, enabled, enabledByDefault: false, tool: 'openai_image' });
    assert.equal(resolve(statuses[before].location.directory), workspace);
    await seen(`${enabled ? 'ON' : 'OFF'} (default OFF; openai_image)`);
    await until(async () => !(await screen()).includes('Commands') && (await screen()).split('\n').includes(draftLine), `${title} did not preserve the exact draft row.`);
    screenshots.push({ stage: `${title}: preserved draft`, screen: await screen() });
    assert.equal(JSON.stringify(await api(`/api/session/${session}/context`)), history, 'Palette action changed history.');
    assert.equal(JSON.stringify(await api(`/api/session/${session}/inbox`)), inbox, 'Palette action queued a prompt.');
    assert.equal(requests, 0, 'Palette action made a model/image request.');
  }
  stage = 'draft remains editable without submission';
  keys(' STILL_UNSENT');
  await seen(`${draft} STILL_UNSENT`);
  screenshots.push({ stage, screen: await screen() });
  assert.equal(JSON.stringify(await api(`/api/session/${session}/context`)), history);
  assert.equal(JSON.stringify(await api(`/api/session/${session}/inbox`)), inbox);
  assert.equal((await api('/api/credential')).data.length, 0);
  assert.equal(statuses.length, 4);
  assert.equal(requests, 0);
  assert(!failure, failure);
  passed = true;
} catch (error) {
  console.error(`SYNTHETIC ONLY — TUI smoke failed during ${stage}: ${error.message}`);
  process.exitCode = 1;
} finally {
  const cleanup = async task => {
    try {
      await task();
    } catch (error) {
      passed = false;
      process.exitCode = 1;
      console.error(`TUI smoke cleanup failed: ${error.message}`);
    }
  };
  if (terminal) await cleanup(async () => screenshots.push({ stage: 'before cleanup', screen: await bounded(screen(), 'Final screen decoding timed out.') }));
  eventAbort.abort();
  await cleanup(() => bounded(eventTask, 'Status subscription did not close.'));
  if (child) await cleanup(async () => {
    if (exitCode === undefined) child.write('\x03\x03');
    const timer = setTimeout(() => child.kill(), 8000);
    try {
      const code = await bounded(exited, 'Owned TUI did not exit.');
      if (passed && code !== 0) throw new Error(`Owned TUI did not exit cleanly (${code}).`);
      await bounded(rendered, 'Terminal decoding did not finish.');
    } finally {
      clearTimeout(timer);
      terminal.dispose();
      child.kill();
    }
  });
  if (host && host.exitCode === null && host.signalCode === null) await cleanup(async () => {
    const closed = once(host, 'exit');
    host.kill();
    await bounded(closed, 'Owned host did not exit.');
  });
  provider.closeAllConnections();
  if (provider.listening) await cleanup(() => bounded(new Promise((done, reject) => provider.close(error => error ? reject(error) : done())), 'Synthetic network guard did not close.'));
  const artifacts = join(repository, 'output', 'tui-smoke');
  await cleanup(async () => {
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'terminal.log'), recording);
    await writeFile(join(artifacts, 'screens.json'), JSON.stringify(screenshots, null, 2));
    await writeFile(join(artifacts, 'host.log'), hostOutput);
  });
  await cleanup(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
}

if (passed) console.log('SYNTHETIC ONLY — actual OpenCode 2.2.5 TUI: Ctrl+P Enable, Status, Disable, Status preserve the drafted prompt; exact session-scoped OFF/ON status and visible feedback verified; draft remains editable; zero model/image requests, history/inbox changes or saved credentials; owned TUI/host and temporary state cleaned up. Screens and raw VT: output/tui-smoke/.');
