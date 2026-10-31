# Development

## Commands

Use Node.js 24+ and npm. On Windows, `npm.cmd` avoids the PowerShell shim restriction.

```sh
npm ci --ignore-scripts
npm run check
npm run smoke
npm run smoke -- --api
npm pack --dry-run
```

`check` runs strict TypeScript checking and Node's test runner. Unit tests use synthetic credentials and injected HTTP responses. File-symlink tests skip when the OS does not grant symlink creation; directory-junction checks still run on Windows.

`smoke` uses a private installed OpenCode server, isolated user state, a synthetic chat provider, and a test-only image transport. `--api` starts in API mode without any saved OAuth credential. Both runs exercise watched configuration changes, invalid-key disabling, and mutually exclusive tool registration. No real account credentials or paid providers are used. Set `OPENCODE_BIN` to the installed executable if it is not discoverable; on Windows use `opencode.exe`, not a `.ps1` or `.cmd` shim. Pass a plugin directory after `--` to test a separately installed package: `npm run smoke -- /path/to/node_modules/opencode-chatgpt-image`. Test packaged TypeScript through OpenCode's runtime, not Node's native type stripping, which rejects TypeScript inside `node_modules`.

The package exports TypeScript source directly for OpenCode's plugin runtime. No build or install lifecycle script is required. The root `index.ts` also supports configured local-directory discovery, which does not consult package exports. The entrypoint, `src/`, `docs/`, README, package manifest, and license are packaged; test harnesses are not part of the plugin.

## Live validation

**Get the account owner's approval first. This consumes subscription quota.** No public API fallback is available.

```sh
npm run smoke:live -- --approved
```

The live harness uses the managed OpenCode service and its active OpenAI login. It creates a separate temporary project and a restricted agent, asks `openai/gpt-6-astra` for one generation and one reference edit, and checks the resulting PNG files. It does not modify global configuration or restart the service. It retains the temporary project, images, and OpenCode sessions for inspection and prints the image paths. Stop on any failure; do not automatically retry an ambiguous request.

Successful generation establishes account/transport compatibility, not the identity of the serving image model. Actual image quality and whether an edit follows instructions require inspecting the images.

## Contracts

- `src/index.ts` is the V2 `Plugin.define` entrypoint. It first registers removal of `experimental_image_generate`, then registers exactly one selected tool for valid options. Unload aborts active requests. Invalid options retain removal-only activation and emit a static warning instead of throwing and permitting stale-option rollback. Suppression cannot survive failure to load or removal of the plugin itself; use an independent configuration disable for that guarantee. Existing snapshots and jobs are unaffected.
- `src/config.ts` parses `mode`, `apiKey`, parameter `defaults`, and the optional boolean `allowExternalReferences`. Caller parameters are merged and validated as an effective combination. Orientation is converted to size, never sent as an invented API field. Errors never include configuration values.
- Caller `null` clears the optional compression, moderation, fidelity and identity defaults before validation. It never appears on the wire; required/defaulted core controls still reject null. This lets callers change operation or format without inheriting incompatible optional settings.
- `src/api-tool.ts` implements API-mode permissions, bounded input uploads, local output preflight, generation/edit dispatch, and all returned attachments. API keys remain in the private execution closure, not the schema, tool inputs or result metadata. Partial batch writes are reported without deleting completed outputs.
- `src/openai.ts` calls only `api.openai.com/v1/images/generations` (JSON) or `images/edits` (multipart). It has no credential lookup, redirects or retries. All supplied authentication comes from plugin configuration. It expects the exact requested image count and format. Requests are limited to 200 MiB, response bodies to 256 MiB, decoded images to 32 MiB each.
- `src/tool.ts` validates arguments, resolves the invoking session's directory, checks permissions, orchestrates generation, and returns text plus native `type: "file"` image content. It never sets `output` without an output schema.
- `src/auth.ts` resolves only the active saved OpenAI OAuth connection through the host. It accepts `chatgpt-browser` and `chatgpt-headless`, rejects token-sharing markers, and rechecks the active connection after resolution. Concurrent resolutions within one tool instance are coalesced; credentials are not cached between completed calls. The host owns refresh tokens.
- `src/codex.ts` makes one request to the fixed `chatgpt.com/backend-api/codex/images/generations` or `images/edits` endpoint. Redirects, alternate hosts, API keys, and automatic retries are disallowed. Request/response bodies are capped at 48 MiB; decoded PNG output at 32 MiB. PNG checks validate structure, not every pixel or CRC.
- `src/image-response.ts` allowlists reported settings and numeric usage. `ImageRequestError` carries category, phase, outcome, optional HTTP status and bounded retry timing in a sanitized message. Error JSON is capped at 64 KiB and only known codes/types affect classification. Raw provider error messages, causes and arbitrary metadata are discarded. Transport/response failures after dispatch remain ambiguous; retry timing is informational, never an automatic retry instruction.
- `src/files.ts` validates image bytes, resolves canonical output paths inside the session tree, reads bounded local references, and writes with exclusive creation. Failed writes remove only the newly created file if its identity still matches. Standard Node path checks cannot form a sandbox against hostile concurrent directory replacement.
- `src/references.ts` prepares local or HTTPS sources and authorizes each read/download. External local files are enabled by default and require external-directory and read permissions; `allowExternalReferences: false` restricts local inputs to the session tree. Remote downloads use bounded time/bytes and validate destinations and redirects without forwarding OpenAI authentication. Output confinement is independent of reference access.

