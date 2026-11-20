#!/bin/bash
# Builds the test-only cover window app (never shipped): tools/cover/camreel-cover
set -e
cd "$(dirname "$0")/.."
swiftc -O -o tools/cover/camreel-cover tools/cover/cover.swift
