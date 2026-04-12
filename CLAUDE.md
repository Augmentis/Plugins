# CLAUDE.md — Plugins Workspace

This is the root workspace for all Chrome extension plugins under the
Augmentis org. Each plugin lives in its own subfolder and its own git repo.

---

## Workspace structure

```
Plugins/
├── CLAUDE.md                    ← this file
├── README.md                    ← workspace overview
├── .gitignore                   ← ignores individual plugin repos
├── dev/                         ← shared dev tooling (source of truth)
│   ├── dev.sh                   ← launch Chrome + start the orchestrator
│   ├── error-loop.js            ← central CDP watcher + fixer router
│   ├── registry.json            ← active plugin list + shared CDP port
│   ├── HOW-IT-WORKS.md          ← full explanation of the dev loop
│   └── dev.config.template.json ← template to copy into new plugins
├── Browsky/                     ← (gitignored — own repo)
├── OllamaX/                     ← (gitignored — own repo)
└── <NewPlugin>/                 ← (gitignored once created)
```

---

## Dev environment

All plugins share a single dev environment launched from the workspace root:

```bash
./dev/dev.sh
```

This starts one sandboxed Chrome instance (profile at `dev/.chrome-dev-profile`)
with remote debugging enabled, then starts `error-loop.js` — a central
orchestrator that watches every registered extension simultaneously.

When an error fires in any loaded extension, the orchestrator:
1. Identifies which plugin owns the faulting extension by mapping the extension
   ID (from the CDP target URL) to the plugin registered in `dev/registry.json`
2. Routes the error — with source context — to that plugin's configured fixer
3. Reloads only that plugin's extension after the fix
4. Verifies the error does not recur

Plugins are completely isolated: an error in Browsky never touches Doctr's
Claude session or source files.

See `dev/HOW-IT-WORKS.md` for the complete flow.

---

## Registering a plugin

`dev/registry.json` controls which plugins are active in the dev loop:

```json
{
  "cdpPort": 9222,
  "plugins": [
    { "path": "../Browsky", "fixer": "claude" },
    { "path": "../OllamaX", "fixer": "claude" },
    { "path": "../Doctr",   "fixer": "claude" }
  ]
}
```

Add a new entry whenever a new plugin is ready to be developed. Remove or
comment out entries for plugins not currently being worked on.

**`fixer` options:**
- `"claude"` — uses the Claude CLI; maintains a persistent session per plugin
- `"ollama:<model>"` — uses a local model via Ollama (e.g. `"ollama:llama3"`)

---

## Creating a new plugin

1. Create a new folder: `mkdir <PluginName>`
2. Copy the plugin CLAUDE.md into it:
   ```bash
   cp Browsky/CLAUDE.md <PluginName>/CLAUDE.md
   ```
3. Copy the dev config template:
   ```bash
   cp dev/dev.config.template.json <PluginName>/dev.config.json
   ```
4. Register it in `dev/registry.json` (add an entry under `"plugins"`)
5. Add the new folder to `.gitignore` in this workspace root
6. `cd <PluginName> && git init` — each plugin is its own repo
7. Start a Claude session inside the plugin folder — it will read `CLAUDE.md`
   and take it from there

---

## Shared dev tooling

The `dev/` folder is the canonical source for all shared scripts:

| File | Purpose |
|---|---|
| `dev/dev.sh` | Launches sandboxed Chrome + starts the error-loop orchestrator |
| `dev/error-loop.js` | Watches all extensions, maps errors to plugins, runs fixers |
| `dev/registry.json` | Active plugin list and shared CDP port |
| `dev/HOW-IT-WORKS.md` | Complete explanation of the dev loop |
| `dev/dev.config.template.json` | Template `dev.config.json` for new plugins |

When updating these scripts, they take effect immediately on the next
`./dev/dev.sh` run — no copying into individual plugin folders required.

---

## SDKs

Reusable packages that plugins can depend on live in `../SDKs/` (sibling to
this workspace). They are separate repos published under `@augmentis/` on npm.

| Package | Path | Purpose |
|---|---|---|
| `@augmentis/codie` | `../SDKs/Codie` | General-purpose local Ollama code editing agent |

To use Codie as a plugin's fixer, set `"fixer": "ollama:<model>"` in
`dev/registry.json` for that plugin. See `../SDKs/Codie/README.md` for details.

---

## Conventions

- Chrome only, Manifest V3
- Dark UI — Claude-inspired design (see Browsky/extension/styles.css as reference)
- Local backends: WebSocket on localhost, starting at port 3457 (increment per plugin)
- GitHub org: Augmentis
- No "made with Claude" in commit messages
