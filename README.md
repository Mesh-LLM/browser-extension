# Mesh LLM browser extension

> ⚠️ **Experimental, best effort, use at your own risk.**
> This is an unofficial, early-stage project with no support and no guarantees. It installs and runs a **preview** build of [mesh-llm](https://github.com/Mesh-LLM/mesh-llm) on your Mac. **Public** mode joins an open mesh of other people's computers, so anything you send in chat goes to whichever peer serves it. Don't use it for anything sensitive. It may break, change, or disappear at any time.

## Quick start (macOS, Apple Silicon, Chrome or another Chromium browser)

**1. Run this in Terminal:**

```sh
curl -fsSL https://raw.githubusercontent.com/Mesh-LLM/browser-extension/main/install.sh | bash
```

**2. Load the extension.** The installer opens `chrome://extensions` and copies the folder path to your clipboard.
- Turn on **Developer mode** (top right), then click **Load unpacked**.
- Press **⌘⇧G**, paste with **⌘V**, press Enter, and click **Open**.

**3. Click the jellyfish in the toolbar, then click Start Mesh.**

To update, click **Update** in the popup. To remove everything:

```sh
curl -fsSL https://raw.githubusercontent.com/Mesh-LLM/browser-extension/main/install.sh | bash -s -- --uninstall
```

---

## What it does

Start, join and share a [mesh-llm](https://github.com/Mesh-LLM/mesh-llm) node from your browser, and chat with the mesh beside any page.

**Popup (the control panel)**
- **Status line:** public or private mesh, peer count, and what this Mac is sharing. The toolbar badge shows the peer count: green for public, violet for private. Full details are in the Console.
- **Chat** opens the Mesh chat (`:3131/chat`). There's also a small **Console** link.
- **Public / Private**
  - Public joins the open mesh (`--auto`).
  - Private is your own mesh. **Copy an invite** puts a 24-hour invite on the clipboard. **Join with an invite** pastes one, then restarts and joins.
- **Share compute** (on or off), with an optional model. Turning it off makes this Mac a client only.
- **Start / Stop / Restart to apply.** Settings changes are applied with a restart.
- **Start Mesh when the browser opens**, **Logs**, and **Update**.

**Side panel (chat beside any page)**
- Streaming chat with history and a choice of model.
- **Include this page**, **Summarise this page**, **Key points**, and **Explain my selection**.
- Right-click menu: *Ask the mesh about "…"* and *Summarise this page with the mesh*.

## Install details

**What the installer does:**
- Everything goes into `~/.mesh-llm-browser`, with no `sudo`.
- It downloads this repo's extension and launcher, plus the latest mesh-llm **preview**. The mesh-llm download is checked against its published checksum.
- It registers the launcher with Chrome, Brave, Edge, Arc, Chromium and Vivaldi, whichever are installed.
- Read [`install.sh`](install.sh) first if you like. It's short.

**Updating:** click **Update** in the popup. It updates mesh-llm, the extension files and the launcher, then reloads the extension. Re-running the install command does the same.

**Why Developer mode?** On macOS, Chrome only installs extensions from the Chrome Web Store, or unpacked in Developer mode. This project isn't in the store, so it's loaded unpacked. It's the same code you can read here.

## If mesh-llm is already running

The extension shows it and works with it: status, Chat, side panel and invites. It never starts a second copy, because the launcher refuses when port 3131 or 9337 is already in use. **Stop** asks for confirmation before stopping a node it didn't start.

## How settings map to mesh-llm

| Settings | Command |
|---|---|
| Public, sharing | `serve --auto --model <auto pick or your choice>` |
| Public, not sharing | `client --auto` |
| Private, my own mesh | `serve --owner-required --trust-policy require-owned --min-node-version 0.76.0 --model <auto>` |
| Private, joined with an invite | `serve --owner-required --trust-policy require-owned --join-file ~/.mesh-llm-browser/invite.txt` |
| Private, not sharing | add `--client` to either private line |

- **Automatic model**, picked by memory tier. Without one, `serve --auto` just sits on standby:
  - 128 GB or more of memory (with at least 22 GB free): Qwen3.8-27B.
  - 24 GB or more (12 GB free): Gemma 4 12B.
  - 16 GB or more (6 GB free): Qwen3.5-4B.
  - Less than that: no model, so it joins on standby (or as a client in Private mode).
  - A model you type in the popup wins over the automatic pick, and `[[models]]` in your `~/.mesh-llm/config.toml` wins over both.
- Uses your normal `~/.mesh-llm` profile, so the identity, config and models are the same as when you run mesh-llm from Terminal. Model files live in the Hugging Face cache, not in `~/.mesh-llm`.
- A private mesh needs an owner identity. If the machine has none, the launcher creates one with `mesh-llm auth init --keychain`. It never replaces an existing one.
- The invite is written to a file only you can read (`0600`) and passed with `--join-file`, so it doesn't appear in process listings.

## How it works

```
popup / side panel ──fetch──▶ 127.0.0.1:3131  (/api/status, console, /chat)
                   ──fetch──▶ 127.0.0.1:9337  (/v1/models, /v1/chat/completions)
background.js ──native messaging──▶ ~/.mesh-llm-browser/mesh-llm-host.pl ──fork+setsid──▶ mesh-llm
```

The launcher (`native-host/mesh-llm-host.pl`) is plain Perl, which macOS always includes. It accepts only these commands: `status`, `start`, `stop`, `restart`, `logs`, `update` and `args` (a dry run). Settings arrive as checked fields (connection, share, model, invite) and are turned into a command line from a fixed list. mesh-llm is fully detached, so it keeps running after the browser closes. Logs go to `~/.mesh-llm-browser/mesh-llm.log`.

Uninstall:

```sh
curl -fsSL https://raw.githubusercontent.com/Mesh-LLM/browser-extension/main/install.sh | bash -s -- --uninstall
```

This leaves your `~/.mesh-llm` profile and downloaded models alone.

## TODO

- Firefox: a separate manifest using `background.scripts` and `sidebar_action`, signed as a self-distributed `.xpi`.
- Linux support in the installer.
