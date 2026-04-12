# Plugins

Chrome extension plugins built under the Augmentis org.

Each plugin is a self-contained Chrome extension with an optional local
Node.js backend. All plugins share a single dev environment that watches
every extension simultaneously and auto-fixes runtime errors using Claude
or a local Ollama model.

---

## Plugins

| Plugin | Description |
|---|---|
| [Browsky](https://github.com/Augmentis/Browsky) | Chrome extension with a local WebSocket server, supporting Claude CLI and Ollama sessions |
| [OllamaX](https://github.com/Augmentis/OllamaX) | Ollama API explorer, model manager and chat — right in your browser |

---

## Dev workflow

All plugins run through a single shared dev environment launched from
this workspace root:

```bash
./dev/dev.sh
```

This starts one sandboxed Chrome instance and one orchestrator process
that watches every registered plugin simultaneously. When any extension
throws an error, the orchestrator identifies which plugin owns it and
routes the fix to that plugin's configured fixer (Claude or Ollama) — no
manual intervention needed.

### First-time setup for a plugin

1. Run `./dev/dev.sh` — Chrome opens
2. Load the extension in that Chrome window:
   ```
   chrome://extensions → Enable Developer mode → Load unpacked → <plugin>/extension/
   ```
3. The orchestrator maps the extension ID to the plugin and starts watching

You only need to load each extension once. Chrome remembers it across
restarts within the same profile (`dev/.chrome-dev-profile`).

### Triggering a test

Open the extension, then run in its page console:
```js
console.error("test error")
```

The orchestrator will catch it, print the owning plugin name, open a
Terminal window, and start a Claude session rooted at that plugin's folder.

### Adding a plugin to the dev loop

Edit `dev/registry.json`:
```json
{
  "cdpPort": 9222,
  "plugins": [
    { "path": "../Browsky", "fixer": "claude" },
    { "path": "../OllamaX", "fixer": "claude" },
    { "path": "../NewPlugin", "fixer": "ollama:llama3" }
  ]
}
```

See `dev/HOW-IT-WORKS.md` for a complete breakdown of how error detection,
plugin routing, session memory, and fix verification work.

---

## Adding a new plugin

See `CLAUDE.md` for step-by-step instructions.
