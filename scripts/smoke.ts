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
type Scenario = {
  operation: 'generate' | 'edit' | 'deny' | 'deny-model' | 'cancel' | 'probe' | 'catalog-reload' | 'forged' | 'stale' | 'inflight';
  requests: ObjectValue[];
  release?: () => void;
};

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = process.argv.slice(2);
const mode = arguments_.includes('--api') ? 'api' : 'chatgpt';
const directories = arguments_.filter(argument => argument !== '--api');
if (directories.length > 1 || directories.some(argument => argument.startsWith('--'))) throw new Error('Usage: smoke.ts [--api] [pluginDirectory]');
const pluginDirectory = directories[0] ? resolve(directories[0]) : repository;
const toolName = mode === 'api' ? 'openai_image' : 'chatgpt_image';
const nativeTool = 'experimental_image_generate';
const imageModel = mode === 'api' ? 'gpt-image-2.5-sunburst' : 'gpt-image-2';
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
const deadline = AbortSignal.timeout(120_000);
const scenarios = new Map<string, Scenario>();
const events: ObjectValue[] = [];
const catalogEvents: ObjectValue[] = [];
const statusEvents: ObjectValue[] = [];
const statusType = 'rpc.opencode-chatgpt-image.toggle.status';
const statusOverrides = new Map<string, boolean>();
const eventAbort = new AbortController();
let eventTask: Promise<void> | undefined;
let eventConnected = false;
let defaultEnabled = false;
let selectedTool: string = toolName;
let fixtureError: string | undefined;
let stage = 'prepare';
let hostOutput = '';
let host: ReturnType<typeof spawn> | undefined;
let hostURL = '';
let passed = false;
let suppressionRequired = false;
let modelRequests = 0;
let pendingImage: ServerResponse | undefined;

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
    if (request.method === 'GET' && request.url === '/image-release') {
      check(!pendingImage, 'Unexpected concurrent synthetic image wait.');
      pendingImage = response;
      return;
    }
    check(request.method === 'POST', 'Unexpected fixture HTTP method.');
    const payload = await body(request);
    if (request.url === '/image-event') {
      if (payload.operation === 'catalog-reload') {
        check(catalogEvents.length < 100, 'Too many synthetic catalog reloads.');
        catalogEvents.push(payload);
        response.writeHead(204).end();
        return;
      }
      check(events.length < 10, 'Too many synthetic backend events.');
      events.push(payload);
      response.writeHead(204).end();
      return;
    }
    check(request.url === '/v1/chat/completions', 'Unexpected synthetic provider path.');
    modelRequests++;
    const scenario = scenarios.get(String(request.headers['x-fixture-session']));
    check(scenario, 'Unexpected synthetic model session.');
    scenario.requests.push(payload);
    check(scenario.requests.length <= 2, 'Unexpected additional synthetic model request.');
    check(!JSON.stringify(payload.tools).includes(token), 'Image tool schema exposed the synthetic credential.');
    if (scenario.operation === 'probe' || scenario.operation === 'catalog-reload') {
      stream(response, { role: 'assistant', content: 'Synthetic tool inventory probe completed.' }, 'stop');
      return;
    }
    const imageTools = registeredImageTools(payload);
    const hidden = scenario.operation === 'forged'
      || (['stale', 'inflight'].includes(scenario.operation) && scenario.requests.length > 1);
    check(hidden ? imageTools.length === 0 : imageTools.length === 1 && imageTools[0] === toolName, 'Image tool visibility did not match the session toggle.');
    if (scenario.requests.length === 1) {
      const args = {
        prompt: scenario.operation === 'cancel' ? 'synthetic cancellation' : scenario.operation === 'inflight' ? 'synthetic inflight' : 'synthetic image',
        output_path: `${scenario.operation}.png`,
        ...(scenario.operation === 'edit' ? { reference_images: ['generate.png'], background: 'transparent' } : {}),
      };
      const reply = () => stream(response, {
        role: 'assistant', tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
      }, 'tool_calls');
      if (scenario.operation === 'stale') scenario.release = reply;
      else reply();
      return;
    }
    stream(response, { role: 'assistant', content: 'Synthetic fixture completed.' }, 'stop');
  })().catch(error => {
    fixtureError = error instanceof SmokeError ? error.message : 'Synthetic provider rejected an unexpected request.';
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

async function subscribeStatuses(): Promise<void> {
  try {
    const response = await fetch(`${hostURL}/api/event?types=${encodeURIComponent(statusType)}`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
      signal: AbortSignal.any([eventAbort.signal, deadline]), redirect: 'error',
    });
    check(response.ok && response.body, 'Private host status event subscription failed.');
    let buffered = '';
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffered += chunk;
      check(buffered.length < 1024 * 1024, 'Status event stream exceeded the buffer bound.');
      let end: number;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end).trimEnd();
        buffered = buffered.slice(end + 1);
        if (!line.startsWith('data:')) continue;
        const event = object(JSON.parse(line.slice(5).trim()) as Json);
        if (event.type === 'server.connected') eventConnected = true;
        if (event.type !== statusType) continue;
        check(statusEvents.length < 100, 'Too many image toggle status events.');
        statusEvents.push(event);
      }
    }
    if (!eventAbort.signal.aborted) fixtureError = 'Status event stream ended unexpectedly.';
  } catch (error) {
    if (!eventAbort.signal.aborted) fixtureError = error instanceof SmokeError ? error.message : 'Status event stream failed.';
  }
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
  return array(payload.tools ?? []).map(tool => object(object(tool).function).name ?? null).filter(name => name === 'chatgpt_image' || name === 'openai_image' || name === nativeTool).sort();
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
  const before = events.length;
  await api(`/api/session/${sessionID}/prompt`, 'POST', { text: `Synthetic ${operation} fixture.` });
  if (operation === 'stale') {
    await eventually(() => Boolean(scenario.release), 'Synthetic stale request did not capture the enabled tool schema.');
    await command(sessionID, 'off', false);
    scenario.release!();
  }
  if (operation === 'inflight') {
    await eventually(() => Boolean(pendingImage), 'Synthetic generation did not start its held response.');
    await command(sessionID, 'off', false);
    pendingImage!.writeHead(204).end();
    pendingImage = undefined;
  }
  if (operation === 'cancel') {
    await eventually(() => events.slice(before).some(event => event.operation === 'generate'), 'Synthetic cancellation did not reach the image body.');
    await api(`/api/session/${sessionID}/interrupt`, 'POST', { resume: false });
  }
  await api(`/api/experimental/session/${sessionID}/wait`, 'POST');
  check(!fixtureError, fixtureError ?? 'Synthetic provider failed.');
  return scenario;
}

