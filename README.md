# OpenCode ChatGPT Image

Generate and edit images in OpenCode using your existing ChatGPT subscription login. No API key, Codex CLI, or separate credential store.

This is an unofficial integration with the private Codex image backend. It can change without notice. Generations consume your Codex allowance; they are not unlimited.

## Install

Requires OpenCode V2. Tested against 2.1.4. Node.js 24+ and npm are needed to install and develop this local checkout.

From this repository:

```sh
npm ci --ignore-scripts
```

On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.

This repository does not include an `opencode.json`. Register the checkout once, in your global OpenCode configuration or the consuming project's configuration, not both. Preserve other entries:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["../opencode-chatgpt-image"],
  "permissions": [
    { "action": "chatgpt_image", "resource": "*", "effect": "ask" }
  ]
}
```

This example assumes a sibling checkout. Replace the path with your checkout's location, relative to the configuration file. Configuration changes reload automatically; `/reload` forces a reload. No service restart is needed.

In OpenCode, run `/connect`, choose **OpenAI**, and select a **Codex** browser or device-code login. The plugin uses the active OpenAI account and lets OpenCode refresh its credentials.

The newer **Sign in with ChatGPT** plan-sharing login does not support this image route. API-key and environment-key connections are rejected. The plugin never switches accounts or falls back to API billing.

## Use

Ask your agent:

> Generate a square illustration of a blue ceramic cup. Save it to output/cup.png using chatgpt_image.

> Change the cup to red, using output/cup.png as a reference. Save the edit to output/red-cup.png.

The agent receives a saved file path and an image attachment. It can use any tool-capable chat model; image generation uses the separate active OpenAI connection.

The `chatgpt_image` tool accepts:

| Argument | Meaning |
| --- | --- |
| `prompt` | Required image description or editing instructions, up to 32,000 characters. Put desired aspect ratio and dimensions here. |
| `output_path` | Required new `.png` path, relative to the session directory or absolute within it. Existing files are never overwritten. |
| `reference_images` | Optional list of up to five local PNG, JPEG, or WebP files. Supplying references uses the editing endpoint. |
| `background` | `opaque` (default) or `transparent`. |

All files must remain inside the session directory, including resolved symbolic links. Copy external reference images into the project first. Each reference is limited to 10 MiB; the combined encoded request is limited to 48 MiB.

## Limits and permissions

- Prompts and reference images are sent to OpenAI. The tool checks `chatgpt_image`, `read` for references, and `edit` for the output through OpenCode's permission system.
- One PNG is returned per call. Exact dimensions, quality, and image-model selection are not exposed.
- OpenAI announces Images 2.5 in Codex, but the subscription endpoint does not provide a reliable effective-model identifier. The plugin reports the effective model as unknown; it does not claim Flare or Sunburst selection.
- Requests stop locally after five minutes or when the session/plugin is cancelled. OpenAI may still finish the request and consume quota. Failed requests are never automatically retried.
- Upstream error bodies and credentials are not included in tool results. Authentication failures require fixing the active Codex login, not adding an API key.

To require confirmation before generation, add a permission rule:

```json
{
  "permissions": [
    { "action": "chatgpt_image", "resource": "*", "effect": "ask" }
  ]
}
```

[Development and tests](docs/contributing/README.md)

## License

[MIT](LICENSE)
