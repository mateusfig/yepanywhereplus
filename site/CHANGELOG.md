# Website Changelog

All notable changes to the Yep Anywhere website and remote relay client will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [site-v1.5.19] - 2026-03-03

### Added
- Per-article Open Graph image support in ArticleLayout
- Custom OG image for remote device control blog post

## [site-v1.5.18] - 2026-03-03

### Added
- Blog post: Android Dev Without a Desktop — Remote Device Control
- Device control feature card on homepage
- Device stream screenshot in homepage and README galleries
- Screenshots: device sidebar, device list, device stream, device settings

### Changed
- Homepage announcement banner now promotes remote device control

## [site-v1.5.17] - 2026-02-27

### Added
- New article: "What I Learned from the OpenClaw Guy's AI Coding Workflow"
- All news items now expanded by default on news page

## [site-v1.5.16] - 2026-02-25

### Fixed
- Fix spectrum diagram rendering: use ASCII arrows instead of variable-width em dashes
- Add proper pre/code block styling so text aligns with clean right edge

## [site-v1.5.15] - 2026-02-25

### Fixed
- Fix .html URLs serving blank page (remote SPA 404 fallback instead of actual page)
- Switch Astro to `build.format: "file"` so pages output as .html files directly
- Remove obsolete meta-refresh redirect stubs from public/

## [site-v1.5.14] - 2026-02-25

### Fixed
- Hide Screenshots, Features, and FAQ nav links on mobile to prevent header overflow

## [site-v1.5.13] - 2026-02-25

### Added
- Light/dark mode toggle in header with system theme default
- Light theme CSS variables with proper contrast
- Theme preference persisted to localStorage across page loads

### Fixed
- Hardcoded hex colors in announcement gradient and comparison table now use CSS variables

## [site-v1.5.12] - 2026-02-25

### Fixed
- Thinking mode toggle now persists correctly in localStorage
- Stream reconnects automatically after thinking-mode process restart
- "On" thinking mode uses adaptive + effort (avoids CLI crash on Opus 4.6)

## [site-v1.5.11] - 2026-02-25

### Added
- Blog post: Five Ways to Access AI Subscriptions Programmatically
- News page entry for subscription access approaches article

## [site-v1.5.9] - 2026-02-25

### Changed
- Migrate website from plain HTML to Astro

### Added
- Subscription access approaches page

## [site-v1.5.8] - 2026-02-25

### Changed
- Improve homepage comparison section heading

## [site-v1.5.7] - 2026-02-25

### Added
- Homepage: Remote Control comparison section and updated announcement banner

## [site-v1.5.6] - 2026-02-25

### Changed
- Update connectivity comparison: hosted relay parity, telemetry privacy, no extra install

## [site-v1.5.5] - 2026-02-25

### Added
- Feature comparison table and TLDR summary on Remote Control blog post

## [site-v1.5.4] - 2026-02-24

### Added
- Blog post: Claude Code Remote Control vs Yep Anywhere

## [site-v1.5.3] - 2026-02-23

### Added
- Blog post: Google banning subscribers for using OpenClaw

## [site-v1.5.2] - 2026-02-22

### Added
- Codex shell tool rendering for grep/read workflows

### Fixed
- Fix HTTP LAN access: randomUUID fallback for insecure contexts and non-secure cookie handling
- Lazy-load tssrp6a to fix crash on HTTP LAN access (insecure context)
- Auth disable now clears credentials and simplifies enable flow

## [site-v1.5.1] - 2026-02-22

### Fixed
- Fix send racing ahead of in-flight file uploads
- Improve pending tool render and tighten settings copy

## [site-v1.5.0] - 2026-02-22

### Security
- Harden auth enable flow and add secure recovery path
- Harden relay replay protection for SRP sessions
- Harden session resume replay defenses for untrusted relays
- Patch vulnerable dependencies (bn.js)

### Added
- Legacy relay protocol compatibility for old servers
- Global agent instructions setting for cross-project context
- Permission rules for session bash command filtering
- Safe area insets for Tauri mobile edge-to-edge mode

### Fixed
- Guard SecureConnection send when WebSocket global is unavailable
- Stop reconnect loop on intentional remote disconnect
- Fix stale reconnect race and reduce reconnect noise

### Changed
- Default remote sessions to memory with dev persistence toggle
- Warn relay users about resume protocol mismatch
- Improve server update modal copy and layout

## [site-v1.4.2] - 2026-02-19

### Changed
- Polish value prop copy (disconnect card, approval urgency, encryption claim)
- Brighten feature card link color for better contrast on dark backgrounds

## [site-v1.4.1] - 2026-02-19

### Changed
- Rewrite relay value prop and feature card to highlight free relay access (no Tailscale/VPN needed)
- Restore "Log In to Your Server" as secondary CTA in hero
- Update hero screenshot caption to "Fix issues from anywhere"

### Added
- Desktop remote access settings screenshot

## [site-v1.4.0] - 2026-02-19

### Changed
- Rewrite hero headline and subhead to be outcome-driven ("Walk away. Your agents keep shipping.")
- Make "Get Started" the primary CTA, move "Log In" to nav only
- Rewrite value prop cards to match marketing pillars: seamless handoff, survive disconnects, lock-screen approvals, dashboard, self-hosted encryption
- Tighten all value prop copy

### Added
- Hero showcase with two phone screenshots (approve edit, completed session)
- TOS compliance feature card with link to SDK docs
- README TOS compliance section

## [site-v1.3.2] - 2026-02-19

### Added
- Blog post: The Agent SDK Auth Scare (and Why You're Fine)

### Changed
- Update Jan 11 compliance post to reflect that we don't handle auth at all

## [site-v1.3.1] - 2026-02-18

### Fixed
- Fix Codex provider labeling (CLI, not Desktop)

## [site-v1.3.0] - 2026-02-18

### Changed
- Highlight Codex CLI as fully supported alongside Claude Code
- Update hero, announcement banner, features, and FAQ for multi-provider messaging
- Update page title and meta description to mention Codex

## [site-v1.2.0] - 2026-02-16

### Added
- Blog post: OpenClaw and Yep Anywhere — Two Paths to the Same Future
- News entry linking to the blog post

### Fixed
- Link color in news item metadata now uses green accent

## [site-v1.1.0] - 2025-02-13

### Fixed
- Remove relay login redirect routes that dropped query params and hash fragments

## [site-v1.0.0] - 2025-02-01

### Added
- Initial tagged release
- Landing page, privacy policy, ToS compliance docs
- Remote relay client at /remote
- Public relay documentation
