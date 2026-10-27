import { Plugin } from '@opencode/plugin';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const endpoints = new Set([
  'https://chatgpt.com/backend-api/codex/images/generations',
  'https://chatgpt.com/backend-api/codex/images/edits',
]);

export default Plugin.define({
  id: 'synthetic-image-network',
  async setup(ctx) {
    const origin = String(ctx.options.origin);
    const token = String(ctx.options.token);
    const account = String(ctx.options.account);
    if (new URL(origin).hostname !== '127.0.0.1' || !token.startsWith('synthetic-')) {
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
        if (headers.get('authorization') !== `Bearer ${token}` || headers.get('chatgpt-account-id') !== account
          || headers.get('originator') !== 'opencode' || init?.redirect !== 'error' || init?.method !== 'POST') {
          throw new Error('Synthetic image request contract failed.');
        }
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        const images = request.images as { image_url: string }[] | undefined;
        if (request.model !== 'gpt-image-2' || request.quality !== 'auto' || request.size !== 'auto'
          || images?.some(image => !image.image_url.startsWith('data:image/png;base64,'))) {
          throw new Error('Synthetic image request fields failed.');
        }
        await notify({ operation: url.endsWith('/edits') ? 'edit' : 'generate', references: images?.length ?? 0, background: request.background });
        if (request.prompt === 'synthetic cancellation') {
          return new Response(new ReadableStream<Uint8Array>({
            cancel() { return notify({ operation: 'cancelled' }); },
          }));
        }
        return Response.json({ data: [{ b64_json: PNG }] });
      }
      if (new URL(url).origin !== origin) throw new Error('Synthetic fixture blocked a non-fixture network request.');
      return original(input, { ...init, redirect: 'error' });
    };
    globalThis.fetch = shim;
    await ctx.session.hook('title', event => { event.result = 'Synthetic image smoke'; });
    await ctx.session.hook('http.request', event => {
      event.request.headers.set('x-fixture-session', event.sessionID);
    });
    await ctx.session.hook('retry', event => { event.decision = { retry: false }; });
    return () => { if (globalThis.fetch === shim) globalThis.fetch = original; };
  },
});
