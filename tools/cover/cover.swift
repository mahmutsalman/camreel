// A test-only window of OUR OWN (never his apps): camreel-cover x y w h
// Shows one plain dark window at those screen coordinates (top-left origin) and comes to
// the front as its own app (so Stage Manager parks other apps' windows). Quits on SIGTERM.
import AppKit
let a = CommandLine.arguments.dropFirst().compactMap { Double($0) }
let (x, y, w, h) = a.count == 4 ? (a[0], a[1], a[2], a[3]) : (100, 100, 400, 300)
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let screenH = NSScreen.screens.first?.frame.height ?? 900
let win = NSWindow(contentRect: NSRect(x: x, y: screenH - y - h, width: w, height: h), styleMask: [.titled], backing: .buffered, defer: false)
win.title = "CamReel test cover"
win.backgroundColor = NSColor(white: 0.13, alpha: 1)
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
signal(SIGTERM) { _ in exit(0) }
app.run()