async function createSession(deny?: 'edit' | 'model', parentID?: string): Promise<string> {
  const response = object(await api('/api/session', 'POST', {
    title: 'Synthetic image fixture', location: { directory: workspace }, model: { providerID, id: 'synthetic' },
    ...(parentID ? { parentID } : {}),
    ...(deny ? { permissions: [{ action: deny === 'edit' ? 'edit' : toolName, resource: deny === 'edit' ? '*' : imageModel, effect: 'deny' }] } : {}),
  }));
  const id = object(response.data).id;
  check(typeof id === 'string' && id.startsWith('ses'), 'Private host did not create a session.');
  return id;
}

async function command(sessionID: string, text: string, idle = true): Promise<void> {
  const before = modelRequests;
  const statusBefore = statusEvents.length;
  const history = idle ? JSON.stringify(await context(sessionID)) : '';
  const inbox = idle ? JSON.stringify(await api(`/api/session/${sessionID}/inbox`)) : '';
  await api(`/api/session/${sessionID}/command`, 'POST', { name: 'images', text });
  await eventually(() => statusEvents.length > statusBefore, 'Images command did not emit a public status event.');
  check(statusEvents.length === statusBefore + 1, 'Images command emitted more than one status event.');
  const event = statusEvents[statusBefore]!;
  const status = object(event.data);
  if (text === 'on' || text === 'off') statusOverrides.set(sessionID, text === 'on');
  check(status.sessionID === sessionID && status.enabled === (statusOverrides.get(sessionID) ?? defaultEnabled)
    && status.enabledByDefault === defaultEnabled && status.tool === selectedTool, 'Images status event did not match the invoking session state.');
  check(resolve(String(object(event.location).directory)) === workspace, 'Images status event was attributed to the wrong location.');
  await delay(100, undefined, { signal: deadline });
  check(modelRequests === before && !fixtureError, 'Images command triggered a provider request.');
  if (idle) {
    check(JSON.stringify(await context(sessionID)) === history, 'Images command modified the session history.');
    check(JSON.stringify(await api(`/api/session/${sessionID}/inbox`)) === inbox, 'Images command queued a model-visible message.');
  }
}

