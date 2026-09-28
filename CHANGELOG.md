# Changelog

## [1.0.15] - 2026-09-28

### Added
- Standard `CHANGELOG.md` tracking repository release history according to Keep a Changelog.
- Added `dev` script (`pi --extension ./vision-watcher.ts`) to `package.json` for live local testing without installation.

### Changed
- Refreshed README presentation layout, badge aesthetics, and structure to match the standard `pi-arnative` specification.
- Streamlined README commands and shortcuts tables, tightened bullet copywriting, and repaired link icon character.
- Standardized README tagline (`Intelligent vision watcher. Connected models. Zero workflow interruption.`) and `package.json` description to use vision watcher identity.
- Refreshed package keywords and repository topics to focus on vision-watcher, image-describer, and failover capabilities (purged legacy handoff tags).
- Standardized README banner image to full-width responsive `<img width="100%">` matching `pi-jev-eye`.
- Updated `pi.image` manifest URL to `assets/banner.webp`.
- Registered `CHANGELOG.md` and `LICENSE` in `package.json` `"files"` packaging list.

### Fixed
- Fixed model picker detail pane hanging wrapped values and aligned filter input field with the list gutter.

---

## [1.0.14] - 2026-09-22

### Changed
- Tightened picker header by removing empty spacing between top border and dialog title.
- Updated picker footer legend to use clean `[Key] Action` layout with colored accent highlighting for model counter.

---

## [1.0.13] - 2026-09-22

### Added
- Added `ctrl+shift+q` shortcut to reset the entire fallback model chain in one keystroke.

### Changed
- Polished picker footer spacing and legend descriptions.

---

## [1.0.12] - 2026-09-22

### Added
- Footer key legend in the interactive picker with clear separator formatting.

---

## [1.0.11] - 2026-09-12

### Added
- In-picker failover chain configuration (`ctrl+q` / `f2`) with real-time preview in the detail pane.
- Auto-healing and detection for GLM 4/5 false-vision and provider HTTP 400 errors.

### Changed
- Major model picker architecture overhaul with connected-only provider credentials filtering.

---

## [1.0.0] - 2026-08-21

### Added
- Initial standalone release of `pi-vision-watcher` providing intelligent vision handoff to text-only coding models in Pi.
