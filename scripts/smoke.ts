import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type Scenario = { operation: 'generate' | 'edit' | 'deny' | 'cancel' | 'probe'; requests: ObjectValue[] };

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = process.argv.slice(2);
const mode = arguments_.includes('--api') ? 'api' : 'chatgpt';
const directories = arguments_.filter(argument => argument !== '--api');
if (directories.length > 1 || directories.some(argument => argument.startsWith('--'))) throw new Error('Usage: smoke.ts [--api] [pluginDirectory]');
const pluginDirectory = directories[0] ? resolve(directories[0]) : repository;
const toolName = mode === 'api' ? 'openai_image' : 'chatgpt_image';
const executable = process.env.OPENCODE_BIN ?? (process.platform === 'win32'
  ? join(dirname(process.execPath), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe')
  : 'opencode');
const tempBase = join(tmpdir(), 'opencode');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
await mkdir(tempBase, { recursive: true });
const root = await mkdtemp(join(tempBase, 'image-synthetic-smoke-'));
const workspace = join(root, 'workspace');
const configPath = join(root, 'config', 'opencode.json');
const password = `synthetic-${randomUUID()}`;
const token = `synthetic-${randomUUID()}`;
const account = `synthetic-${randomUUID()}`;
const providerID = 'image-smoke-fixture';
const deadline = AbortSignal.timeout(90_000);
const scenarios = new Map<string, Scenario>();
const events: ObjectValue[] = [];
let fixtureError: string | undefined;
let stage = 'prepare';
let hostOutput = '';
let host: ReturnType<typeof spawn> | undefined;
let hostURL = '';
let passed = false;

class SmokeError extends Error {}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new SmokeError(message);
}

function object(value: Json | undefined): ObjectValue {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected an API object.');
  return value;
}

function array(value: Json | undefined): Json[] {
  check(Array.isArray(value), 'Expected an API array.');
  return value;
}

function imageURLs(value: Json): string[] {
  if (Array.isArray(value)) return value.flatMap(imageURLs);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => key === 'url' && typeof item === 'string' && item.startsWith('data:image/') ? [item] : imageURLs(item));
}

async function body(request: IncomingMessage): Promise<ObjectValue> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    check(length <= 4 * 1024 * 1024, 'Synthetic provider request too large.');
    chunks.push(chunk);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString()) as Json);
}