async function inventory(expected: readonly string[], reload = false, sessionID?: string, registered: readonly string[] = expected): Promise<boolean> {
  const before = catalogEvents.length;
  const probe = await runScenario(sessionID ?? await createSession(), reload ? 'catalog-reload' : 'probe');
  check(probe.requests.length === 1, 'Tool inventory probe made unexpected model requests.');
  const wanted = JSON.stringify([...expected].sort());
  const advertised = registeredImageTools(probe.requests[0]!);
  let registryMatches = true;
  if (suppressionRequired) check(!advertised.includes(nativeTool), 'Native image tool returned while the production plugin was configured.');
  if (JSON.stringify(advertised) === wanted) {
    for (const name of expected.filter(name => name === 'chatgpt_image' || name === 'openai_image')) {
      const tool = array(probe.requests[0]!.tools).map(item => object(object(item).function)).find(tool => tool.name === name);
      check(tool && typeof tool.description === 'string' && tool.description.length > 0, 'Enabled image tool lost its description.');
      const schema = object(tool.parameters);
      check(array(schema.required).includes('prompt') && array(schema.required).includes('output_path')
        && object(schema.properties).reference_images, 'Enabled image tool lost its full argument schema.');
    }
  }
  if (reload) {
    check(catalogEvents.length === before + 1, 'Catalog reload fixture did not run exactly once.');
    registryMatches = JSON.stringify(catalogEvents.at(-1)?.tools) === JSON.stringify([...registered].sort());
    check(catalogEvents.at(-1)?.imageModelAvailable === true, 'Native image model was not available after catalog reload.');
  }
  return JSON.stringify(advertised) === wanted && registryMatches;
}

