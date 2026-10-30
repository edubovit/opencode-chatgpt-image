# OpenCode ChatGPT Image

Generate and edit images in OpenCode using either your ChatGPT subscription or the paid OpenAI Images API. Images are saved locally and returned as image attachments for native TUI previews.

## Install

Requires OpenCode V2; tested against 2.1.4. Use Node.js 24+ and npm for this checkout:

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

## Use

> Use chatgpt_image to generate a square blue ceramic cup. Save it to output/cup.png.

> Use openai_image to create a poster at the configured quality. Save it to output/poster.png, but override orientation to vertical.

> Use openai_image to change only the cup color to red, using output/cup.png as a reference. Save it to output/red-cup.png.

Both tools require `prompt` (1–32,000 characters) and `output_path`. Paths must stay inside the session directory, including resolved symbolic links. Existing outputs are never overwritten. Copy outside references into the project first.

### `chatgpt_image` arguments

| Argument | Meaning |
| --- | --- |
| `prompt`, `output_path` | Required. Output must be a new `.png`. Put desired aspect ratio/style in the prompt. |
| `reference_images` | Up to five PNG/JPEG/WebP files, 10 MiB each. References select editing. |
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
| `reference_images` | Up to 16 local PNG/JPEG/WebP files, each less than 50,000,000 bytes. |
| `mask` | Optional PNG mask under 4,000,000 bytes; transparent pixels select edit regions in the first reference. |
| `markup` | Optional transparent PNG annotation overlay for 2.5 edits, under 50,000,000 bytes. Exclusive with `mask`. |

Masks/markup require reference images and must match the first reference's dimensions; the API validates overlay dimensions and transparency. Combined uploads are limited to 200 MiB.

Horizontal/vertical orientation swaps dimensions when needed; square uses the shorter edge. An explicit caller `size` takes precedence over a configured orientation unless the caller also supplies `orientation`. `size: "auto"` cannot be combined with a fixed orientation.

For 2/2.5, dimensions must be divisible by 16, no edge may exceed 3840, aspect ratio must be at most 3:1, and pixel count must be 655,360–8,294,400. Older models accept only `auto`, `1024x1024`, `1536x1024`, or `1024x1536`. Switching to an older model may also require overriding the default quality and size; incompatible defaults are rejected, not silently downgraded. JPEG cannot be transparent.

Transport is nonstreaming: the tool returns final images, not partial previews. `stream`, `partial_images`, `response_format`, legacy DALL·E `style`, arbitrary endpoints, and caller-supplied API keys are not accepted. Describe visual style in the prompt.

## Safety and previews

- Prompts and reference images are uploaded to OpenAI. Each tool checks its own permission action plus `read` for inputs and `edit` for outputs.
- Requests stop waiting after five minutes or cancellation. Remote work may still complete and incur allowance usage or API charges. Never automatically retry an ambiguous failure.
- API responses are capped at 256 MiB, decoded images at 32 MiB each. If a later file write fails, already saved images remain and their paths are reported.
- Enable **Transcript images** in OpenCode's TUI settings for thumbnails. No separate viewer plugin is needed.

[Development and tests](docs/contributing/README.md) · [MIT license](LICENSE)
