// camreel-winwatch <CGWindowID> [seconds]
// Prints one JSON line whenever the window's on-screen geometry changes:
//   {"found":true,"onscreen":true,"x":432,"y":-33,"w":480,"h":1080}
// Why: with Stage Manager, a parked (or "minimized") window keeps isVisible() = true and
// isMinimized() = false in Electron; only the window server's bounds show it shrank to a
// thumbnail. Reads geometry of ONE window by number (no titles: no Screen Recording grant).
// Exits by itself when its parent (CamReel) is gone.
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

// ---- watchdog mode: camreel-winwatch --watchdog <pid> <clean-exit marker> <executable> [args...]
// Waits for CamReel (pid) to end. A CLEAN quit writes the marker first: then nothing happens.
// Any other end (a crash) relaunches CamReel (same executable, args and environment), at most
// 3 times in 2 minutes (no crash loop), and leaves a note for the new instance to show.
if CommandLine.arguments.count > 4 && CommandLine.arguments[1] == "--watchdog" {
  let a = CommandLine.arguments
  guard let pid = Int32(a[2]) else { exit(2) }
  let marker = a[3], exe = a[4], rest = Array(a.dropFirst(5))
  let fm = FileManager.default
  while kill(pid, 0) == 0 || errno != ESRCH { Thread.sleep(forTimeInterval: 0.5) }
  Thread.sleep(forTimeInterval: 0.7)
  if fm.fileExists(atPath: marker) { exit(0) }              // clean quit
  let dir = (marker as NSString).deletingLastPathComponent
  let crashes = (dir as NSString).appendingPathComponent("crash-times.txt")
  let now = Date().timeIntervalSince1970
  var times = ((try? String(contentsOfFile: crashes, encoding: .utf8)) ?? "").split(separator: "\n").compactMap { Double($0) }.filter { now - $0 < 120 }
  times.append(now)
  try? times.map { String($0) }.joined(separator: "\n").write(toFile: crashes, atomically: true, encoding: .utf8)
  let note = (dir as NSString).appendingPathComponent("last-crash.txt")
  if times.count > 3 {
    try? "gave up: \(times.count) unexpected exits in 2 minutes".write(toFile: note, atomically: true, encoding: .utf8)
    exit(1)
  }
  try? "\(Int(now))".write(toFile: note, atomically: true, encoding: .utf8)
  let p = Process()
  p.executableURL = URL(fileURLWithPath: exe)
  p.arguments = rest
  p.environment = ProcessInfo.processInfo.environment
  try? p.run()
  exit(0)
}

guard CommandLine.arguments.count > 1, let n = UInt32(CommandLine.arguments[1]) else {
  FileHandle.standardError.write("usage: camreel-winwatch <window id> [seconds]\n".data(using: .utf8)!)
  exit(2)
}
let wid = CGWindowID(n)
let every = CommandLine.arguments.count > 2 ? (Double(CommandLine.arguments[2]) ?? 0.5) : 0.5
let parent = getppid()
var last = ""
while true {
  if getppid() != parent { exit(0) }
  var line = "{\"found\":false}"
  if let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], wid) as? [[String: Any]],
     let w = list.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == n }),
     let b = w[kCGWindowBounds as String] as? [String: Any] {
    let on = (w[kCGWindowIsOnscreen as String] as? Bool) ?? false
    let x = (b["X"] as? Double) ?? 0, y = (b["Y"] as? Double) ?? 0
    let ww = (b["Width"] as? Double) ?? 0, hh = (b["Height"] as? Double) ?? 0
    line = "{\"found\":true,\"onscreen\":\(on),\"x\":\(Int(x)),\"y\":\(Int(y)),\"w\":\(Int(ww)),\"h\":\(Int(hh))}"
  }
  if line != last { print(line); last = line }
  Thread.sleep(forTimeInterval: every)
}
