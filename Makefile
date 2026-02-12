TARGET = alacritty

ASSETS_DIR = extra
RELEASE_DIR = target/release
MANPAGE = $(ASSETS_DIR)/man/alacritty.1.scd
MANPAGE-MSG = $(ASSETS_DIR)/man/alacritty-msg.1.scd
MANPAGE-CONFIG = $(ASSETS_DIR)/man/alacritty.5.scd
MANPAGE-CONFIG-BINDINGS = $(ASSETS_DIR)/man/alacritty-bindings.5.scd
TERMINFO = $(ASSETS_DIR)/alacritty.info
COMPLETIONS_DIR = $(ASSETS_DIR)/completions
COMPLETIONS = $(COMPLETIONS_DIR)/_alacritty \
	$(COMPLETIONS_DIR)/alacritty.bash \
	$(COMPLETIONS_DIR)/alacritty.fish

APP_NAME = Alacritty.app
APP_TEMPLATE = $(ASSETS_DIR)/osx/$(APP_NAME)
APP_DIR = $(RELEASE_DIR)/osx
APP_BINARY = $(RELEASE_DIR)/$(TARGET)
APP_BINARY_DIR = $(APP_DIR)/$(APP_NAME)/Contents/MacOS
APP_EXTRAS_DIR = $(APP_DIR)/$(APP_NAME)/Contents/Resources
APP_COMPLETIONS_DIR = $(APP_EXTRAS_DIR)/completions

MANAGER_DIR = manager-tauri
MANAGER_APP_NAME = Alacritty Manager.app
MANAGER_BUNDLE_DIR = $(MANAGER_DIR)/src-tauri/target/release/bundle/macos
MANAGER_APP_SOURCE = $(MANAGER_BUNDLE_DIR)/$(MANAGER_APP_NAME)
MANAGER_APP_DEST = $(APP_DIR)/$(MANAGER_APP_NAME)

DMG_NAME = Alacritty.dmg
DMG_DIR = $(RELEASE_DIR)/osx

vpath $(TARGET) $(RELEASE_DIR)
vpath $(APP_NAME) $(APP_DIR)
vpath $(DMG_NAME) $(APP_DIR)

all: help

help: ## Print this help message
	@grep -E '^[a-zA-Z._-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'

binary: $(TARGET)-native ## Build a release binary
binary-universal: $(TARGET)-universal ## Build a universal release binary
$(TARGET)-native:
	MACOSX_DEPLOYMENT_TARGET="10.12" cargo build --release
$(TARGET)-universal:
	MACOSX_DEPLOYMENT_TARGET="10.12" cargo build --release --target=x86_64-apple-darwin
	MACOSX_DEPLOYMENT_TARGET="10.12" cargo build --release --target=aarch64-apple-darwin
	@lipo target/{x86_64,aarch64}-apple-darwin/release/$(TARGET) -create -output $(APP_BINARY)

app: $(APP_NAME)-native manager-app ## Create Alacritty.app + Tauri manager app
app-universal: $(APP_NAME)-universal manager-app ## Create universal Alacritty.app + manager app
$(APP_NAME)-%: $(TARGET)-%
	@mkdir -p $(APP_BINARY_DIR)
	@mkdir -p $(APP_EXTRAS_DIR)
	@mkdir -p $(APP_COMPLETIONS_DIR)
	@scdoc < $(MANPAGE) | gzip -c > $(APP_EXTRAS_DIR)/alacritty.1.gz
	@scdoc < $(MANPAGE-MSG) | gzip -c > $(APP_EXTRAS_DIR)/alacritty-msg.1.gz
	@scdoc < $(MANPAGE-CONFIG) | gzip -c > $(APP_EXTRAS_DIR)/alacritty.5.gz
	@scdoc < $(MANPAGE-CONFIG-BINDINGS) | gzip -c > $(APP_EXTRAS_DIR)/alacritty-bindings.5.gz
	@tic -xe alacritty,alacritty-direct -o $(APP_EXTRAS_DIR) $(TERMINFO)
	@cp -fRp $(APP_TEMPLATE) $(APP_DIR)
	@cp -fp $(APP_BINARY) $(APP_BINARY_DIR)
	@cp -fp $(COMPLETIONS) $(APP_COMPLETIONS_DIR)
	@touch -r "$(APP_BINARY)" "$(APP_DIR)/$(APP_NAME)"
	@codesign --remove-signature "$(APP_DIR)/$(APP_NAME)"
	@codesign --force --deep --sign - "$(APP_DIR)/$(APP_NAME)"
	@echo "Created '$(APP_NAME)' in '$(APP_DIR)'"

manager-app: ## Build and copy the Tauri manager app bundle
	@if [ ! -d "$(MANAGER_DIR)" ]; then \
		echo "Skipping manager build: '$(MANAGER_DIR)' not found"; \
		exit 0; \
	fi
	@cd "$(MANAGER_DIR)" && npm install && npm run tauri build
	@mkdir -p "$(APP_DIR)"
	@if [ -d "$(MANAGER_APP_SOURCE)" ]; then \
		rm -rf "$(MANAGER_APP_DEST)"; \
		cp -fRp "$(MANAGER_APP_SOURCE)" "$(APP_DIR)"; \
		codesign --remove-signature "$(MANAGER_APP_DEST)" >/dev/null 2>&1 || true; \
		codesign --force --deep --sign - "$(MANAGER_APP_DEST)"; \
		echo "Copied and signed '$(MANAGER_APP_NAME)' to '$(APP_DIR)'"; \
	else \
		echo "Manager bundle not found at '$(MANAGER_APP_SOURCE)'"; \
		exit 1; \
	fi

dmg: $(DMG_NAME)-native ## Create an Alacritty.dmg
dmg-universal: $(DMG_NAME)-universal ## Create a universal Alacritty.dmg
$(DMG_NAME)-%: $(APP_NAME)-%
	@echo "Packing disk image..."
	@ln -sf /Applications $(DMG_DIR)/Applications
	@hdiutil create $(DMG_DIR)/$(DMG_NAME) \
		-volname "Alacritty" \
		-fs HFS+ \
		-srcfolder $(APP_DIR) \
		-ov -format UDZO
	@echo "Packed '$(APP_NAME)' in '$(APP_DIR)'"

install: $(INSTALL)-native ## Mount disk image
install-universal: $(INSTALL)-native ## Mount universal disk image
$(INSTALL)-%: $(DMG_NAME)-%
	@open $(DMG_DIR)/$(DMG_NAME)

.PHONY: app binary clean dmg install manager-app $(TARGET) $(TARGET)-universal

clean: ## Remove all build artifacts
	@cargo clean
