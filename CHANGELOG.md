# Changelog

## [1.1.0] - 2026-10-05

### Changed
- **Breaking:** rebind four picker chords that collided with OS, terminal, readline and Pi
  shortcuts. VTE (GNOME Terminal) closes the window on `ctrl+shift+q`, and POSIX tty flow
  control swallows `ctrl+q`, so the previous bindings were unusable or destructive on Linux:
  - `ctrl+q` → `ctrl+enter` (failover chain toggle)
  - `ctrl+shift+q` → `ctrl+shift+r` (reset failover chain)
  - `ctrl+a` → `alt+a` · `ctrl+alt+a` (async paste handoff)
  - `ctrl+t` → `ctrl+shift+t` (thinking ladder)
- Vision and failover markers now use single-cell glyphs (`✦`, `⇆`) instead of emoji, which
  are double-width and broke column alignment. The symbols in the detail pane carry the same
  colour as the badges they explain.
- Detail pane labels read `Vision-capable ✦ :` / `Fallback ⇆ :` and the async row prints its
  own chord beside the state.
- `package.json` `description` now leads with the README tagline, per the `/arnative-pi`
  manifest standard — `pi.dev/packages` renders this field verbatim as the package card
  description. (Previously staged as `[Unreleased]` in PR #1.)

### Added
- `alt+↑` / `alt+↓` reorder the highlighted model; the failover chain follows list order and
  the `None` row stays pinned first.

### Fixed
- Pressing `enter` while a filter was active silently saved the previously selected primary,
  which the user could not see in the filtered list. `enter` now adopts the highlighted match.
- Removed the `f2` binding from the README; it was documented but never implemented.

### Notes
- The three `ctrl+` chords are no-ops on legacy terminals that do not speak the Kitty Keyboard
  Protocol (no wrong action fires). They work on Windows Terminal/conhost, X11, macOS, tmux
  and SSH.
- `ctrl+alt+a` is the international-layout-safe half of the async chord, where AltGr occupies
  `alt+a`.

---

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
