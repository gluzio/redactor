/**
 * NETWORK USAGE DISCLOSURE
 * ─────────────────────────
 * This plugin connects ONLY to a local HTTP server running on the user's own
 * machine (default: http://localhost:8765). No data is ever sent to any
 * external server, cloud service, or third-party API.
 *
 * The local server (run_phi.py) is a Python process the user starts
 * themselves. All PII processing — regex, spaCy NER and optional Phi-3 Mini
 * inference — runs entirely on the user's device.
 *
 * If the user changes the server URL to a non-localhost address, the plugin
 * shows an explicit warning before allowing the change to take effect.
 */

import {
  App,
  Editor,
  FileSystemAdapter,
  MarkdownFileInfo,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
} from "obsidian";

// ── Interfaces ───────────────────────────────────────────────────────────────

interface RedactorSettings {
  serverUrl: string;
  redactFolder: string;
  restoreFolder: string;
  mapsFolder: string;
  deepScan: boolean;
}

interface RedactRequest {
  text: string;
  deep_scan: boolean;
}

interface RedactResponse {
  redacted_text: string;
  map: Record<string, string>;
  entity_counts: Record<string, number>;
}

interface RestoreRequest {
  text: string;
  map: Record<string, string>;
}

interface RestoreResponse {
  restored_text: string;
}

interface StatusResponse {
  status: string;
  spacy: boolean;
  phi3: boolean;
  model: string | null;
}