async function waitForInventory(expected: readonly string[], registered: readonly string[] = expected, sessionID?: string): Promise<void> {
  let probes = 0;
  await eventually(async () => {
    check(++probes <= 30, 'Watched config reload exceeded the bounded probe count.');
    return await inventory(expected, false, sessionID) && await inventory(expected, true, sessionID, registered);
  }, 'Watched configuration did not yield the expected image tool inventory.');
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
    ],
    model: `${providerID}/synthetic`,
    providers: {
      [providerID]: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `${origin}/v1`, apiKey: 'synthetic-model-key', encoding: 'none', transport: 'http' },
        models: {
          synthetic: { capabilities: { tools: true, input: ['text', 'image'], output: ['text'] }, limit: { context: 100_000, output: 4096 } },
          'synthetic-image': { type: 'image', capabilities: { tools: false, input: ['text', 'image'], output: ['image'] } },
        },
      },
    },
    policies: [{ action: 'provider.use', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: providerID, effect: 'allow' }],
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      ...[nativeTool, 'read', 'edit'].map(action => ({ action, resource: '*', effect: 'allow' })),
      { action: 'chatgpt_image', resource: 'gpt-image-2', effect: 'allow' },
      { action: 'openai_image', resource: 'gpt-image-2.5-sunburst', effect: 'allow' },
    ],
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
  host.on('error', () => { fixtureError = 'Could not start OpenCode. Set OPENCODE_BIN to the installed 2.2.5 executable.'; });
  const capture = (chunk: Buffer) => {
    hostOutput = (hostOutput + chunk.toString()).slice(-128 * 1024);
    hostURL ||= hostOutput.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? '';
  };
  host.stdout?.on('data', capture);
  host.stderr?.on('data', capture);
  await eventually(() => Boolean(hostURL), 'Private host startup timed out.');
  stage = 'host version';
  const info = object(await api('/api/info'));
  check(info.version === '2.2.5', 'Smoke harness requires installed OpenCode 2.2.5.');
  check(info.pid === host.pid, 'Private host identity does not match the owned process.');
  const temporary = object(info.paths).tmp;
  check(typeof temporary === 'string' && resolve(temporary).startsWith(root + sep), 'Private host temporary directory was not isolated.');
  stage = 'public status event subscription';
  eventTask = subscribeStatuses();
  await eventually(() => eventConnected, 'Private host status event subscription did not become ready.');
  stage = 'network fixture loading before production plugin';
  let plugins: ObjectValue[] = [];
  await eventually(async () => {
    plugins = array(object(await api('/api/plugin')).data).map(object);
    return plugins.some(plugin => plugin.id === 'synthetic-image-network') || plugins.some(plugin => object(plugin.state).status === 'failed');
  }, 'Network fixture plugin inventory did not become ready.');
  check(plugins.some(plugin => plugin.id === 'synthetic-image-network' && object(plugin.state).status === 'active'), 'Synthetic network guard did not load.');
  check(!plugins.some(plugin => plugin.id === 'opencode-chatgpt-image'), 'Production plugin loaded before the native availability check.');
  check(plugins.every(plugin => object(plugin.source).type === 'builtin' || ['synthetic-image-network', 'opencode-chatgpt-image'].includes(String(plugin.id))), 'Unexpected external plugin loaded in the private host.');
  const models = array(object(await api('/api/model?types=chat&types=image')).data).map(object);
  check(models.length === 2 && models.every(model => model.providerID === providerID)
    && models.some(model => model.id === 'synthetic') && models.some(model => model.id === 'synthetic-image' && model.type === 'image'), 'Private host did not isolate the synthetic chat/image model provider.');
  stage = 'native image tool available before plugin registration';
  await waitForInventory([nativeTool]);
  stage = 'production plugin registration suppresses native image tool';
  const pluginEntry = { package: pathToFileURL(pluginDirectory).href, options: { ...(mode === 'api' ? { mode } : {}), apiKey: token, enabledByDefault: false } };
  await writeFile(configPath, JSON.stringify({ ...config, plugins: [...config.plugins, pluginEntry] }));
  await waitForInventory([], [toolName]);
  suppressionRequired = true;
  plugins = array(object(await api('/api/plugin')).data).map(object);
  check(plugins.some(plugin => plugin.id === 'opencode-chatgpt-image' && object(plugin.state).status === 'active'
    && object(plugin.features).tui === true), 'Production plugin or its TUI companion was not discovered.');
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
  stage = 'new sessions default off and local command feedback';
  const session = await createSession();
  const otherSession = await createSession();
  check(await inventory([], false, session) && await inventory([], false, otherSession), 'A new session advertised an image tool.');
  await command(session, '');
  await command(otherSession, 'status');
  stage = 'enable only session A';
  await command(session, 'on', true);
  check(await inventory([toolName], true, session), 'Enabling images did not expose the selected schema.');
  check(await inventory([], false, otherSession), 'Enabling images affected another session.');
  const childSession = await createSession(undefined, session);
  check(await inventory([], false, childSession), 'Child session inherited its parent image toggle.');
  stage = 'disable session A and reject a forged hidden call';
  await command(session, 'off');
  check(await inventory([], false, session), 'Disabling images retained an image schema.');
  const forged = await runScenario(session, 'forged');
  check(forged.requests.length >= 1 && Number(events.length) === 0, 'A forged hidden image call reached the backend.');
  await readFile(join(workspace, 'forged.png')).then(() => { throw new Error('Hidden image was written.'); }, () => {});
  stage = 'disable blocks a tool call from an already captured request';
  await command(session, 'on', true);
  await runScenario(session, 'stale');
  check(imageTool(await context(session)).status === 'error', 'Captured image call did not fail after disabling images.');
  check(Number(events.length) === 0, 'A stale image call reached the backend after disabling images.');
  await readFile(join(workspace, 'stale.png')).then(() => { throw new Error('Stale image was written.'); }, () => {});
  await command(session, 'on', true);
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
    const metadata = object(state.metadata);
    if (mode === 'chatgpt') check(metadata.effective_model === null, 'Production result claimed an effective model.');
    check(metadata.requested_model === imageModel, 'Requested model was not preserved.');
    const reported = object(metadata.reported);
    check(reported.size === '1x1' && reported.quality === 'low' && reported.output_format === 'png'
      && reported.background === (operation === 'edit' ? 'transparent' : 'opaque'), 'Reported image settings did not survive host storage.');
    const usage = object(metadata.usage);
    check(usage.input_tokens === 7 && usage.output_tokens === 11 && usage.total_tokens === 18
      && object(usage.input_tokens_details).image_tokens === 0 && object(usage.output_tokens_details).image_tokens === 11, 'Reported usage did not survive host storage.');
    check(!JSON.stringify(metadata).includes('synthetic-unverified-model'), 'Backend model label was treated as an effective identity.');
    check(!JSON.stringify(state).includes(token), 'Production result exposed the synthetic credential.');
  }
  check(events.length === 2 && events[0]?.operation === 'generate' && events[1]?.operation === 'edit'
    && events[1]?.references === 1 && events[1]?.background === 'transparent', 'Generation/edit backend dispatch contract failed.');
  for (const permission of ['edit', 'model'] as const) {
    stage = `${permission} permission denial`;
    const denied = await createSession(permission);
    await command(denied, 'on', true);
    const operation = permission === 'edit' ? 'deny' : 'deny-model';
    await runScenario(denied, operation);
    check(imageTool(await context(denied)).status === 'error', 'Permission denial was not recorded as a tool error.');
    check(events.length === 2, 'Permission denial reached the image backend.');
    await readFile(join(workspace, `${operation}.png`)).then(() => { throw new Error('Denied image was written.'); }, () => {});
  }
  stage = 'cancellation';
  const cancelled = await createSession();
  await command(cancelled, 'on', true);
  await runScenario(cancelled, 'cancel');
  await eventually(() => events.some(event => event.operation === 'cancelled'), 'Cancellation did not stop the response stream.');
  await readFile(join(workspace, 'cancel.png')).then(() => { throw new Error('Cancelled image was written.'); }, () => {});
  stage = 'disabling does not abort an already running generation';
  await runScenario(session, 'inflight');
  check(imageTool(await context(session)).status === 'completed', 'Disabling images aborted an already running generation.');
  check((await readFile(join(workspace, 'inflight.png'))).equals(png), 'Running generation did not save its image after disabling.');
  check(await inventory([], false, session), 'Running generation restored the disabled image schema.');
  const backendEvents = events.length;
  let registered: readonly string[] = [toolName];
  for (const [label, options, expected] of [
    ['missing API key', { mode: 'api' }, []],
    ['corrected API key', { mode: 'api', apiKey: token }, ['openai_image']],
    ['explicit ChatGPT', { mode: 'chatgpt', apiKey: token }, ['chatgpt_image']],
    ['external references enabled', { mode: 'chatgpt', allowExternalReferences: true }, ['chatgpt_image']],
    ['invalid external references', { mode: 'chatgpt', allowExternalReferences: 'true' }, []],
    ['invalid enabled default', { mode: 'chatgpt', enabledByDefault: 'false' }, []],
    ['invalid mode', { mode: 'invalid' }, []],
    ['missing API key after ChatGPT', { mode: 'api' }, []],
    ['corrected API key after ChatGPT', { mode: 'api', apiKey: token }, ['openai_image']],
  ] as const) {
    stage = `watched configuration reload: ${label}`;
    if (registered.length > 0) {
      await command(session, 'on', true);
      check(await inventory(registered, false, session), 'Existing session could not enable images before reload.');
    }
    const updated = { ...config, plugins: [...config.plugins, { package: pluginEntry.package, options: { enabledByDefault: false, ...options } }] };
    await writeFile(configPath, JSON.stringify(updated));
    await waitForInventory([], expected, session);
    statusOverrides.clear();
    if (expected[0]) selectedTool = expected[0];
    await delay(250, undefined, { signal: deadline });
    check(await inventory([], false, session) && await inventory([]), 'Reloaded plugin did not keep both existing and new sessions disabled.');
    const currentPlugins = array(object(await api('/api/plugin')).data).map(object);
    check(currentPlugins.some(plugin => plugin.id === 'opencode-chatgpt-image' && object(plugin.state).status === 'active'), 'Reloaded plugin did not activate successfully; stale-generation fallback may have occurred.');
    check(events.length === backendEvents, 'Tool inventory reload probes dispatched an image request.');
    registered = expected;
  }
  stage = 'omitted enabledByDefault enables new and existing sessions after reload';
  await writeFile(configPath, JSON.stringify({
    ...config, plugins: [...config.plugins, { package: pluginEntry.package, options: { mode, apiKey: token } }],
  }));
  await waitForInventory([toolName], [toolName], session);
  statusOverrides.clear();
  defaultEnabled = true;
  selectedTool = toolName;
  check(await inventory([toolName]), 'Omitted enabledByDefault did not enable a new session.');
  await command(session, 'status', true);
  await command(session, 'off');
  check(await inventory([], false, session), 'Session off override did not override the enabled default.');
  const enabledChild = await createSession(undefined, session);
  check(await inventory([toolName], false, enabledChild), 'Child session inherited its parent off override instead of the configured default.');
  check(events.length === backendEvents, 'Default-policy probes dispatched an image request.');
  stage = 'plugin removal restores native image tool';
  suppressionRequired = false;
  await writeFile(configPath, JSON.stringify(config));
  await waitForInventory([nativeTool]);
  check(!array(object(await api('/api/plugin')).data).map(object).some(plugin => plugin.id === 'opencode-chatgpt-image'), 'Removed production plugin remained registered.');
  check(events.length === backendEvents, 'Native tool availability probes dispatched an image request.');
  if (mode === 'api') check(array(object(await api('/api/credential')).data).length === 0, 'API/reload smoke unexpectedly saved credentials.');
  check(!fixtureError, 'Synthetic fixture failed.');
  passed = true;
} catch (error) {
  const dispatches = events.filter(event => event.operation === 'generate' || event.operation === 'edit').length;
  console.error(`SYNTHETIC ONLY — smoke failed during ${stage}.${error instanceof SmokeError ? ` ${error.message}` : ''} Synthetic backend dispatches: ${dispatches}.`);
  process.exitCode = 1;
} finally {
  stage = 'cleanup';
  eventAbort.abort();
  await eventTask;
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

if (passed) console.log(`SYNTHETIC ONLY — OpenCode 2.2.5 (${mode}): TUI companion discovered; native available before registration/removal; enabledByDefault false/omitted verified; /images emits correct public SSE status without provider requests/history changes; children use configured defaults; enabled schema is only ${toolName}; hidden/stale calls blocked; generation/edit, metadata and image continuation passed; permissions and cancellation passed; off preserves running generation; config reload resets existing sessions to defaults and catalog reload keeps native suppressed; ${mode === 'api' ? 'no saved OAuth; ' : ''}owned host and temporary state cleaned up. TUI pixels were not tested.`);
