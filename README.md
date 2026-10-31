# OpenCode ChatGPT Image

Generate and edit images in OpenCode using either your ChatGPT subscription or the paid OpenAI Images API. Images are saved locally and returned as image attachments for native TUI previews.

## Install

Targets OpenCode 2.2.5. Use Node.js 24+ and npm for this checkout:

```sh
npm ci --ignore-scripts
```

On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.

The repository deliberately contains no `opencode.json`. Register the checkout **once**, in your global OpenCode configuration or the consuming project's configuration. Preserve other plugin entries and permission rules. Relative paths below assume a sibling checkout and resolve from the configuration file. Valid configuration changes reload automatically.

## Modes

| Mode | Exposed tool | Authentication | Billing |
| --- | --- | --- | --- |
| `chatgpt` (default) | `chatgpt_image` only | OpenCode's active Codex OAuth login | Codex subscription allowance |
| `api` | `openai_image` only | Required plugin `apiKey` | Separate OpenAI API charges |

The tools are never registered together. An optional API key in `chatgpt` mode is unused. Neither mode falls back to the other, switches accounts, or automatically retries requests.

While loaded, the plugin removes OpenCode's `experimental_image_generate` tool, including when its own configuration is invalid or the session toggle is off. Unloading or failing to load the plugin can restore the native tool. To keep it disabled independently, add `"-opencode.tool.image-generate"` to your existing `plugins` array. This does not disable providers, authentication, reading images, or previews, and does not cancel jobs already started.

### ChatGPT subscription

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "../opencode-chatgpt-image", "options": { "mode": "chatgpt" } }
  ],
  "permissions": [
    { "action": "chatgpt_image", "resource": "*", "effect": "ask" }
  ]
}
```

The existing plain string plugin entry also works and defaults to `chatgpt`.

Use `/connect` → **OpenAI** → a **Codex** browser or device login. OpenCode owns credential storage and refresh. The newer **Sign in with ChatGPT** plan-sharing connection and API-key connections do not authenticate this private endpoint.

This is an unofficial integration with the private Codex backend. It can change without notice. The backend controls the image model, dimensions and quality; the plugin does not claim Flare/Sunburst selection or exact sizes. Generations consume your Codex allowance.

### OpenAI API

**API usage is billed separately from your ChatGPT subscription. The default 4K/max request favors quality, not cost. OpenAI describes resolutions above 3,686,400 pixels as experimental.**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "../opencode-chatgpt-image",
      "options": {
        "mode": "api",
        "apiKey": "{env:OPENAI_API_KEY}",
        "defaults": {
          "model": "gpt-image-2.5-sunburst",
          "quality": "max",
          "size": "3840x2160"
        }
      }
    }
  ],
  "permissions": [
    { "action": "openai_image", "resource": "*", "effect": "ask" }
  ]
}
```

Set `OPENAI_API_KEY` in the environment of the OpenCode server. OpenCode expands the placeholder in plugin configuration. A literal key in `options.apiKey` also works, but keep that configuration private and never commit it. No automatic key discovery or OAuth fallback is performed. Invalid configuration (including `api` mode without a usable key) disables both image tools and writes a sanitized warning to the server log. The plugin remains loaded but inert, so OpenCode cannot restore the previous mode after a configuration error.

`options.defaults` accepts the API tool's generation parameters listed below. Caller arguments override these defaults; file paths and prompts are supplied per call. In `chatgpt` mode, API defaults do not affect its limited tool.

Callers can pass `null` to clear optional configured `output_compression`, `moderation`, `input_fidelity`, `safety_identifier`, or `user` values. For example, clear `moderation` for editing or clear JPEG compression when changing output to PNG. Null is removed locally, not sent to OpenAI.

## Session toggle

Image tools are enabled by default. To keep the image tool schema out of normal model requests, add `"enabledByDefault": false` to the plugin's existing `options` alongside its mode, key and other settings. This option controls tool visibility, not whether the plugin loads.

Use these commands in a session:

| Command | Effect |
| --- | --- |
| `/images on` | Expose the configured image tool for this session. |
| `/images off` | Hide it and block new image-tool calls. |
| `/images status` or `/images` | Show the current state and configured default. |

Commands do not call a model or generate images. The bundled TUI component shows confirmation for the displayed session. Feedback is a live RPC event: clients without that component, or disconnected clients, do not display the toast. No confirmation text is inserted into model context or session history.

Overrides affect only the current session in the loaded plugin instance. Other sessions and child sessions use the configured default. Overrides are not persisted; plugin reload, unload or server restart resets them to `enabledByDefault`. Turning tools off does not cancel calls already executing or erase previous tool calls/results. Generation still requires its normal permissions.

## Use

> Use chatgpt_image to generate a square blue ceramic cup. Save it to output/cup.png.

> Use openai_image to create a poster at the configured quality. Save it to output/poster.png, but override orientation to vertical.

> Use openai_image to change only the cup color to red, using output/cup.png as a reference. Save it to output/red-cup.png.

Both tools require `prompt` (1–32,000 characters) and `output_path`. Output paths must stay inside the session directory, including resolved symbolic links. Existing outputs are never overwritten. Generation stays in the foreground and returns image attachments directly; there are no presets or automatic output filenames.

