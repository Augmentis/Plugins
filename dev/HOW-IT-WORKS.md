# How the Dev Error Loop Works

This is a self-healing dev setup. When any loaded extension throws a JavaScript
error, it is automatically detected, attributed to the correct plugin, and sent
to that plugin's configured fixer — which reads the source, edits the file, and
verifies the fix — without any manual intervention.

---

## The big picture

```
Any loaded extension throws an error
           ↓
error-loop.js receives it via CDP
           ↓
Extension ID mapped → owning plugin
           ↓
Error + source context sent to plugin's fixer
(Claude session or local Ollama model)
           ↓
Fixer edits the file directly
           ↓
That plugin's extension reloads
           ↓
Loop watches 12s to confirm the error is gone
           ↓
If it recurs → same fixer retried with a deeper prompt
```

---

## Architecture

The workspace runs a single shared Chrome instance with all active extensions
loaded at once. A single orchestrator process connects to that Chrome via the
Chrome DevTools Protocol (CDP) and watches every extension simultaneously.

Each plugin registers itself in `dev/registry.json`. When an error fires, the
orchestrator resolves which plugin owns the faulting extension, then routes the
error exclusively to that plugin's fixer. Plugins are fully isolated — an error
in Browsky never touches Doctr's Claude session or source files.

```
dev/
├── registry.json       ← which plugins are active and how each one is fixed
├── dev.sh              ← launches one Chrome, starts error-loop.js
└── error-loop.js       ← orchestrator: watches all extensions, routes all errors
```

---

## Step by step

### 1. `registry.json` — the plugin manifest

`dev/registry.json` is the single place that controls what runs:

```json
{
  "cdpPort": 9222,
  "plugins": [
    { "path": "../Browsky", "fixer": "claude" },
    { "path": "../OllamaX", "fixer": "ollama:llama3" },
    { "path": "../Doctr",   "fixer": "claude" }
  ]
}
```

- **`cdpPort`** — the Chrome remote debugging port shared by all plugins
- **`path`** — path to the plugin root, relative to `dev/`
- **`fixer`** — `"claude"` to use Claude CLI, or `"ollama:<model>"` to use a
  local model via Ollama

### 2. `dev.sh` — the launcher

`./dev/dev.sh` (run from the workspace root) does two things:

1. **Launches one Chrome** in a sandboxed profile (`dev/.chrome-dev-profile`)
   with `--remote-debugging-port=<cdpPort>`. This Chrome is completely separate
   from your everyday browser — it has its own history, extensions, and cookies.
   If Chrome is already running on that port, `dev.sh` attaches to it instead of
   launching a second instance.

2. **Starts `error-loop.js`** — the orchestrator that does all the real work.

### 3. Loading extensions in Chrome

Once Chrome is open, each plugin's extension must be loaded manually once:

```
chrome://extensions → Enable Developer mode → Load unpacked → <plugin>/extension/
```

Chrome assigns each loaded-unpacked extension a unique ID (a 32-character
string). This ID appears in all extension URLs:
`chrome-extension://abcdef1234567890abcdef1234567890/sidebar.html`

You only need to load each extension once. Chrome remembers them across
restarts within the same profile.

### 4. Extension ID mapping

At startup, `error-loop.js` reads `registry.json`, loads each plugin's
`dev.config.json` and `extension/manifest.json`, then builds a map from
**extension ID → plugin config**. It does this two ways:

- **Profile scan** — Chrome stores every loaded extension in
  `dev/.chrome-dev-profile/Default/Extensions/<id>/<version>/manifest.json`.
  The orchestrator reads each manifest, matches its `name` field to the plugin
  list, and records the mapping.

- **CDP target titles** — as a fallback, CDP target listings include a `title`
  field (often the extension name) which is matched against the plugin list.

Once this map is built, routing is a single lookup: extract the extension ID
from the error's source URL, look it up in the map, get the plugin.

### 5. Watching for errors

The orchestrator sends two CDP commands to every extension target:

- `Runtime.enable` — stream uncaught JavaScript exceptions
- `Console.enable` — stream `console.error(...)` calls

Chrome pushes these events in real time over WebSocket. The moment an error
fires anywhere in any loaded extension, the orchestrator receives it instantly
with the message, file name, line number, and column.

### 6. Routing to the correct fixer

Once the owning plugin is identified, the orchestrator builds a prompt that
includes:

- The error message and type (exception vs. console.error)
- The file and line number
- ~20 lines of source code surrounding the crash site
- The plugin name, description, and source directories

The prompt is routed to the plugin's configured fixer.

### 7. Fixer: Claude

