# Alacritty Manager (Tauri)

A Tauri desktop manager with a macOS-inspired liquid-glass UI for server profiles.

## Design goals

- Apple-like translucent layered surfaces
- Fast profile workflow (search, edit, connect)
- Keep terminal runtime separate from manager UI

## Run

```bash
cd manager-tauri
npm install
npm run tauri dev
```

## Root build integration

From the repository root, `make app` now builds both:

- `target/release/osx/Alacritty.app`
- `target/release/osx/Alacritty Manager.app`

## Build

```bash
cd manager-tauri
npm install
npm run tauri build
```

## MVP profile format

- Add dialog expects: `name,host,user,password(optional)`
- Password is currently stored in plaintext `profiles.json` for speed (MVP)
- Launches `alacritty -e ssh ...`
- If password exists, launches with `sshpass` command path

## Next UX polish suggestions

- Frosted navigation toolbar with traffic-light controls spacing
- Host avatars / environment color chips
- Connection health badge + latency ping
- Reorderable favorite groups with spring animations
- Keychain-based password storage for production
