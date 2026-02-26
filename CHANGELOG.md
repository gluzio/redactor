# Changelog

All notable changes to Redactor are documented here.

## 1.0.0 — Initial Release

### Added

- **Redact current note** command — detects and tokenises PII in the active
  note using three local detection layers: regex patterns (UK phones,
  postcodes, NI, VAT, emails, dates, URLs, currency), spaCy NER
  (en_core_web_lg), and optional Phi-3 Mini deep scan
- **Restore current note** command — reverses tokenisation using the stored
  local map file, restoring the original sensitive values
- **Redact selected text** command — inline redaction within the editor
  without leaving the current note; merges tokens into the existing map
- **Check server status** command — displays server, spaCy and Phi-3
  availability in a notice
- Ribbon icon with live online/offline colour indicator (green/red)
- Status bar item showing server connection state; click to open settings
- Full settings tab with configurable server URL, folder paths, and Deep
  Scan toggle
- Network usage disclosure in settings explaining that all data stays local
- Non-localhost server URL warning when user changes the server URL
- File explorer context menu item: "Redact this note"
- All file operations use the Obsidian vault API — nothing is written
  outside the vault
- Token maps stored inside the vault at a configurable path
- All data processed locally — no external network requests ever made