function stream(response: ServerResponse, delta: ObjectValue, finish: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const envelope = { id: `fixture-${randomUUID()}`, object: 'chat.completion.chunk', created: 1, model: 'synthetic' };
  response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

const provider = createServer((request, response) => {
  void (async () => {
    check(request.method === 'POST', 'Unexpected fixture HTTP method.');
    const payload = await body(request);
    if (request.url === '/image-event') {
      check(events.length < 10, 'Too many synthetic backend events.');
      events.push(payload);
      response.writeHead(204).end();
      return;
    }
    check(request.url === '/v1/chat/completions', 'Unexpected synthetic provider path.');
    const scenario = scenarios.get(String(request.headers['x-fixture-session']));
    check(scenario, 'Unexpected synthetic model session.');
    scenario.requests.push(payload);
    check(scenario.requests.length <= 2, 'Unexpected additional synthetic model request.');
    check(!JSON.stringify(payload.tools).includes(token), 'Image tool schema exposed the synthetic credential.');
    if (scenario.operation === 'probe') {
      stream(response, { role: 'assistant', content: 'Synthetic tool inventory probe completed.' }, 'stop');
      return;
    }
    const imageTools = registeredImageTools(payload);
    check(imageTools.length === 1 && imageTools[0] === toolName, 'Image tool registration was not exclusive to the selected mode.');
    if (scenario.requests.length === 1) {
      const args = {
        prompt: scenario.operation === 'cancel' ? 'synthetic cancellation' : 'synthetic image',
        output_path: `${scenario.operation}.png`,
        ...(scenario.operation === 'edit' ? { reference_images: ['generate.png'], background: 'transparent' } : {}),
      };
      stream(response, {
        role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
      }, 'tool_calls');
      return;
    }
    stream(response, { role: 'assistant', content: 'Synthetic fixture completed.' }, 'stop');
  })().catch(() => {
    fixtureError = 'Synthetic provider rejected an unexpected request.';
    response.writeHead(500).end('Synthetic fixture contract failed.');
  });
});

async function api(path: string, method = 'GET', payload?: Json): Promise<Json> {
  const response = await fetch(`${hostURL}${path}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.any([deadline, AbortSignal.timeout(45_000)]),
    redirect: 'error',
  });
  check(response.ok, `Private host API failed (${response.status}) during ${stage}.`);
  if (response.status === 204) return null;
  return response.json() as Promise<Json>;
}

async function eventually(condition: () => boolean | Promise<boolean>, message: string, milliseconds = 30_000): Promise<void> {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    deadline.throwIfAborted();
    check(!fixtureError, fixtureError ?? 'Fixture failed.');
    check(!host || host.exitCode === null, 'Private host exited unexpectedly.');
    if (await condition()) return;
    await delay(100);
  }
  throw new SmokeError(message);
}

async function context(sessionID: string): Promise<ObjectValue[]> {
  return array(object(await api(`/api/session/${sessionID}/context`)).data).map(object);
}

function registeredImageTools(payload: ObjectValue): Json[] {
  return array(payload.tools).map(tool => object(object(tool).function).name ?? null).filter(name => name === 'chatgpt_image' || name === 'openai_image');
}

function imageTool(messages: ObjectValue[]): ObjectValue {
  const tools = messages.filter(message => message.type === 'assistant').flatMap(message => array(message.content)).map(object);
  const tool = tools.findLast(part => part.type === 'tool' && part.name === toolName);
  check(tool, 'No production image tool invocation was stored.');
  return object(tool.state);
}

async function runScenario(sessionID: string, operation: Scenario['operation']): Promise<Scenario> {
  const scenario: Scenario = { operation, requests: [] };
  scenarios.set(sessionID, scenario);
  await api(`/api/session/${sessionID}/prompt`, 'POST', { text: `Synthetic ${operation} fixture.` });
  if (operation === 'cancel') {
    await eventually(() => events.filter(event => event.operation === 'generate').length === 2, 'Synthetic cancellation did not reach the image body.');
    await api(`/api/session/${sessionID}/interrupt`, 'POST', { resume: false });
  }
  await api(`/api/experimental/session/${sessionID}/wait`, 'POST');
  check(!fixtureError, fixtureError ?? 'Synthetic provider failed.');
  return scenario;
}

async function createSession(deny = false): Promise<string> {
  const response = object(await api('/api/session', 'POST', {
    title: 'Synthetic image fixture', location: { directory: workspace }, model: { providerID, id: 'synthetic' },
    ...(deny ? { permissions: [{ action: 'edit', resource: '*', effect: 'deny' }] } : {}),
  }));
  const id = object(response.data).id;
  check(typeof id === 'string' && id.startsWith('ses'), 'Private host did not create a session.');
  return id;
}

try {
  await Promise.all(['workspace', 'home', 'config', 'data', 'state', 'cache', 'temp', 'programdata', 'appdata', 'localappdata'].map(name => mkdir(join(root, name))));
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  check(address && typeof address === 'object', 'Synthetic provider did not listen.');
  const origin = `http://127.0.0.1:${address.port}`;
  const config = {
    $schema: 'https://opencode.ai/config.json',
    plugins: [
      '-opencode.provider.ollama', '-opencode.provider.lmstudio', '-opencode.provider.vllm',
      { package: pathToFileURL(join(repository, 'tests/fixtures/network')).href, options: { origin, token, account, mode } },
      { package: pathToFileURL(pluginDirectory).href, options: { ...(mode === 'api' ? { mode } : {}), apiKey: token } },
    ],
    model: `${providerID}/synthetic`,
    providers: {
      [providerID]: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `${origin}/v1`, apiKey: 'synthetic-model-key', encoding: 'none', transport: 'http' },
        models: { synthetic: { capabilities: { tools: true, input: ['text', 'image'], output: ['text'] }, limit: { context: 100_000, output: 4096 } } },
      },
    },
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: providerID, effect: 'allow' }],
    permissions: [{ action: '*', resource: '*', effect: 'deny' }, ...['chatgpt_image', 'openai_image', 'read', 'edit'].map(action => ({ action, resource: '*', effect: 'allow' }))],
    snapshots: false, formatter: false, compaction: { auto: false }, warming: false,
  };
  await writeFile(configPath, JSON.stringify(config));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), OPENCODE_TEST_HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), ProgramData: join(root, 'programdata'),
    TEMP: join(root, 'temp'), TMP: join(root, 'temp'), TMPDIR: join(root, 'temp'),
    OPENCODE_CONFIG_DIR: join(root, 'config'),
    OPENCODE_CONFIG_PROJECT_DISABLE: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_FFF: 'true', OPENCODE_PASSWORD: password,
    OPENCODE_LOG_LEVEL: 'ERROR',
    OPENCODE_DB: join(root, 'data', 'smoke.db'),
  });
  stage = 'private host startup';
  host = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  host.on('error', () => { fixtureError = 'Could not start OpenCode. Set OPENCODE_BIN to the installed 2.1.4 executable.'; });
  const capture = (chunk: Buffer) => {
    hostOutput = (hostOutput + chunk.toString()).slice(-128 * 1024);
    hostURL ||= hostOutput.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? '';
  };
  host.stdout?.on('data', capture);
  host.stderr?.on('data', capture);
  await eventually(() => Boolean(hostURL), 'Private host startup timed out.');
  stage = 'host version';
  const info = object(await api('/api/info'));
  check(info.version === '2.1.4', 'Smoke harness requires installed OpenCode 2.1.4.');
  check(info.pid === host.pid, 'Private host identity does not match the owned process.');
  const temporary = object(info.paths).tmp;
  check(typeof temporary === 'string' && resolve(temporary).startsWith(root + sep), 'Private host temporary directory was not isolated.');
  stage = 'production plugin loading';
  let plugins: ObjectValue[] = [];
  await eventually(async () => {
    plugins = array(object(await api('/api/plugin')).data).map(object);
    return plugins.some(plugin => plugin.id === 'opencode-chatgpt-image') || plugins.some(plugin => object(plugin.state).status === 'failed');
  }, 'Production plugin inventory did not become ready.');
  check(plugins.some(plugin => plugin.id === 'synthetic-image-network' && object(plugin.state).status === 'active'), 'Synthetic network guard did not load.');
  check(plugins.some(plugin => plugin.id === 'opencode-chatgpt-image' && object(plugin.state).status === 'active'), 'Production plugin did not load.');
  check(plugins.every(plugin => object(plugin.source).type === 'builtin' || ['synthetic-image-network', 'opencode-chatgpt-image'].includes(String(plugin.id))), 'Unexpected external plugin loaded in the private host.');
  const models = array(object(await api('/api/model')).data).map(object);
  check(models.length === 1 && models[0]?.providerID === providerID && models[0]?.id === 'synthetic', 'Private host did not isolate the synthetic model provider.');
  if (mode === 'chatgpt') {
    stage = 'synthetic OAuth fixture';
    const credential = object(object(await api('/api/credential', 'POST', {
      integrationID: 'openai', label: 'Synthetic smoke only', activate: false,
      value: { type: 'oauth', methodID: 'chatgpt-browser', access: token, refresh: 'synthetic-no-refresh', expires: Date.now() + 365 * 86400_000, metadata: { accountID: account } },
    })).data);
    check(typeof credential.id === 'string', 'Synthetic credential was not created.');
    await api(`/api/credential/${credential.id}/activate`, 'POST');
  } else {
    stage = 'API-only credential isolation';
    check(array(object(await api('/api/credential')).data).length === 0, 'API smoke must not have saved OAuth or API credentials.');
  }
  const session = await createSession();
  for (const operation of ['generate', 'edit'] as const) {
    stage = `synthetic ${operation}`;
    const scenario = await runScenario(session, operation);
    check(scenario.requests.length === 2, 'Expected one tool request and one continuation.');
    const state = imageTool(await context(session));
    check(state.status === 'completed', 'Production image tool did not complete.');
    check((await readFile(join(workspace, `${operation}.png`))).equals(png), 'Production output does not match the synthetic PNG.');
    const file = array(state.content).map(object).find(item => item.type === 'file');
    check(file && typeof file.uri === 'string' && file.uri.startsWith('data:image/'), 'Image attachment did not survive host normalization.');
    check(imageURLs(scenario.requests[1]!).includes(file.uri), 'Normalized image did not reach the immediate next model request.');
    if (mode === 'chatgpt') check(object(state.metadata).effective_model === null, 'Production result claimed an effective model.');
    else check(object(state.metadata).requested_model === 'gpt-image-2.5-sunburst', 'API default model was not preserved.');
    check(!JSON.stringify(state).includes(token), 'Production result exposed the synthetic credential.');
  }
  check(events.length === 2 && events[0]?.operation === 'generate' && events[1]?.operation === 'edit'
    && events[1]?.references === 1 && events[1]?.background === 'transparent', 'Generation/edit backend dispatch contract failed.');
  stage = 'permission denial';
  const denied = await createSession(true);
  await runScenario(denied, 'deny');
  check(imageTool(await context(denied)).status === 'error', 'Permission denial was not recorded as a tool error.');
  check(events.length === 2, 'Permission denial reached the image backend.');
  await readFile(join(workspace, 'deny.png')).then(() => { throw new Error('Denied image was written.'); }, () => {});
  stage = 'cancellation';
  const cancelled = await createSession();
  await runScenario(cancelled, 'cancel');
  await eventually(() => events.some(event => event.operation === 'cancelled'), 'Cancellation did not stop the response stream.');
  await readFile(join(workspace, 'cancel.png')).then(() => { throw new Error('Cancelled image was written.'); }, () => {});
  const backendEvents = events.length;
  const pluginIndex = config.plugins.length - 1;
  for (const [label, options, expected] of [
    ['missing API key', { mode: 'api' }, []],
    ['corrected API key', { mode: 'api', apiKey: token }, ['openai_image']],
    ['explicit ChatGPT', { mode: 'chatgpt', apiKey: token }, ['chatgpt_image']],
    ['missing API key after ChatGPT', { mode: 'api' }, []],
    ['corrected API key after ChatGPT', { mode: 'api', apiKey: token }, ['openai_image']],
  ] as const) {
    stage = `watched configuration reload: ${label}`;
    const updated = { ...config, plugins: config.plugins.map((entry, index) => index === pluginIndex ? { package: pathToFileURL(pluginDirectory).href, options } : entry) };
    await writeFile(configPath, JSON.stringify(updated));
    let probes = 0;
    await eventually(async () => {
      check(++probes <= 30, 'Watched config reload exceeded the bounded probe count.');
      const probe = await runScenario(await createSession(), 'probe');
      check(probe.requests.length === 1, 'Tool inventory probe made unexpected model requests.');
      return JSON.stringify(registeredImageTools(probe.requests[0]!)) === JSON.stringify(expected);
    }, `Watched config reload did not yield the expected exclusive tool inventory: ${label}.`);
    await delay(250, undefined, { signal: deadline });
    const confirmation = await runScenario(await createSession(), 'probe');
    check(confirmation.requests.length === 1 && JSON.stringify(registeredImageTools(confirmation.requests[0]!)) === JSON.stringify(expected), 'Reloaded tool inventory did not remain stable; a previous plugin generation may have been restored.');
    const currentPlugins = array(object(await api('/api/plugin')).data).map(object);
    check(currentPlugins.some(plugin => plugin.id === 'opencode-chatgpt-image' && object(plugin.state).status === 'active'), 'Reloaded plugin did not activate successfully; stale-generation fallback may have occurred.');
    check(events.length === backendEvents, 'Tool inventory reload probes dispatched an image request.');
  }
  if (mode === 'api') check(array(object(await api('/api/credential')).data).length === 0, 'API/reload smoke unexpectedly saved credentials.');
  check(!fixtureError, 'Synthetic fixture failed.');
  passed = true;
} catch (error) {
  const dispatches = events.filter(event => event.operation === 'generate' || event.operation === 'edit').length;
  console.error(`SYNTHETIC ONLY — smoke failed during ${stage}.${error instanceof SmokeError ? ` ${error.message}` : ''} Synthetic backend dispatches: ${dispatches}.`);
  process.exitCode = 1;
} finally {
  stage = 'cleanup';
  if (host && host.exitCode === null && host.signalCode === null) {
    const exited = once(host, 'exit');
    const cleanupTimeout = new AbortController();
    host.kill();
    try {
      await Promise.race([exited, delay(10_000, undefined, { signal: cleanupTimeout.signal }).then(() => { throw new Error('Owned private host did not exit.'); })]);
    } finally {
      cleanupTimeout.abort();
    }
  }
  provider.closeAllConnections();
  if (provider.listening) await new Promise<void>((done, reject) => provider.close(error => error ? reject(error) : done()));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (passed) console.log(`SYNTHETIC ONLY — OpenCode 2.1.4 (${mode}): only ${toolName} initially registered; generation/edit passed; normalized images reached continuation; denial blocked dispatch; cancellation stopped the response; watched reloads removed both tools on invalid API config and restored exclusive API/ChatGPT tools on correction; ${mode === 'api' ? 'no saved OAuth; ' : ''}owned host and temporary state cleaned up.`);
