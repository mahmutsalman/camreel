#!/bin/bash
# Builds the universal (arm64 + x86_64) window watcher into src/assets/bin/.
# electron-builder signs it with the app (hardened runtime) when packaging.
set -e
cd "$(dirname "$0")/.."
T=$(mktemp -d)
swiftc -O -target arm64-apple-macos11 -o "$T/arm64" tools/winwatch/winwatch.swift
swiftc -O -target x86_64-apple-macos11 -o "$T/x86_64" tools/winwatch/winwatch.swift
lipo -create -output src/assets/bin/camreel-winwatch "$T/arm64" "$T/x86_64"
lipo -archs src/assets/bin/camreel-winwatch