For plugins with `"fixer": "claude"`, the orchestrator runs:

```
claude -p "<prompt>" --allowedTools Read,Edit,Write [--resume <session-id>]
```

Claude reads the relevant source files, identifies the root cause, and edits
the file directly to fix it. A separate Terminal window opens per fix so you
can follow Claude's reasoning live.

**Session memory** — the first time Claude runs for a plugin, it creates a
session and returns a session ID. The orchestrator saves that ID to
`<plugin>/dev/.claude-session-id`. Every subsequent fix for that plugin resumes
the same session with `--resume <id>`. Claude accumulates full project context
over time — it remembers what it has already read and fixed, and can reference
earlier decisions when debugging related issues.

On the very first fix for a plugin (no session yet), the prompt instructs
Claude to read the plugin's `CLAUDE.md` first to understand the project
structure. This happens only once per session.

To reset Claude's memory for a plugin (e.g. after a major refactor):
```bash
rm <plugin>/dev/.claude-session-id
```

### 8. Fixer: Ollama

For plugins with `"fixer": "ollama:<model>"`, the orchestrator runs:

```
ollama run <model> "<prompt>"
```

The same error context and source snippet is included. Ollama does not maintain
session state, so each fix starts fresh. This is suitable for lightweight fixes
or for working fully offline.

### 9. Reload + verification

After the fixer completes, the orchestrator:

1. **Reloads the specific extension** — finds the service worker target
   belonging to that plugin's extension ID and calls `chrome.runtime.reload()`
   via CDP. Only that plugin's extension reloads; others are unaffected.

2. **Re-attaches watchers** — the reload briefly destroys and recreates the
   extension's CDP targets. The orchestrator waits for them to reappear and
   re-subscribes to errors.

3. **Reproduces the error** — activates the page that originally threw the
   error, so any initialization code runs again.

4. **Watches for 12 seconds** — if the exact same error fires again, the fix
   is considered incomplete. The orchestrator sends the error back to the same
   fixer in the same session, with a note that the previous fix did not work and
   a request for deeper investigation. This retry loop continues until the error
   stops recurring.

---

## Reviewing fixes

### See what files changed
```bash
cd <plugin>
git diff
```
Every fix edits source files directly. `git diff` shows exactly what changed.

### See the fix history for a plugin
```bash
cat <plugin>/dev/.fix-log.jsonl
```
Each line is a JSON record:
```json
{
  "ts": "2026-04-12T10:15:03.123Z",
  "error": "Cannot read properties of null",
  "location": "extension/sidebar.js:42",
  "source": "Sidebar",
  "isRetry": false,
  "claudeExitCode": 0,
  "verified": true
}
```
- `isRetry` — `true` if this was a follow-up after a failed first attempt
- `claudeExitCode` — `0` = success, non-zero = Claude process failed
- `verified` — `true` if the error did not recur within 12s of reload

### See the last prompt sent to a plugin's fixer
```bash
cat <plugin>/dev/.last-prompt.txt
```

### Replay a plugin's Claude session
```bash
cat <plugin>/dev/.claude-session-id    # get the session ID
claude --resume <session-id>           # re-open it interactively
```
The session contains the full back-and-forth — every error Claude was given,
what it read, what it changed, and why.

---

## File map

```
dev/                                   (workspace-level)
├── registry.json                      active plugin list + cdpPort
├── dev.sh                             launches Chrome + starts error-loop.js
├── error-loop.js                      the orchestrator
├── HOW-IT-WORKS.md                    this file
├── dev.config.template.json           template to copy into new plugins
├── .chrome-dev-profile/               sandboxed Chrome profile (auto-created)
└── node_modules/ws/                   WebSocket client (auto-installed)

<plugin>/dev/                          (per-plugin)
├── .claude-session-id                 persisted Claude session ID
├── .fix-log.jsonl                     append-only history of every fix
└── .last-prompt.txt                   the most recent prompt sent to the fixer
```

---

## Config reference

### `dev/registry.json`
```json
{
  "cdpPort": 9222,
  "plugins": [
    { "path": "../Browsky", "fixer": "claude" },
    { "path": "../Doctr",   "fixer": "ollama:llama3" }
  ]
}
```

### `<plugin>/dev.config.json`
```json
{
  "name": "Browsky",
  "description": "One line description",
  "sourceDirs": ["extension", "server"],
  "fixer": "claude"
}
```

- **`sourceDirs`** — directories the fixer is allowed to read and edit
- **`fixer`** — default fixer for this plugin; overridden by `registry.json`
  if both are set (`registry.json` takes precedence)