### Reference inputs

References accept local PNG/JPEG/WebP paths or public HTTPS image URLs. URL downloads require `webfetch` permission, enforce byte and time limits, and never forward OpenAI credentials. HTTP, URL credentials, private-network destinations, and unsafe redirects are rejected.

Local references outside the session directory are enabled by default, subject to `external_directory` and `read` permissions. Set `"allowExternalReferences": false` in the plugin's `options` to restrict local inputs to the session directory. This does not permit outside output paths. Masks and markup accept the same source forms, but must be PNG.

### `chatgpt_image` arguments

| Argument | Meaning |
| --- | --- |
| `prompt`, `output_path` | Required. Output must be a new `.png`. Put desired aspect ratio/style in the prompt. |
| `reference_images` | Up to five local or HTTPS PNG/JPEG/WebP images, 10 MiB each. References select editing. |
| `background` | `opaque` (default) or `transparent`. |

One PNG per call. Combined encoded request limit: 48 MiB.

### `openai_image` arguments and defaults

| Argument | Default / supported values |
| --- | --- |
| `model` | `gpt-image-2.5-sunburst`; also Flare and both 2.5 dated snapshots, `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1-mini`. |
| `quality` | `max`; `auto`, `low`, `medium`, `high`, `xhigh`, `max`. `xhigh`/`max` require 2.5. |
| `size` | `3840x2160` (horizontal); `auto` or `WIDTHxHEIGHT`, validated for the selected model. |
| `orientation` | Inferred from size; `auto`, `horizontal`, `vertical`, `square`. This is a convenience, not an API field. |
| `background` | `auto`; also `opaque`, `transparent`, subject to model/format support. |
| `n` | `1`; 1–10 outputs. Further files add `-2`, `-3`, etc. before the extension. |
| `output_format` | `png`; also `jpeg`, `webp`. Output extension must match (`.jpg` or `.jpeg` for JPEG). |
| `output_compression` | Unset; 0–100 for JPEG/WebP only. |
| `moderation` | Unset; `auto` or `low`, generation only. Not verified for multipart editing. |
| `safety_identifier` | Optional privacy-preserving end-user identifier, at most 128 characters. |
| `user` | Optional legacy end-user identifier. Prefer `safety_identifier`. |
| `input_fidelity` | Editing only: `high`/`low` on 1.5, `low` on mini. Rejected for 2/2.5, where support is absent or unverified. |
| `reference_images` | Up to 16 local or HTTPS PNG/JPEG/WebP images, each less than 50,000,000 bytes. |
| `mask` | Optional PNG mask under 4,000,000 bytes; transparent pixels select edit regions in the first reference. |
| `markup` | Optional transparent PNG annotation overlay for 2.5 edits, under 50,000,000 bytes. Exclusive with `mask`. |

Masks/markup require reference images and must match the first reference's dimensions; the API validates overlay dimensions and transparency. Combined uploads are limited to 200 MiB.

Horizontal/vertical orientation swaps dimensions when needed; square uses the shorter edge. An explicit caller `size` takes precedence over a configured orientation unless the caller also supplies `orientation`. `size: "auto"` cannot be combined with a fixed orientation.

For 2/2.5, dimensions must be divisible by 16, no edge may exceed 3840, aspect ratio must be at most 3:1, and pixel count must be 655,360–8,294,400. Older models accept only `auto`, `1024x1024`, `1536x1024`, or `1024x1536`. Switching to an older model may also require overriding the default quality and size; incompatible defaults are rejected, not silently downgraded. JPEG cannot be transparent.

Transport is nonstreaming: the tool returns final images, not partial previews. `stream`, `partial_images`, `response_format`, legacy DALL·E `style`, arbitrary endpoints, and caller-supplied API keys are not accepted. Describe visual style in the prompt.

## Safety and previews

- Prompts and reference images are uploaded to OpenAI. Generation approval uses `chatgpt_image` or `openai_image` with the requested model ID as its resource (for example `gpt-image-2.5-sunburst`). Output writes separately require `edit` on each path; inputs require `read` or `webfetch`. Generation rules using `resource: "*"` remain valid; path-specific generation rules must use model IDs instead. Keep path restrictions under `edit`.
- Requests stop waiting after five minutes or cancellation. Remote work may still complete and incur allowance usage or API charges. Never automatically retry an ambiguous failure.
- API responses are capped at 256 MiB, decoded images at 32 MiB each. If a later file write fails, already saved images remain and their paths are reported.
- Results distinguish requested settings from validated provider-reported settings and token usage, when available. Missing usage is unknown, not zero. No dollar charge, subscription balance, or serving-model identity is inferred.
- Provider failures have sanitized categories and submission outcomes. A rejected request differs from an unknown outcome after submission; neither is automatically retried. Raw provider messages and metadata are not forwarded.
- Enable **Transcript images** in OpenCode's TUI settings for thumbnails. No separate viewer plugin is needed.

[Development and tests](docs/contributing/README.md) · [MIT license](LICENSE)