interface MapFile {
  file: string;
  created: string;
  tokens: Record<string, string>;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: RedactorSettings = {
  serverUrl: "http://localhost:8765",
  redactFolder: "redact/redacted",
  restoreFolder: "redact/reversed",
  mapsFolder: "redact/maps",
  deepScan: false,
};

const LABEL_DISPLAY: Record<string, string> = {
  PERSON: "names",
  COMPANY: "companies",
  PHONE: "phones",
  EMAIL: "emails",
  ADDRESS: "locations",
  POSTCODE: "postcodes",
  TAX: "tax IDs",
  NI: "NI numbers",
  DATE: "dates",
  URL: "URLs",
  CURRENCY: "amounts",
};

function isLocalUrl(url: string): boolean {
  return (
    url.startsWith("http://localhost") ||
    url.startsWith("http://127.0.0.1")
  );
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default class RedactorPlugin extends Plugin {
  settings!: RedactorSettings;
  serverOnline = false;

  async onload(): Promise<void> {
    // Desktop-only guard (belt-and-suspenders alongside manifest flag)
    if (Platform.isMobile) {
      new Notice("Redactor is a desktop-only plugin.");
      return;
    }

    await this.loadSettings();

    // ── Ribbon icon ───────────────────────────────────────────────────────
    const ribbon = this.addRibbonIcon(
      "shield",
      "Redactor: Redact current note",
      async () => this.redactCurrentNote()
    );
    ribbon.addClass("redactor-ribbon");

    // ── Status bar ────────────────────────────────────────────────────────
    const statusBar = this.addStatusBarItem();
    statusBar.addClass("redactor-status-bar");
    statusBar.setText("🔒 Redactor: checking…");
    statusBar.onClickEvent(() => {
      // Open plugin settings — internal Obsidian API (no public type)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const setting = (this.app as Record<string, any>)["setting"];
      if (setting) {
        setting.open();
        setting.openTabById("redactor-plugin");
      }
    });

    // Store refs so updateServerStatus can reach them
    this._ribbon = ribbon;
    this._statusBar = statusBar;

    // ── Commands ──────────────────────────────────────────────────────────
    this.addCommand({
      id: "redactor-redact-note",
      name: "Redact current note",
      callback: () => void this.redactCurrentNote(),
    });

    this.addCommand({
      id: "redactor-restore-note",
      name: "Restore current note from map",
      callback: () => void this.restoreCurrentNote(),
    });

    this.addCommand({
      id: "redactor-redact-selection",
      name: "Redact selected text",
      editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) =>
        void this.redactSelectedText(editor, ctx),
    });

    this.addCommand({
      id: "redactor-check-status",
      name: "Check Redactor server status",
      callback: () => void this.checkServerStatus(),
    });

    // ── File explorer context menu ────────────────────────────────────────
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, abstractFile) => {
        if (abstractFile instanceof TFile && abstractFile.extension === "md") {
          menu.addItem((item) => {
            item
              .setTitle("Redact this note")
              .setIcon("shield")
              .onClick(() => void this.redactFile(abstractFile));
          });
        }
      })
    );

    // ── Settings tab ──────────────────────────────────────────────────────
    this.addSettingTab(new RedactorSettingsTab(this.app, this));

    // ── Status polling — registerInterval auto-clears on unload ──────────
    await this.updateServerStatus();
    this.registerInterval(
      window.setInterval(() => void this.updateServerStatus(), 30_000)
    );
  }

  // onunload() is not overridden: the Plugin base class automatically cleans
  // up all ribbon icons, status bar items, registered events, registered
  // intervals, commands, and setting tabs added via the typed Plugin APIs.

  // ── Private UI refs (set in onload) ──────────────────────────────────────
  private _ribbon!: HTMLElement;
  private _statusBar!: HTMLElement;

  // ── Core command implementations ──────────────────────────────────────────

  async redactCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file.");
      return;
    }
    await this.redactFile(file);
  }

  async redactFile(file: TFile): Promise<void> {
    if (!this.assertOnline()) return;

    let text: string;
    try {
      text = await this.app.vault.read(file);
    } catch (err) {
      console.error("Redactor: failed to read file", err);
      new Notice(`Redactor: could not read ${file.name}`);
      return;
    }

    let response: RedactResponse;
    try {
      const body: RedactRequest = { text, deep_scan: this.settings.deepScan };
      const res = await requestUrl({
        url: `${this.settings.serverUrl}/redact`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      response = res.json as RedactResponse;
    } catch (err) {
      console.error("Redactor: /redact request failed", err);
      new Notice("Redactor: server offline — start run_phi.py first");
      this.serverOnline = false;
      this.refreshStatusUI();
      return;
    }

    try {
      const redactedPath = `${this.settings.redactFolder}/${file.name}`;
      const redactedFile = await this.saveVaultFile(
        redactedPath,
        response.redacted_text
      );

      const mapData: MapFile = {
        file: file.name,
        created: new Date().toISOString(),
        tokens: response.map,
      };
      const mapPath = `${this.settings.mapsFolder}/${file.name}.map.json`;
      await this.saveVaultFile(mapPath, JSON.stringify(mapData, null, 2));

      const summary = this.buildCountSummary(response.entity_counts);
      new Notice(summary);
      await this.app.workspace.getLeaf("tab").openFile(redactedFile);
    } catch (err) {
      console.error("Redactor: failed to save redacted file", err);
      new Notice("Redactor: could not save output files.");
    }
  }

  async restoreCurrentNote(): Promise<void> {
    if (!this.assertOnline()) return;

    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file.");
      return;
    }

    const mapPath = `${this.settings.mapsFolder}/${file.name}.map.json`;
    const mapAbstract = this.app.vault.getAbstractFileByPath(mapPath);

    if (!(mapAbstract instanceof TFile)) {
      new Notice(`No map found for "${file.name}" — redact it first`);
      return;
    }

    let mapData: MapFile;
    try {
      const mapRaw = await this.app.vault.read(mapAbstract);
      mapData = JSON.parse(mapRaw) as MapFile;
    } catch (err) {
      console.error("Redactor: failed to read map file", err);
      new Notice("Redactor: map file is missing or corrupted.");
      return;
    }

    let text: string;
    try {
      text = await this.app.vault.read(file);
    } catch (err) {
      console.error("Redactor: failed to read file", err);
      new Notice(`Redactor: could not read ${file.name}`);
      return;
    }

    let response: RestoreResponse;
    try {
      const body: RestoreRequest = { text, map: mapData.tokens };
      const res = await requestUrl({
        url: `${this.settings.serverUrl}/restore`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      response = res.json as RestoreResponse;
    } catch (err) {
      console.error("Redactor: /restore request failed", err);
      new Notice("Redactor: server offline — start run_phi.py first");
      this.serverOnline = false;
      this.refreshStatusUI();
      return;
    }

    try {
      const restoredPath = `${this.settings.restoreFolder}/${file.name}`;
      const restoredFile = await this.saveVaultFile(
        restoredPath,
        response.restored_text
      );
      new Notice(`Restored "${file.name}" successfully`);
      await this.app.workspace.getLeaf("tab").openFile(restoredFile);
    } catch (err) {
      console.error("Redactor: failed to save restored file", err);
      new Notice("Redactor: could not save restored file.");
    }
  }

  async redactSelectedText(
    editor: Editor,
    ctx: MarkdownView | MarkdownFileInfo
  ): Promise<void> {
    if (!this.assertOnline()) return;

    const selection = editor.getSelection();
    if (!selection) {
      new Notice("No text selected.");
      return;
    }

    const file = ctx.file;
    if (!file) {
      new Notice("No active file.");
      return;
    }

    let response: RedactResponse;
    try {
      const body: RedactRequest = {
        text: selection,
        deep_scan: this.settings.deepScan,
      };
      const res = await requestUrl({
        url: `${this.settings.serverUrl}/redact`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      response = res.json as RedactResponse;
    } catch (err) {
      console.error("Redactor: /redact request failed", err);
      new Notice("Redactor: server offline — start run_phi.py first");
      this.serverOnline = false;
      this.refreshStatusUI();
      return;
    }

    editor.replaceSelection(response.redacted_text);

    // Merge into existing map for this note, or create a new one
    try {
      const mapPath = `${this.settings.mapsFolder}/${file.name}.map.json`;
      const existing = this.app.vault.getAbstractFileByPath(mapPath);
      let existingTokens: Record<string, string> = {};
      if (existing instanceof TFile) {
        try {
          const raw = await this.app.vault.read(existing);
          existingTokens = (JSON.parse(raw) as MapFile).tokens ?? {};
        } catch {
          // corrupt map — start fresh
        }
      }
      const mapData: MapFile = {
        file: file.name,
        created: new Date().toISOString(),
        tokens: { ...existingTokens, ...response.map },
      };
      await this.saveVaultFile(mapPath, JSON.stringify(mapData, null, 2));
    } catch (err) {
      console.error("Redactor: failed to save map", err);
      new Notice("Redactor: selection redacted but map save failed.");
      return;
    }

    const total = Object.values(response.entity_counts).reduce(
      (a, b) => a + b,
      0
    );
    new Notice(
      total === 0 ? "No entities found in selection" : `Redacted ${total} entities in selection`
    );
  }

  async checkServerStatus(): Promise<void> {
    try {
      const res = await requestUrl({
        url: `${this.settings.serverUrl}/status`,
        method: "GET",
      });
      const data = res.json as StatusResponse;
      new Notice(
        [
          "Redactor server: online",
          `spaCy:  ${data.spacy ? "✓ ready" : "✗ not loaded"}`,
          `Phi-3:  ${data.phi3 ? `✓ ready (${data.model ?? ""})` : "✗ not loaded"}`,
        ].join("\n"),
        8000
      );
    } catch {
      new Notice(
        "Redactor server: offline\n\nStart run_phi.py to enable all features.",
        6000
      );
    }
  }

  // ── Server status UI ──────────────────────────────────────────────────────

  async updateServerStatus(): Promise<void> {
    try {
      await requestUrl({
        url: `${this.settings.serverUrl}/status`,
        method: "GET",
      });
      this.serverOnline = true;
    } catch {
      this.serverOnline = false;
    }
    this.refreshStatusUI();
  }

  private refreshStatusUI(): void {
    if (this.serverOnline) {
      this._statusBar.setText("🔒 Redactor: online");
      this._statusBar.removeClass("redactor-status-bar--offline");
      this._statusBar.addClass("redactor-status-bar--online");
      this._ribbon.style.color = "var(--color-green)";
    } else {
      this._statusBar.setText("🔒 Redactor: offline");
      this._statusBar.removeClass("redactor-status-bar--online");
      this._statusBar.addClass("redactor-status-bar--offline");
      this._ribbon.style.color = "var(--color-red)";
    }
  }

  // ── Vault helpers ─────────────────────────────────────────────────────────

  private async ensureFolder(folderPath: string): Promise<void> {
    if (!folderPath) return;
    const parts = folderPath.split("/").filter((p) => p.length > 0);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const exists = await this.app.vault.adapter.exists(current);
      if (!exists) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // race condition — another call may have created it already
        }
      }
    }
  }

  async saveVaultFile(path: string, content: string): Promise<TFile> {
    const folderPath = path.includes("/")
      ? path.substring(0, path.lastIndexOf("/"))
      : "";
    if (folderPath) await this.ensureFolder(folderPath);

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return existing;
    }
    return await this.app.vault.create(path, content);
  }

  // ── Guards ────────────────────────────────────────────────────────────────

  private assertOnline(): boolean {
    if (!this.serverOnline) {
      new Notice("Redactor: server offline — start run_phi.py first");
      return false;
    }
    return true;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private buildCountSummary(counts: Record<string, number>): string {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) return "Redacted: no entities found";
    const parts: string[] = [];
    for (const [label, n] of Object.entries(counts)) {
      if (n > 0) parts.push(`${n} ${LABEL_DISPLAY[label] ?? label.toLowerCase()}`);
    }
    return `Redacted: ${parts.join(", ")}`;
  }

  // ── Settings persistence ──────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<RedactorSettings>
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

// ── Settings tab ─────────────────────────────────────────────────────────────

class RedactorSettingsTab extends PluginSettingTab {
  plugin: RedactorPlugin;

  constructor(app: App, plugin: RedactorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("redactor-settings");

    containerEl.createEl("h2", { text: "Redactor" });
    containerEl.createEl("p", {
      text: "All redaction happens locally. The plugin connects only to the server URL below, which should be a local Python process you control.",
      cls: "redactor-settings__description",
    });

    // ── Server settings ───────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Server" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc(
        "URL of the local run_phi.py server. Change this only if you've moved the server to a different port. Must start with http://localhost or http://127.0.0.1."
      )
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8765")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!isLocalUrl(trimmed)) {
              new Notice(
                "⚠️ Warning: The server URL is not localhost. " +
                "Your note content will be sent to that address. " +
                "Make sure you trust and control that server.",
                10_000
              );
            }
            this.plugin.settings.serverUrl = trimmed;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify the server is reachable and check which models are loaded")
      .addButton((btn) =>
        btn.setButtonText("Test Connection").onClick(async () => {
          btn.setButtonText("Testing…");
          btn.setDisabled(true);
          await this.plugin.checkServerStatus();
          await this.plugin.updateServerStatus();
          btn.setButtonText("Test Connection");
          btn.setDisabled(false);
          this.display();
        })
      );

    // Server status indicator
    const statusRow = containerEl.createDiv({ cls: "redactor-settings__status-row" });
    const dot = statusRow.createSpan();
    dot.addClass(
      this.plugin.serverOnline ? "redactor-dot-online" : "redactor-dot-offline"
    );
    statusRow.createSpan({
      text: ` Server: ${this.plugin.serverOnline ? "online" : "offline"}`,
    });

    // ── Folder settings ───────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Vault folders" });

    new Setting(containerEl)
      .setName("Redacted notes folder")
      .setDesc(
        "Vault-relative path where redacted copies of your notes are saved. " +
        "Created automatically if it does not exist."
      )
      .addText((text) =>
        text
          .setPlaceholder("redact/redacted")
          .setValue(this.plugin.settings.redactFolder)
          .onChange(async (value) => {
            this.plugin.settings.redactFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Restored notes folder")
      .setDesc(
        "Vault-relative path where restored notes (after LLM processing) are saved."
      )
      .addText((text) =>
        text
          .setPlaceholder("redact/reversed")
          .setValue(this.plugin.settings.restoreFolder)
          .onChange(async (value) => {
            this.plugin.settings.restoreFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Token maps folder")
      .setDesc(
        "Vault-relative path where token map files are stored. " +
        "These files contain the original sensitive values — keep this folder private."
      )
      .addText((text) =>
        text
          .setPlaceholder("redact/maps")
          .setValue(this.plugin.settings.mapsFolder)
          .onChange(async (value) => {
            this.plugin.settings.mapsFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Open in Finder
    new Setting(containerEl)
      .setName("Open redacted folder in Finder")
      .setDesc("Reveal the folder containing redacted files on disk")
      .addButton((btn) =>
        btn.setButtonText("Open in Finder").onClick(() => {
          const adapter = this.app.vault.adapter;
          if (adapter instanceof FileSystemAdapter) {
            const fullPath = adapter.getFullPath(
              this.plugin.settings.redactFolder
            );
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            (require("electron") as { shell: { openPath(p: string): void } }).shell.openPath(fullPath);
          } else {
            new Notice("Cannot determine vault path on this platform.");
          }
        })
      );

    // ── Detection settings ────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Detection" });

    new Setting(containerEl)
      .setName("Deep Scan (Phi-3 Mini)")
      .setDesc(
        "When enabled, the local Phi-3 Mini language model also scans the text " +
        "for additional PII beyond what regex and spaCy find. Slower but more thorough. " +
        "Requires the Phi-3 model to be downloaded (~2 GB, cached automatically on first use)."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.deepScan).onChange(async (value) => {
          this.plugin.settings.deepScan = value;
          await this.plugin.saveSettings();
        })
      );

    // ── Privacy disclosure ────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Privacy & network usage" });

    const disclosure = containerEl.createDiv({ cls: "redactor-settings__disclosure" });
    disclosure.createEl("p", {
      text: "This plugin does not connect to the internet. It connects only to the server URL above, which must be a local Python process (run_phi.py) running on your own machine.",
    });
    disclosure.createEl("p", {
      text: "Your note content is sent to that local server for processing and is never transmitted beyond your device. Token maps containing the original sensitive values are stored inside your vault.",
    });
  }
}
