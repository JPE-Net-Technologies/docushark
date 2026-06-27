---
title: Installation
description: Run DocuShark right in your browser, or build the desktop app from source.
---

# Installation

DocuShark runs right in your browser — no installation required — and can also be built as a
desktop application from source. Both share the same editor and the same features.

## Run in Your Browser (Recommended)

Open [app.docushark.app](https://app.docushark.app) and start working immediately — there's
nothing to install, and you always have the latest version. Local documents stay in your
browser and keep working offline.

Most browsers also let you **install** DocuShark so it opens in its own window and lives in your
dock, taskbar, or home screen:

- **Chrome / Edge** — click the install icon in the address bar, or use the in-app **Install** prompt.
- **Safari (macOS)** — File → Add to Dock.
- **iOS / Android** — Share → Add to Home Screen.

## Desktop Application

DocuShark can also run as a native desktop application (Windows, Linux, macOS) built with Tauri,
with native file-system integration. It has the same features as the browser version.

Pre-built signed installers aren't published yet, so the desktop app is currently built from
source — it only takes a few minutes on any platform. See [Building from Source](#building-from-source)
below.

## Building from Source

Building from source is straightforward on all platforms, and is currently the way to get the
desktop app.

### Prerequisites

You'll need three tools installed before building:

::: details macOS

1. **Install Xcode Command Line Tools** (provides C compiler and system headers)
   ```bash
   xcode-select --install
   ```

2. **Install Bun** (JavaScript runtime and package manager)
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```
   Close and reopen your terminal, then verify with `bun --version`.

3. **Install Rust** (for the Tauri desktop backend)
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
   Choose the default installation when prompted. Close and reopen your terminal, then verify with `rustc --version`.

**Tip:** If you use [Homebrew](https://brew.sh), you can also install Bun with `brew install oven-sh/bun/bun`.
:::

::: details Windows

1. **Install Bun** — download from [bun.sh](https://bun.sh) or run:
   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

2. **Install Rust** — download from [rustup.rs](https://rustup.rs) and run the installer.

3. **Install Visual Studio Build Tools** — required for Rust on Windows. Download from [Visual Studio](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and install the "Desktop development with C++" workload.
:::

::: details Linux

1. **Install Bun**
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **Install Rust**
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

3. **Install system dependencies** (Debian/Ubuntu)
   ```bash
   sudo apt-get update
   sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev \
     librsvg2-dev patchelf
   ```
   For other distros, see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
:::

### Build the App

Once prerequisites are installed, the build process is the same on all platforms:

```bash
# Clone the repository
git clone https://github.com/JPE-Net-Technologies/docushark.git
cd docushark

# Install JavaScript dependencies
bun install

# Build the desktop application
bun run tauri:build
```

The build takes a few minutes on first run (Rust compiles all dependencies). The finished installer will be in:

| Platform | Output location |
|----------|----------------|
| macOS    | `src-tauri/target/release/bundle/dmg/` and `macos/` |
| Windows  | `src-tauri/target/release/bundle/nsis/` and `msi/` |
| Linux    | `src-tauri/target/release/bundle/appimage/` and `deb/` |

::: info
On macOS, the built `.app` is unsigned. On first launch, right-click the app and select **Open**, then click **Open** again in the dialog to bypass Gatekeeper.
:::

### Running in Development Mode

If you want to run DocuShark without creating an installer:

```bash
# Web version only (opens in browser)
bun run dev

# Desktop app with hot-reload
bun run tauri:dev
```

## System Requirements

| Component | Minimum                               | Recommended     |
| --------- | ------------------------------------- | --------------- |
| OS        | Windows 10, macOS 10.15, Ubuntu 20.04 | Latest versions |
| RAM       | 4 GB                                  | 8 GB+           |
| Display   | 1280×720                              | 1920×1080+      |
| Storage   | 200 MB                                | 500 MB+         |

## Next Steps

Learn how to create your first diagram with the [Quick Start Guide](/getting-started/quick-start).
