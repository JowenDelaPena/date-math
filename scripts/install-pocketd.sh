#!/usr/bin/env bash
# Installs the pocketd CLI (Pocket Network Shannon) into ~/.local/bin, verifying the release checksum.
# Run inside WSL (Ubuntu):  bash scripts/install-pocketd.sh
set -euo pipefail

VERSION="${POCKETD_VERSION:-v0.1.36}"
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;;
esac
ASSET="pocket_linux_${ARCH}.tar.gz"
BASE="https://github.com/pokt-network/poktroll/releases/download/${VERSION}"

WORK="$(mktemp -d /tmp/pocketd-install.XXXXXX)"
cleanup() { [ -n "${WORK:-}" ] && [ -d "$WORK" ] && find "$WORK" -mindepth 1 -delete && rmdir "$WORK"; }
trap cleanup EXIT

echo "Downloading pocketd ${VERSION} (${ASSET})..."
curl -fsSL "$BASE/$ASSET" -o "$WORK/$ASSET"
curl -fsSL "$BASE/release_checksum" -o "$WORK/release_checksum"

( cd "$WORK" && grep " ${ASSET}\$" release_checksum | sha256sum -c - ) || { echo "Checksum mismatch, aborting."; exit 1; }

tar -xzf "$WORK/$ASSET" -C "$WORK"
BIN="$(find "$WORK" -type f -name pocketd | head -1)"
[ -n "$BIN" ] || { echo "pocketd binary not found in archive"; exit 1; }
mkdir -p "$HOME/.local/bin"
install -m 0755 "$BIN" "$HOME/.local/bin/pocketd"

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
  export PATH="$HOME/.local/bin:$PATH"
  echo "Added ~/.local/bin to PATH in ~/.bashrc (open a new terminal or run: source ~/.bashrc)"
fi
pocketd version || true
echo
echo "Next: create your owner key (WRITE THE MNEMONIC ON PAPER, never share it):"
echo "  pocketd keys add owner --keyring-backend file"
