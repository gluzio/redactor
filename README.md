# Redactor for Obsidian

> Keep your sensitive data private when using AI. Redact PII from your
> notes before sending to Claude, ChatGPT or any LLM — then restore the
> original locally.

## What it does

Redactor replaces sensitive information in your notes (names, companies,
phone numbers, emails, addresses, dates, tax IDs and more) with placeholder
tokens like `[PERSON_1]` and `[COMPANY_1]`. You paste the redacted text into
any AI chat, get a response back, then use Redactor to swap the tokens back
to the real values — all without your private data ever leaving your machine.

## How it works

1. **Redact** — Run "Redact current note". Redactor scans the note, replaces
   sensitive values with tokens, saves the redacted copy inside your vault,
   and stores a private token map.
2. **Send to LLM** — Paste or open the redacted note. Copy the content into
   Claude, ChatGPT, or any AI tool. The AI sees only tokens, not real data.
3. **Restore** — Paste the AI's response back into Obsidian and run "Restore
   current note from map". Redactor swaps all tokens back to the original
   values and saves the restored note.

## Privacy & Security

- **All local.** No data is sent to any external server, cloud service or
  API. Zero.
- **Localhost only.** The plugin connects only to a Python server
  (`run_phi.py`) running on your own machine at `http://localhost:8765`.
- **Vault-contained.** All output files (redacted notes, restored notes, token
  maps) are saved inside your Obsidian vault using the vault API.
- **Token maps stay private.** The map files (stored at `redact/maps/` by
  default) contain the original sensitive values. Keep them out of any synced
  or public location.

## Requirements

- macOS (Apple Silicon recommended for Phi-3 Deep Scan)
- Python 3.11+
- The Redactor local server must be running before using the plugin

## Setup

### 1. Clone and set up the server

```bash
git clone https://github.com/gluzio/redactor
cd redactor
chmod +x run.sh
./run.sh          # creates venv, installs deps, downloads spaCy model, starts app
```

### 2. Start the local server

In a terminal (or let launchd handle it automatically — see [Local server](#local-server)):

```bash
cd ~/redactor
source .venv/bin/activate
python run_phi.py
```

The server starts on `http://localhost:8765`. The ribbon icon in Obsidian
turns green when it detects the server is running.

### 3. Install the plugin

**Option A — BRAT (recommended while awaiting community listing):**

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat)
2. In BRAT settings → Add Beta Plugin → enter `gluzio/redactor`
3. Enable Redactor in Community Plugins settings

**Option B — Manual:**

```bash
cd ~/redactor/obsidian-plugin
npm install && npm run build
mkdir -p /path/to/vault/.obsidian/plugins/redactor-plugin
cp manifest.json main.js styles.css /path/to/vault/.obsidian/plugins/redactor-plugin/
```

Then enable in **Obsidian → Settings → Community Plugins → Redactor**.

## Commands

Open the command palette with `Cmd+P` and type "Redactor":

| Command | What it does |
|---|---|
| Redact current note | Redact the full active note and open the redacted copy |
| Restore current note from map | Restore tokens in the active note using its map file |
| Redact selected text | Redact only the highlighted text, inline |
| Check Redactor server status | Show server, spaCy and Phi-3 availability |

You can also right-click any `.md` file in the file explorer and choose
**Redact this note**.

## Settings

Open **Settings → Community Plugins → Redactor**:

| Setting | Description | Default |
|---|---|---|
| Server URL | URL of the local run_phi.py server | `http://localhost:8765` |
| Redacted notes folder | Vault path for redacted copies | `redact/redacted` |
| Restored notes folder | Vault path for restored copies | `redact/reversed` |
| Token maps folder | Vault path for map files (keep private) | `redact/maps` |
| Deep Scan (Phi-3) | Use Phi-3 Mini for extra entity detection | Off |

## Detection layers

Redactor runs up to three detection layers on every note:

| Layer | Always runs | What it detects |
|---|---|---|
| **Regex** | Yes | UK phones, postcodes, NI numbers, VAT numbers, emails, dates, URLs, currency amounts |
| **spaCy NER** | Yes | People, organisations, locations (using `en_core_web_lg`) |
| **Phi-3 Mini** | Deep Scan only | Any additional PII found by the local language model |

Results from all layers are merged and deduplicated. The same value always
gets the same token within a session.

## Local server

`run_phi.py` is a lightweight Python HTTP server that keeps models loaded in
memory and handles all redaction logic. It exposes three endpoints:

- `POST /redact` — run all detection layers
- `POST /restore` — swap tokens back
- `GET /status` — health check

**Auto-start on login** (macOS):

```bash
cd ~/redactor
./install_service.sh    # registers a launchd agent
./uninstall_service.sh  # remove it
```

Logs go to `~/Library/Logs/redactor/`.

## FAQ

**Does any data leave my machine?**
No. The plugin connects only to `localhost:8765`. Your notes never leave
your device.

**What if the server isn't running?**
All commands show a clear notice ("Redactor: server offline") and take no
action. No data is sent anywhere.

**Can I use this with vaults synced via iCloud or Obsidian Sync?**
Yes, but keep your `redact/maps/` folder out of sync — it contains the
original sensitive values. Add it to `.gitignore` if you use git.

**Is this on the official community plugins list?**
Submission is pending. Install via BRAT or manually in the meantime.

**Does it work on mobile?**
No. The plugin requires the local Python server and is marked
`isDesktopOnly: true`.

## Manual installation

1. Download the latest release from the GitHub releases page
2. Extract `manifest.json`, `main.js` and `styles.css`
3. Copy them to `<vault>/.obsidian/plugins/redactor-plugin/`
4. Reload Obsidian and enable the plugin in Community Plugins settings

## Contributing

Issues and pull requests welcome at
[https://github.com/gluzio/redactor](https://github.com/gluzio/redactor).

## License

MIT © 2026 Gian Luzio