In subscription mode the request label is `gpt-image-2`, matching the Codex client contract. It is recorded as `requested_model`, never as proof of the effective model. `effective_model` remains `null` even if the backend returns an apparent model label. Size and quality are sent as `auto`. API mode forwards explicit model/size/quality under the public API contract; result metadata labels these as requested values rather than independently verified model identity.

Generation permissions use the requested model ID, while edit permissions use output paths. Resolved quality, size and count are approval metadata, not separate resource filters. Reference permissions precede each read; no image-generation request is dispatched until all inputs are authorized and loaded. Optional result `reported` and `usage` fields contain allowlisted validated provider values, never raw response objects. API request-wide usage is included once, not multiplied by batch count. Missing usage and effective model identity remain unknown; no dollar accounting is inferred.

Generation remains foreground. The public plugin API does not expose native durable jobs or late file attachments on completed tool calls; this implementation does not import private services or simulate a durable job system.

API mode supports nonstreaming GPT Image generation/editing, not retired DALL·E controls or streaming partials. The multipart edit contract omits moderation, so that field is rejected for edits. Input fidelity on 2.5 is unverified and rejected. Mask limits follow the stricter multipart reference (<4 MB), not the more permissive guide. These are explicit constraints, never silently dropped overrides. Server-side validation remains authoritative for reference/overlay alignment and actual transparent pixels.

Permission errors propagate unchanged. Cancellation stops waiting for host permission, session, and credential operations; those public APIs cannot cancel their underlying work, so a host refresh or existing permission request can outlive the tool. Late completion never starts another operation. Cancellation after dispatch cannot cancel remote billing. A session that moves before dispatch or saving is rejected rather than writing to its former location. References can still change on disk between permission approval and reading; treat the workspace and local OS as trusted.

## Evidence and compatibility

The runtime dependency `@opencode/plugin` is pinned to 2.2.5. Do not infer broad V1/V2 compatibility from a passing unit suite; exercise the production entrypoint on every host version claimed as supported. Keep live services and test servers separate, and freeze source while installed-host tests run to avoid reload races.

- [V2 plugin API](https://opencode.ai/v2/docs/build/plugins)
- [Pinned host credential resolution](https://github.com/anomalyco/opencode/blob/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824/packages/core/src/integration.ts)
- [Pinned Codex image request](https://github.com/openai/codex/blob/166aed98544d2aa7500642604199ea5bbca3aa0f/codex-rs/ext/image-generation/src/tool.rs)
- [Images 2.5 availability](https://openai.com/index/introducing-chatgpt-images-2-5)
- [Unresolved subscription model selection](https://github.com/openai/codex/issues/43965)
- [Plan-sharing limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Public image generation reference](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [Image size constraints](https://developers.openai.com/api/docs/guides/image-prompting)
- [Official Images API types](https://github.com/openai/openai-node/blob/master/src/resources/images.ts)
