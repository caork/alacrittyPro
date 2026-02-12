# `alacritty_terminal` Crate Module Guide

This guide documents ownership inside `alacritty_terminal/src/*`.

## Crate-level map

From `alacritty_terminal/src/lib.rs`, the major public modules are:

- `event`
- `event_loop`
- `grid`
- `index`
- `selection`
- `sync`
- `term`
- `thread`
- `tty`
- `vi_mode`

## Terminal emulation core

### `alacritty_terminal/src/term/mod.rs`

This is the central emulation engine.

Owns:

- terminal state model (`Term`, `TermMode`, cursor/modes/scroll regions)
- ANSI handler implementation (`impl Handler for Term<T>`)
- mode toggles and private modes
- OSC/clipboard/color request handling
- render-facing snapshots (`RenderableContent`, renderable cursor)
- damage tracking state for incremental redraw

If behavior should be “terminal semantics,” this is usually the right owner.

### `alacritty_terminal/src/term/search.rs`

Owns regex search engine for terminal content:

- DFA construction and runtime caches
- left/right directional match traversal logic
- bracket matching helpers used by selection/vi workflows

### `alacritty_terminal/src/term/cell.rs`

Owns per-cell data model:

- character + fg/bg + flags
- extra metadata (zerowidth chars, underline color, hyperlink)
- cell reset/emptiness semantics

### `alacritty_terminal/src/term/color.rs`

Owns indexed color storage (`Colors`) for terminal color space.

## Grid and indexing primitives

### `alacritty_terminal/src/grid/mod.rs`

Owns terminal grid storage and history mechanics:

- visible region and scrollback storage model
- display offset and history size behavior
- resize/scroll operations and cursor placement storage

Related internals:

- `alacritty_terminal/src/grid/resize.rs`
- `alacritty_terminal/src/grid/row.rs`
- `alacritty_terminal/src/grid/storage.rs`

### `alacritty_terminal/src/index.rs`

Index and coordinate types used across terminal code:

- `Line`, `Column`, `Point`, directional arithmetic/boundary operations

## Selection and vi movement

### `alacritty_terminal/src/selection.rs`

Owns selection model:

- selection types (`Simple`, `Block`, `Semantic`, `Lines`)
- anchor/range updates
- range containment and rotation logic on scroll

### `alacritty_terminal/src/vi_mode.rs`

Owns vi cursor movement behavior:

- vi motion definitions
- per-motion point calculations
- word/semantic/paragraph traversal logic

## PTY and I/O

### `alacritty_terminal/src/event_loop.rs`

Owns PTY I/O thread runtime:

- poll/read/write loop
- parser advancement over incoming PTY bytes
- channel messages (`Msg`) for input/resize/shutdown
- notifier/sender glue for UI thread communication

### `alacritty_terminal/src/tty/mod.rs`

Owns PTY abstraction and shared options:

- `Options`/`Shell`
- `EventedPty` and read-write trait abstractions
- environment defaults (`TERM`, `COLORTERM`)

### Platform PTY implementations

- `alacritty_terminal/src/tty/unix.rs`
- `alacritty_terminal/src/tty/windows/*`

These own platform process spawning and PTY fd/handle integration details.

## Event and synchronization utilities

### `alacritty_terminal/src/event.rs`

Owns terminal-to-UI event contract:

- `Event` enum (`Title`, `Bell`, `ClipboardStore`, `Wakeup`, etc.)
- listener and notification traits (`EventListener`, `Notify`, `OnResize`)

### `alacritty_terminal/src/sync.rs`

Synchronization primitives used between PTY thread and UI thread access.

### `alacritty_terminal/src/thread.rs`

Thread spawning helper with naming convenience.

## Testing map

### Ref tests

- Test runner: `alacritty_terminal/tests/ref.rs`
- Captured fixtures: `alacritty_terminal/tests/ref/*`

Use ref tests for terminal emulation regressions (escape sequence behavior,
grid state, selection/search side effects visible in terminal output).

### Unit tests

Many modules include local `#[cfg(test)]` tests (for example in
`term/mod.rs`, `grid/mod.rs`, etc.). Prefer adding narrow unit tests for helper
logic and ref tests for end-to-end parser/state behavior.

## Quick routing examples

- “Implement a new OSC behavior”:
  - `alacritty_terminal/src/term/mod.rs`
  - maybe `alacritty_terminal/src/term/cell.rs` if new cell metadata
  - update `docs/escape_support.md`

- “Fix weird wrapped-line cursor movement in vi mode”:
  - `alacritty_terminal/src/vi_mode.rs`
  - possibly `alacritty_terminal/src/grid/mod.rs` and `term/mod.rs`

- “Adjust how search traverses results across lines”:
  - `alacritty_terminal/src/term/search.rs`
  - call sites in `term/mod.rs`

