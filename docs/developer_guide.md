# Developer Guide: Where to Implement New Features

This document is for contributors who want to add or change behavior in
Alacritty and need a reliable map of *which file/module should own the change*.

For deeper crate-internal ownership, see module guides:

- `docs/modules/alacritty.md`
- `docs/modules/alacritty_terminal.md`
- `docs/modules/alacritty_config.md`

## Workspace architecture

Alacritty is split into focused crates:

| Crate | Responsibility | Primary entry points |
| --- | --- | --- |
| `alacritty` | App/runtime layer: windows, input, rendering, config loading, IPC, CLI integration | `alacritty/src/main.rs`, `alacritty/src/event.rs`, `alacritty/src/window_context.rs` |
| `alacritty_terminal` | Terminal emulation core: ANSI handling, grid, search, selection, PTY I/O loop | `alacritty_terminal/src/term/mod.rs`, `alacritty_terminal/src/event_loop.rs`, `alacritty_terminal/src/tty/mod.rs` |
| `alacritty_config` | Shared config replacement helpers | `alacritty_config/src/lib.rs` |
| `alacritty_config_derive` | Proc-macros for config derive behavior | `alacritty_config_derive/src/lib.rs` |

### Runtime flow (high-level)

1. `alacritty/src/main.rs` parses CLI/config and creates the app event loop.
2. `alacritty/src/event.rs` (`Processor`) owns app-level event routing.
3. Each window is represented by `WindowContext` in
   `alacritty/src/window_context.rs`.
4. Each `WindowContext` creates:
   - a terminal core (`Term`) from `alacritty_terminal`, and
   - a PTY I/O thread (`PtyEventLoop`) from
     `alacritty_terminal/src/event_loop.rs`.
5. PTY bytes are parsed into terminal state updates in
   `alacritty_terminal/src/term/mod.rs`; UI events are sent back to app layer.
6. Rendering is performed by `Display`/`Renderer` in `alacritty/src/display/*`
   and `alacritty/src/renderer/*`.

## Feature-to-file routing

Use this section first when planning a change.

### 1) Escape sequences, terminal modes, text semantics

Use when changing ANSI/OSC/CSI/DCS behavior, screen state, cursor state,
selection semantics, hyperlink storage, etc.

- Primary file: `alacritty_terminal/src/term/mod.rs`
  - `impl Handler for Term<T>` is where parsed control functions are applied.
- Supporting files:
  - `alacritty_terminal/src/term/cell.rs` (cell attributes/hyperlink metadata)
  - `alacritty_terminal/src/term/color.rs` (indexed color storage)
  - `alacritty_terminal/src/grid/mod.rs` (grid behavior/scrollback)
- Docs/tests to update:
  - `docs/escape_support.md`
  - `alacritty_terminal/tests/ref.rs` and `alacritty_terminal/tests/ref/*`

### 2) Keyboard/mouse actions and keybindings

Use when adding a new action users can bind, or changing trigger behavior.

- Action enums/default bindings:
  - `alacritty/src/config/bindings.rs`
- Action execution:
  - `alacritty/src/input/mod.rs` (`Execute` impl for `Action`)
- Key processing and sequence emission:
  - `alacritty/src/input/keyboard.rs`
- App context methods backing actions:
  - `alacritty/src/event.rs` (`ActionContext` impl)

### 3) Search (normal search + vi/search integration)

- Regex engine/search iteration:
  - `alacritty_terminal/src/term/search.rs`
- Search mode state/timers/origin behavior:
  - `alacritty/src/event.rs` (`SearchState`, search methods)
- Search key interactions:
  - `alacritty/src/input/mod.rs`
  - `alacritty/src/input/keyboard.rs`

### 4) Vi mode motions and selection mechanics

- Vi cursor motions:
  - `alacritty_terminal/src/vi_mode.rs`
- Selection state/range behavior:
  - `alacritty_terminal/src/selection.rs`
- Term integration points:
  - `alacritty_terminal/src/term/mod.rs`

### 5) Hints, hyperlink detection, URL opening behavior

