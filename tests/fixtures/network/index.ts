import { Plugin } from '@opencode/plugin';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const endpoints = new Set([
  'https://chatgpt.com/backend-api/codex/images/generations',
  'https://chatgpt.com/backend-api/codex/images/edits',
  'https://api.openai.com/v1/images/generations',
  'https://api.openai.com/v1/images/edits',
]);

export default Plugin.define({
  id: 'synthetic-image-network',
  async setup(ctx) {
    const origin = String(ctx.options.origin);
    const token = String(ctx.options.token);
    const account = String(ctx.options.account);
    const mode = ctx.options.mode ?? 'chatgpt';
    if (new URL(origin).hostname !== '127.0.0.1' || !token.startsWith('synthetic-') || !['api', 'chatgpt'].includes(String(mode))) {
      throw new Error('Invalid synthetic network fixture configuration.');
    }
    const original = globalThis.fetch;
    const notify = async (value: Record<string, unknown>) => {
      const response = await original(`${origin}/image-event`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (!response.ok) throw new Error('Synthetic event collection failed.');
    };
    const shim: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (endpoints.has(url)) {
        const headers = new Headers(init?.headers);
        const api = url.startsWith('https://api.openai.com/');
        if (api !== (mode === 'api') || headers.get('authorization') !== `Bearer ${token}`
          || init?.redirect !== 'error' || init?.method !== 'POST'
          || (api ? headers.has('chatgpt-account-id') || headers.has('originator')
            : headers.get('chatgpt-account-id') !== account || headers.get('originator') !== 'opencode')) {
          throw new Error('Synthetic image request contract failed.');
        }
        const edit = url.endsWith('/edits');
        let request: Record<string, unknown>;
        let references: number;
        if (api && edit) {
          if (!(init.body instanceof FormData) || headers.has('content-type')) throw new Error('API edits must use multipart with an automatic boundary.');
          const uploads = init.body.getAll('image[]');
          references = uploads.length;
          if (references !== 1) throw new Error('API edit reference count failed.');
          for (const image of uploads) {
            if (!(image instanceof File) || image.type !== 'image/png' || image.name !== 'generate.png'
              || Buffer.from(await image.arrayBuffer()).toString('base64') !== PNG) throw new Error('API edit upload failed.');
          }
          request = Object.fromEntries([...init.body].filter(([name]) => name !== 'image[]'));
        } else {
          if (api && headers.get('content-type') !== 'application/json') throw new Error('API generation must use JSON.');
          request = JSON.parse(String(init.body)) as Record<string, unknown>;
          const images = request.images as { image_url: string }[] | undefined;
          references = images?.length ?? 0;
          if (images?.some(image => image.image_url !== `data:image/png;base64,${PNG}`)) throw new Error('ChatGPT edit upload failed.');
        }
        if (api) {
          if (request.model !== 'gpt-image-2.5-sunburst' || request.quality !== 'max' || request.size !== '3840x2160'
            || request.output_format !== 'png' || Number(request.n) !== 1 || 'stream' in request || 'orientation' in request
            || request.background !== (edit ? 'transparent' : 'auto')) throw new Error('Synthetic API image request fields failed.');
        } else if (request.model !== 'gpt-image-2' || request.quality !== 'auto' || request.size !== 'auto') {
          throw new Error('Synthetic ChatGPT image request fields failed.');
        }
        await notify({ operation: edit ? 'edit' : 'generate', mode, references, background: request.background });
        if (request.prompt === 'synthetic cancellation') {
          return new Response(new ReadableStream<Uint8Array>({
            cancel() { return notify({ operation: 'cancelled' }); },
          }));
        }
        return Response.json({
          data: [{ b64_json: PNG }], size: '1x1', quality: 'low', output_format: 'png', background: edit ? 'transparent' : 'opaque',
          model: 'synthetic-unverified-model', api_key: token,
          usage: {
            input_tokens: 7, output_tokens: 11, total_tokens: 18,
            input_tokens_details: { text_tokens: 7, image_tokens: 0 }, output_tokens_details: { image_tokens: 11 },
            untrusted: token,
          },
        });
      }
      if (new URL(url).origin !== origin) throw new Error('Synthetic fixture blocked a non-fixture network request.');
      return original(input, { ...init, redirect: 'error' });
    };
    globalThis.fetch = shim;
    await ctx.session.hook('prompt', async event => {
      if (event.prompt.text !== 'Synthetic catalog-reload fixture.') return;
      await ctx.model.reload();
      const models = await ctx.model.list({ types: ['image'] });
      await ctx.tool.reload();
      const tools = await ctx.tool.list();
      await notify({
        operation: 'catalog-reload',
        imageModelAvailable: models.data.some(model => model.providerID === 'image-smoke-fixture' && model.id === 'synthetic-image' && model.type === 'image'),
        tools: tools.map(tool => tool.id).filter(name => ['experimental_image_generate', 'chatgpt_image', 'openai_image'].includes(name)).sort(),
      });
    });
    await ctx.session.hook('title', event => { event.result = 'Synthetic image smoke'; });
    await ctx.session.hook('http.request', event => {
      event.request.headers.set('x-fixture-session', event.sessionID);
    });
    await ctx.session.hook('retry', event => { event.decision = { retry: false }; });
    return () => { if (globalThis.fetch === shim) globalThis.fetch = original; };
  },
});
