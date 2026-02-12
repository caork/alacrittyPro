# Config and Derive Crates Module Guide

This guide covers:

- `alacritty_config`
- `alacritty_config_derive`

These crates are smaller than `alacritty` and `alacritty_terminal`, but they
own the config derive/replace semantics that many app-level config changes rely
on.

## `alacritty_config`

### `alacritty_config/src/lib.rs`

Owns generic replacement behavior via `SerdeReplace`.

Key responsibilities:

- trait definition:
  - `SerdeReplace`
- primitive/container replacement behavior:
  - scalar replacements
  - `Option<T>` merge/replace behavior
  - `HashMap<String, T>` merge semantics
- helper macro:
  - `impl_replace!`

When to touch this crate:

- You need new shared replacement semantics not specific to a single config
  type.
- You are changing how `-o`/IPC overrides should merge for generic container
  types.

## `alacritty_config_derive`

### `alacritty_config_derive/src/lib.rs`

Proc-macro entrypoints:

- `#[derive(ConfigDeserialize)]`
- `#[derive(SerdeReplace)]`

Also contains shared helper logic for generic parameter handling used by derive
implementations.

### `alacritty_config_derive/src/config_deserialize/*`

Owns codegen for config-deserialization behavior:

- `#[config(...)]` field attributes
- flattening constraints
- defaulting + replacement-oriented deserialization structure

### `alacritty_config_derive/src/serde_replace.rs`

Owns codegen for derive-based replacement behavior.

When to touch this crate:

- You need new derive attribute capabilities for config structs/enums.
- You need to adjust generated behavior for config deserialization/replacement.

## Relationship with app config modules

The app schema lives in `alacritty/src/config/*` (especially
`alacritty/src/config/ui_config.rs`), while derive behavior and generic replace
semantics come from these crates.

Practical split:

- Add/modify user-facing fields: usually `alacritty/src/config/*`.
- Add/modify *how* derived config parsing/replacement works globally:
  `alacritty_config_derive` and/or `alacritty_config`.

## Testing pointers

- `alacritty_config/src/lib.rs` includes tests for replace semantics.
- `alacritty_config_derive/tests/config.rs` validates macro behavior.

When touching derive behavior, prefer adding tests in
`alacritty_config_derive/tests/config.rs` to prevent regressions in generated
code behavior.

