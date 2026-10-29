<div align="center">

<img src="docs/images/icon.png" width="96" alt="desk-pet icon">

# desk-pet

**A pixel-art desktop pet framework for Windows 11**

Characters that live on your desktop: they walk on your windows, hide behind them, react when you poke them,<br>and — if you want — talk and decide what to do next with an LLM.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?logo=windows)
![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)

**English** · [中文](README.zh-CN.md)

<img src="docs/images/mage-walk.gif" height="150" alt="walking"> <img src="docs/images/mage-wave.gif" height="150" alt="waving"> <img src="docs/images/mage-cast.gif" height="150" alt="casting"> <img src="docs/images/mage-jump.gif" height="150" alt="jumping">

<sub>The bundled demo character, <b>Mage</b> (<code>packs/mage/</code>)</sub>

</div>

---

## Features

- **Desktop world**: walks on the floor, the taskbar and window top edges; jumps between surfaces; enters windows it can get back out of; follows windows when you move or resize them (event-driven, with a 1 s fallback scan).
- **Hiding and covering**: hides behind windows and peeks out; reacts when another window covers it (peek, stay hidden, walk out); being uncovered counts as being "discovered".
- **Interaction**: click, stroke (press and move), pick up, drag and throw with physics. Reactions are data (`behaviors.json`), not code.
- **Behavior system**: weighted behaviors with JSON Logic conditions, cooldowns, stats (stamina, mood, ...), relations, multi-step plans, unlock rules. Multiple characters on screen at once; choose who is on the desktop from the tray.
- **Polite by default**: auto-hides for full-screen apps and Windows Do Not Disturb, a boss key (`Ctrl+Alt+H`), "user is away" detection (lock screen / idle), pausing.
- **LLM (optional, off by default)**: any OpenAI-compatible Chat Completions endpoint writes the lines; an optional decision model picks from the actions the rules allow, and the program validates and executes them. Each character has its own conversation and long-term memory summary (`data/memory.sqlite`). Speech bubbles with Animal-Crossing-style blips instead of TTS. Optional screen viewing (off by default; the picture is kept in memory only). Hourly request / daily spend limits and a usage page.
- **Settings window** in Chinese and English (i18next), tray menu for the common switches, start on login (off by default).
- **Everything stays in the project folder**: Electron's user data, caches and logs are redirected from `%APPDATA%` to `data/` and `logs/`.

## Settings window

<p align="center">
  <img src="docs/images/settings-light-characters.png" width="49%" alt="settings, light">
  <img src="docs/images/settings-dark-ai.png" width="49%" alt="settings, dark">
  <br><sub>Settings in English / Chinese, light / dark</sub>
</p>

## Requirements

- Windows 10/11 (uses Win32 APIs through [koffi](https://koffi.dev/) for window geometry, z-order and DND state)
- Node.js 24+ (TypeScript runs directly through Node's type stripping; `node:sqlite` is used for memory/usage)

## Quick start

```powershell
git clone https://github.com/zeroa234/desk-pet.git
cd desk-pet
npm install
npm start
```

The Mage appears on your desktop and a tray icon shows up. Right-click the tray icon for the menu, or open **Settings**.

Optional:

```powershell
npm run shortcut        # creates desk-pet.lnk in the project folder (double-click to start; double-click again opens Settings)
npm test                # unit tests
npm run typecheck       # tsc, no emit
npm run validate:packs  # checks every pack under packs/
```

## Enabling the LLM

1. Edit `config/llm.json`: set `baseUrl` / `model` for each provider (any OpenAI-compatible Chat Completions service works). `routes` maps each kind of request (line, reply, reaction, ...) to a provider; `decision` is the optional decision model.
2. Provide the key through the environment variable named in `keyEnv` (default `OLLAMA_API_KEY`), or in `config/secrets.local.json` as `{"<secretName>": {"api_key": "..."}}`. `*.local.*` files are git-ignored. Keys are never sent to the renderer or written to logs.
3. Turn on the LLM in the tray menu or Settings. Personas live in `packs/<id>/persona-sfw.md` and can be edited in Settings.

## Making your own character

A character is a folder under `packs/<id>/`: a `pack.json` manifest, pre-rendered sprite sheets (`sprites/<variant>/<outfit>/<action>-<facing>.png|.json`), and a hand-written `behaviors.json`. See [`docs/pack-format.md`](docs/pack-format.md). Run `npm run validate:packs` after adding one.

The exporter that renders sprite sheets from 3D models is not part of this first release.

## Project layout

```
src/
  main/       Electron main process: simulation (sim.ts), windows, tray, settings, desktop tracking
  behavior/   state machine (actor), behavior selection (brain, mind), shared types
  world/      supports (floor, window edges), navigation, visibility
  platform/   Win32 bindings (window list, z-order, DND, input idle)
  stage/      renderer for the transparent overlay windows
  settings/   settings window (plain DOM + i18next)
  llm/        providers, request queue, dialogue, decisions, memory, usage
  vision/     optional screen viewing
  sound/      sound scheduling and speech blips
  pack/       pack loading and validation
  locales/    zh-CN / en strings
tests/        node:test unit tests (fake desktops, fake packs)
packs/mage/   demo character (see NOTICE.md)
```

## Notes

- The engine contains an adult-content mode switch from the project it was extracted from. It is **off by default**, and this repository ships **no adult assets**; with the demo pack the switch has no visible effect.
- Characters must be marked `"adult": true` in `pack.json` (it means "the character is an adult"); packs without it are refused.
- Most code comments are in Chinese. Some comments were removed for the public release and are marked `（开源版省略）` ("omitted in the open-source edition").

## License

Code: MIT (see `LICENSE`). The demo pack `packs/mage/` is **not** MIT; see [`NOTICE.md`](NOTICE.md).