- Hint matching/highlighting state:
  - `alacritty/src/display/hint.rs`
- Mouse/vi highlight updates:
  - `alacritty/src/display/mod.rs`
- Trigger behavior from input:
  - `alacritty/src/input/mod.rs`
- User-facing hint config schema:
  - `alacritty/src/config/ui_config.rs`

### 6) Rendering, colors, cursor visuals, damage tracking

- High-level drawing orchestration:
  - `alacritty/src/display/mod.rs`
- Conversion from terminal cells to renderable cells:
  - `alacritty/src/display/content.rs`
- Cursor shape/render helpers:
  - `alacritty/src/display/cursor.rs`
- OpenGL backend integration:
  - `alacritty/src/renderer/mod.rs`
  - `alacritty/src/renderer/text/*`
  - `alacritty/src/renderer/rects.rs`
  - `alacritty/src/renderer/platform.rs`

### 7) Window creation, multi-window lifecycle, redraw flow

- App-level window management:
  - `alacritty/src/event.rs` (`create_initial_window`, `create_window`,
    `user_event` routing)
- Per-window runtime and terminal+PTY bootstrap:
  - `alacritty/src/window_context.rs`

### 8) Config schema, parsing, reload, migration

- Config load/reload/import merge:
  - `alacritty/src/config/mod.rs`
- Main config schema:
  - `alacritty/src/config/ui_config.rs`
- Domain-specific config sections:
  - `alacritty/src/config/*.rs` (e.g. `window.rs`, `font.rs`, `terminal.rs`)
- CLI override plumbing:
  - `alacritty/src/cli.rs`
- Live reload watcher:
  - `alacritty/src/config/monitor.rs`
- Legacy migration behavior:
  - `alacritty/src/migrate/mod.rs`
  - `alacritty/src/migrate/yaml.rs`

### 9) PTY process spawning, shell/session env, platform PTY details

- PTY abstraction and environment defaults:
  - `alacritty_terminal/src/tty/mod.rs`
- Unix PTY implementation:
  - `alacritty_terminal/src/tty/unix.rs`
- Windows PTY implementation:
  - `alacritty_terminal/src/tty/windows/*`
- I/O polling + parser loop:
  - `alacritty_terminal/src/event_loop.rs`

### 10) IPC / `alacritty msg` / daemon behavior

- Message schemas + CLI subcommands:
  - `alacritty/src/cli.rs`
- Socket handling and message dispatch:
  - `alacritty/src/ipc.rs`
- Event handling for IPC updates:
  - `alacritty/src/event.rs`

### 11) Logging, warnings, and message bar UX

- Logger initialization/targets/message-bar forwarding:
  - `alacritty/src/logging.rs`
- Message queue/rendered text formatting:
  - `alacritty/src/message_bar.rs`

## How to choose the correct layer

Use this quick rule:

- If behavior should be true for terminal semantics regardless of UI, implement
  in `alacritty_terminal`.
- If behavior is about key/mouse bindings, windows, rendering, or runtime app
  integration, implement in `alacritty`.

Examples:

- “Support a new CSI mode” → `alacritty_terminal/src/term/mod.rs`.
- “Add a new keybinding action to toggle feature X” →
  `alacritty/src/config/bindings.rs` + `alacritty/src/input/mod.rs`.
- “Change how search match is highlighted on screen” →
  `alacritty/src/display/content.rs`/`alacritty/src/display/mod.rs`.

## Contributor checklist for new features

1. Identify owner layer using this guide.
2. Add or adjust config/CLI shape if user-exposed.
3. Wire runtime path (input/event/terminal/render).
4. Add tests close to changed layer:
   - unit tests in touched module, and/or
   - ref tests under `alacritty_terminal/tests/ref/*` for emulation behavior.
5. Update docs:
   - `docs/features.md` (if user-visible feature),
   - `docs/escape_support.md` (if sequence support changed),
   - changelog files per `CONTRIBUTING.md` when required.

### Useful validation command

```bash
cargo test
```
