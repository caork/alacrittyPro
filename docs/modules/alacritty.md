# `alacritty` Crate Module Guide

This guide documents ownership inside the app/runtime crate
(`alacritty/src/*`).

## Startup and process entrypoints

### `alacritty/src/main.rs`

Owns top-level runtime bootstrapping:

- parse CLI (`Options::new`)
- initialize logging
- load config and env setup
- initialize IPC socket (unix)
- create and run `event::Processor`

Use this file when you need to change the startup sequence or add a new top-level
subcommand/path that affects process initialization.

### `alacritty/src/cli.rs`

Owns CLI schema and override translation:

- `Options`, `Subcommands`, `WindowOptions`, `TerminalOptions`
- parsing of `-o` style config overrides (`ParsedOptions`)
- conversion of CLI options into config/PTTY/window overrides

Use this module when adding new CLI flags, `alacritty msg` payload shape, or
new runtime override syntax.

## Event and window lifecycle

### `alacritty/src/event.rs`

Owns app-level event routing and orchestration:

- `Processor` as winit `ApplicationHandler`
- routing of `EventType` (config reload, create-window, terminal events, IPC)
- app-global scheduler interactions
- action backend (`ActionContext`) for input actions
- search state (`SearchState`, `InlineSearchState`)

Use this module when behavior depends on coordination between input, terminal,
window lifecycle, scheduler, and config reload.

### `alacritty/src/window_context.rs`

Owns one window's runtime state:

- bootstrap terminal (`Term`) + PTY + renderer/display for a window
- aggregate per-window mutable state (search, messages, input modifiers, dirty)
- dispatch queued window/user events into input processing
- apply config updates at window scope

Use this module for per-window behavior changes, especially where display + term
state must stay consistent.

## Input pipeline

### `alacritty/src/input/mod.rs`

Owns input action execution and pointer/touch logic:

- `ActionContext` trait contract (what actions can do)
- `Action` execution behavior (`Execute` impl)
- mouse selection, scrolling, hint trigger behavior
- vi action dispatch integration

Use this module when adding/changing action semantics or mouse/touch behavior.

### `alacritty/src/input/keyboard.rs`

Owns keyboard event translation:

- binding matching logic
- fallback keyboard protocol sequence generation
- kitty keyboard protocol mode handling
- interaction with active hint/search/vi states

Use this module when changing how physical/logical keys become PTY bytes.

## Display layer

### `alacritty/src/display/mod.rs`

High-level display orchestration:

- `Display` lifecycle and draw pipeline
- applying `DisplayUpdate` (resize/font/cursor dirty)
- frame timing, damage tracking, render scheduling
- highlighted-hint updates for mouse/vi cursor

Use this module for frame scheduling, redraw behavior, and top-level render flow.

### `alacritty/src/display/content.rs`

Converts terminal content into renderable content:

- selection/search/hint visual overlays
- color resolution (fg/bg/underline)
- cursor render model generation

Use this module for “how terminal state appears on screen” rules.

### `alacritty/src/display/hint.rs`

Hint state and matching internals:

- visible regex/hyperlink match extraction
- hint label generation and keyboard hint selection state
- hyperlink revalidation for trigger safety

Use this module for hint candidate discovery/label behavior.

### `alacritty/src/display/window.rs`

Platform window wrapper:

- winit window setup and platform attributes
- cursor icon, IME, theme/fullscreen/window-level controls

Use this module for window chrome, IME integration, or platform window options.

### Other display internals

- `alacritty/src/display/color.rs`: color model and conversions used by display
- `alacritty/src/display/cursor.rs`: cursor rect and cursor-specific visuals
- `alacritty/src/display/damage.rs`: damage tracking bookkeeping
- `alacritty/src/display/bell.rs`: visual bell timing/intensity behavior
- `alacritty/src/display/meter.rs`: frame/render metrics instrumentation

## Renderer layer

### `alacritty/src/renderer/mod.rs`

Renderer selection and high-level draw APIs:

- backend selection (`Glsl3` vs `Gles2`)
- draw text cells / rect batches
- GL capability checks and robustness support

### `alacritty/src/renderer/platform.rs`

OpenGL platform setup:

- GL display/context/surface creation
- API preference logic (EGL/GLX/WGL/CGL)

### `alacritty/src/renderer/text/*`

Text rendering internals:

- glyph cache/atlas management
- backend-specific text shaders and batching

### `alacritty/src/renderer/rects.rs` and `shader.rs`

- rectangle rendering (underlines, selection, cursor blocks, etc.)
- shader compilation/program management

## Configuration subsystem in app crate

### `alacritty/src/config/mod.rs`

Config load/reload/import merge and install-path discovery.

### `alacritty/src/config/ui_config.rs`

Top-level config struct and derived conversion helpers:

- `term_options()` (feeds terminal-core config)
- `pty_config()` (feeds PTY spawn config)

### `alacritty/src/config/*.rs`

Domain-specific config sections (`window`, `font`, `color`, `terminal`, etc.).

### `alacritty/src/config/monitor.rs`

Live-reload file watch and debounce behavior.

### `alacritty/src/config/bindings.rs`

Binding schema and default binding definitions.

## Integration/support modules

- `alacritty/src/ipc.rs`: unix socket protocol + request/reply handling
- `alacritty/src/daemon.rs`: detached command spawning + cwd inference
- `alacritty/src/logging.rs`: logger + message-bar warnings/errors
- `alacritty/src/message_bar.rs`: in-app warning/error queue and wrapping
- `alacritty/src/scheduler.rs`: timer abstraction used by event/display/input
- `alacritty/src/migrate/*`: config migration command behavior
- `alacritty/src/clipboard.rs`: clipboard abstraction integration
- `alacritty/src/string.rs`: string utilities

## Quick routing examples

- “Add a new action bindable in config”:
  1) `alacritty/src/config/bindings.rs`
  2) `alacritty/src/input/mod.rs`
  3) maybe `alacritty/src/event.rs` if backend state/action context is needed

- “Change redraw scheduling or frame timing”:
  1) `alacritty/src/display/mod.rs`
  2) `alacritty/src/scheduler.rs`
  3) `alacritty/src/event.rs` (if event routing changes)

- “Add a new CLI override and make it affect runtime”:
  1) `alacritty/src/cli.rs`
  2) relevant `alacritty/src/config/*.rs`
  3) `alacritty/src/window_context.rs` or `alacritty/src/event.rs`

