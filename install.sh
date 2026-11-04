#!/usr/bin/env bash
# Mesh LLM browser extension — installer (macOS, Apple Silicon).
#
#   curl -fsSL https://raw.githubusercontent.com/Mesh-LLM/browser-extension/main/install.sh | bash
#
# What it does (no sudo; everything lives in ~/.mesh-llm-browser):
#   1. Downloads this repo's extension + launcher into ~/.mesh-llm-browser
#   2. Downloads the latest mesh-llm preview into ~/.mesh-llm-browser/bundle (checksum-verified)
#   3. Registers the launcher with your Chromium browsers (+ Firefox) so the
#      extension can start/stop mesh-llm
#   4. Opens chrome://extensions so you can load the extension
#
# Re-run any time to update. Remove everything with:  bash install.sh --uninstall
set -euo pipefail

REPO="${MESH_BROWSER_REPO:-Mesh-LLM/browser-extension}"
REF="${MESH_BROWSER_REF:-main}"
HOST_NAME="ai.meshllm.host"
EXT_ID="iobkopeolfaebhlhifmddagjjpnijfkk"          # fixed via "key" in extension/manifest.json
FIREFOX_ID="mesh-llm@meshllm.ai"
BASE="$HOME/.mesh-llm-browser"
EXT_DIR="$BASE/extension"
HOST="$BASE/mesh-llm-host.pl"

CHROMIUM_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome"
  "$HOME/Library/Application Support/Google/Chrome Beta"
  "$HOME/Library/Application Support/Google/Chrome Canary"
  "$HOME/Library/Application Support/Chromium"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
  "$HOME/Library/Application Support/Microsoft Edge"
  "$HOME/Library/Application Support/Arc/User Data"
  "$HOME/Library/Application Support/Vivaldi"
)
FIREFOX_DIR="$HOME/Library/Application Support/Mozilla"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  [[ -f "$BASE/mesh-llm.pid" ]] && kill "$(cat "$BASE/mesh-llm.pid")" 2>/dev/null || true
  for d in "${CHROMIUM_DIRS[@]}"; do rm -f "$d/NativeMessagingHosts/$HOST_NAME.json"; done
  rm -f "$FIREFOX_DIR/NativeMessagingHosts/$HOST_NAME.json"
  rm -rf "$BASE"
  say "Removed $BASE and the browser registrations."
  echo "    Remove the extension itself from chrome://extensions."
  echo "    Your ~/.mesh-llm profile and downloaded models were not touched."
  exit 0
fi

[[ "$(uname -s)" == "Darwin" ]] || die "this installer is macOS-only for now"
[[ "$(uname -m)" == "arm64" ]] || die "mesh-llm preview builds are Apple Silicon (arm64) only"
[[ -x /usr/bin/perl ]] || die "/usr/bin/perl not found"
mkdir -p "$BASE"

# --- 1. extension + launcher --------------------------------------------------
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/extension/manifest.json" && "${MESH_BROWSER_FROM_GITHUB:-}" != "1" ]]; then
  SRC="$SCRIPT_DIR"
  say "Using extension from $SRC"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  say "Downloading the extension from github.com/$REPO ($REF)…"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$TMP" \
    || die "could not download github.com/$REPO"
  SRC="$(find "$TMP" -maxdepth 3 -name manifest.json -path '*/extension/*' -exec dirname {} \; | head -1)"
  SRC="${SRC%/extension}"
  [[ -f "$SRC/extension/manifest.json" ]] || die "unexpected archive layout"
fi
mkdir -p "$EXT_DIR"
# Replace contents in place: Chrome keeps pointing at the same folder.
rsync -a --delete "$SRC/extension/" "$EXT_DIR/"
cp "$SRC/native-host/mesh-llm-host.pl" "$HOST"
chmod 755 "$HOST"
/usr/bin/perl -c "$HOST" >/dev/null 2>&1 || die "launcher failed to compile"

# --- 2. mesh-llm preview (the launcher's own updater does the download) --------
call_host() {
  /usr/bin/perl -e 'my $m = shift; print pack("V", length $m) . $m;' "$1" | "$HOST" |
    /usr/bin/perl -e 'binmode STDIN; read(STDIN, my $l, 4) or exit 1; read(STDIN, my $b, unpack("V",$l)); print $b, "\n";'
}
if [[ "${SKIP_DOWNLOAD:-}" != "1" ]]; then
  say "Downloading the latest mesh-llm preview…"
  out="$(call_host '{"cmd":"update","binary_only":true}')"
  echo "$out" | grep -q '"ok":true' || die "mesh-llm download failed: $out"
fi

# --- 3. register the launcher with browsers -----------------------------------
write_manifest() {
  mkdir -p "$1"
  cat > "$1/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Mesh LLM launcher",
  "path": "$HOST",
  "type": "stdio",
  $2
}
EOF
}
browsers=()
for d in "${CHROMIUM_DIRS[@]}"; do
  if [[ -d "$d" ]]; then
    write_manifest "$d/NativeMessagingHosts" "\"allowed_origins\": [\"chrome-extension://$EXT_ID/\"]"
    browsers+=("${d#$HOME/Library/Application Support/}")
  fi
done
if [[ -d "$FIREFOX_DIR" ]]; then
  write_manifest "$FIREFOX_DIR/NativeMessagingHosts" "\"allowed_extensions\": [\"$FIREFOX_ID\"]"
fi
if [[ ${#browsers[@]} -eq 0 ]]; then
  write_manifest "${CHROMIUM_DIRS[0]}/NativeMessagingHosts" "\"allowed_origins\": [\"chrome-extension://$EXT_ID/\"]"
  browsers+=("Google/Chrome")
fi
say "Registered with: ${browsers[*]}"

# --- 4. hand over to the browser ----------------------------------------------
printf '%s' "$EXT_DIR" | pbcopy 2>/dev/null || true
VERSION="$("$BASE/bundle/mesh-llm" --version 2>/dev/null || echo "mesh-llm (not downloaded)")"

echo
bold "Installed: $VERSION + Mesh LLM extension"
echo
bold "Last step — load the extension (once):"
echo "  1. In chrome://extensions turn on  Developer mode  (top right)"
echo "  2. Click  Load unpacked"
echo "  3. Press ⌘⇧G, paste (⌘V — the path is on your clipboard), press Enter, click Open"
echo "       $EXT_DIR"
echo
echo "Then click the jellyfish in the toolbar → Start Mesh."
echo "Already loaded? Nothing to do — it updates in place (reload it if it was open)."
echo

if [[ "${NO_OPEN:-}" != "1" ]]; then
  for app in "Google Chrome" "Brave Browser" "Microsoft Edge" "Arc" "Chromium"; do
    if open -Ra "$app" 2>/dev/null; then
      open -a "$app" "chrome://extensions" 2>/dev/null || true
      break
    fi
  done
fi
