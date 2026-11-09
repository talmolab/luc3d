#!/usr/bin/env bash
# Install the Ubuntu 22.04 packages a Tauri 2 build of LUCID needs (WebKitGTK
# 4.1 + GTK 3 to compile; GStreamer plugins for the AppImage's
# bundleMediaFramework, which copies the build machine's plugins in, and for
# WebKitGTK's media/WebCodecs decode). Used by .github/workflows/desktop.yml;
# also fine on a developer's Ubuntu machine.
#
# Hardened like sleap-app's step, which once ate the full 6 h job limit: the
# runners' apt mirror can blackhole connections and IPv6 egress dribbles rather
# than failing (Acquire's Timeout is an INACTIVITY timeout, so it never trips) --
# ForceIPv4 fixes that; `timeout` caps each attempt so a stall retries.
set -uo pipefail

APT_OPTS=(-o Acquire::ForceIPv4=true -o Acquire::Retries=3
          -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30
          -o DPkg::Lock::Timeout=60)

apt_retry() {
  for attempt in 1 2 3; do
    if sudo timeout 300 apt-get "${APT_OPTS[@]}" "$@"; then
      return 0
    fi
    echo "apt-get $1 failed or stalled (attempt $attempt of 3); retrying"
    sleep 10
  done
  return 1
}

# A partial `update` is often enough to resolve what we need; only the install
# may fail the build.
apt_retry update || echo "::warning::apt-get update did not fully succeed; continuing anyway"

apt_retry install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libjavascriptcoregtk-4.1-dev \
  librsvg2-dev \
  patchelf \
  libglib2.0-dev \
  libayatana-appindicator3-dev \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-gl \
  gstreamer1.0-alsa \
  gstreamer1.0-pulseaudio ||
  { echo "::error::could not install the Linux build dependencies"; exit 1; }
