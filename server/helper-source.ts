// Swift source for the capture/input helper. The daemon compiles it once per source hash.
// Kept as a string because the server bundle cannot ship non-code files next to itself.
export const HELPER_SWIFT = String.raw`
import Foundation
import ScreenCaptureKit
import CoreImage
import AppKit
import ApplicationServices
import IOKit.pwr_mgt
import VideoToolbox

let stdoutQueue = DispatchQueue(label: "out")
func emit(_ data: Data) {
  stdoutQueue.sync {
    do { try FileHandle.standardOutput.write(contentsOf: data) } catch { _exit(0) }
  }
}
func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  _exit(2)
}
func now() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }

func content() async -> SCShareableContent {
  do { return try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) }
  catch { fail("screen-recording-denied") }
}

let args = CommandLine.arguments
// ScreenCaptureKit hangs on a locked screen; say so instead.
if let session = CGSessionCopyCurrentDictionary() as? [String: Any], session["CGSSessionScreenIsLocked"] as? Bool == true {
  fail("screen-locked")
}

if args.count >= 2 && args[1] == "list" {
  let c = await content()
  let windows: [[String: Any]] = c.windows.compactMap { w in
    guard w.windowLayer == 0, w.frame.width >= 120, w.frame.height >= 80, let app = w.owningApplication else { return nil }
    return ["id": Int(w.windowID), "pid": Int(app.processID), "app": app.applicationName, "title": w.title ?? "",
            "width": Int(w.frame.width), "height": Int(w.frame.height)]
  }
  let out: [String: Any] = ["canControl": AXIsProcessTrusted(), "windows": windows]
  emit(try! JSONSerialization.data(withJSONObject: out))
  exit(0)
}

// "input" only replays stdin commands (agent tools); "stream" also captures.
let inputOnly = args.count >= 3 && args[1] == "input"
guard inputOnly || (args.count >= 6 && args[1] == "stream") else {
  fail("usage: helper list | input <display|windowId> | stream <display|windowId> <fps> <maxWidth> <h264|jpeg>")
}
let target = args[2]
let fps = inputOnly ? 30 : Int32(args[3]) ?? 30
let maxWidth = inputOnly ? 1280 : Double(args[4]) ?? 1280
let useH264 = !inputOnly && args[5] == "h264"
var windowID: CGWindowID? = target == "display" ? nil : UInt32(target)
var displayID: CGDirectDisplayID = CGMainDisplayID()
var activeStream: SCStream? = nil
var stallTimer: DispatchSourceTimer? = nil
let output = Output()

// ---- Flow control -------------------------------------------------------------------------
// The client acknowledges with "a <frames received>". Frames in flight are capped near the
// link's bandwidth-delay product: ceil(minRTT * fps) + 2. Captured frames that cannot be sent
// yet collapse into the newest one, so a slow link drops frames instead of building a queue.
let gate = DispatchQueue(label: "gate")
var emitted = 0
var acked = 0
var encoding = 0
var window = 4
var sentAt: [Int: Double] = [:]
var rttSamples: [(at: Double, rtt: Double)] = []
var lastAck = now()
var forceKey = false

let latestLock = NSLock()
var latest: (CVPixelBuffer, CMTime)? = nil
var lastSent: (CVPixelBuffer, CMTime)? = nil

func takeLatest() -> (CVPixelBuffer, CMTime)? {
  latestLock.lock(); defer { latestLock.unlock() }
  let frame = latest
  latest = nil
  return frame
}

// Frames on stdout: [u32 length][u8 type][payload]; type 0 = JPEG, 1 = H.264 keyframe, 2 = H.264 delta (Annex B).
// Runs on gate, so counting and writing stay in order.
func emitFrame(_ type: UInt8, _ payload: Data) {
  var len = UInt32(payload.count + 1).bigEndian
  var frame = Data(bytes: &len, count: 4)
  frame.append(type)
  frame.append(payload)
  emitted += 1
  sentAt[emitted] = now()
  emit(frame)
}

func acknowledge(_ count: Int) {
  let n = min(count, emitted)
  guard n > acked else { return }
  let t = now()
  if let sent = sentAt[n] { rttSamples.append((t, t - sent)) }
  for i in (acked + 1)...n { sentAt[i] = nil }
  acked = n
  lastAck = t
  rttSamples.removeAll { t - $0.at > 5000 }
  if let minRtt = rttSamples.map(\.rtt).min() {
    window = min(max(Int((minRtt * Double(fps) / 1000).rounded(.up)) + 2, 4), 15)
  }
}

// ---- Encoders -----------------------------------------------------------------------------
let ciContext = CIContext()
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
func encodeJPEG(_ pixels: CVPixelBuffer) {
  let opts = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.5]
  if let jpeg = ciContext.jpegRepresentation(of: CIImage(cvPixelBuffer: pixels), colorSpace: srgb, options: opts) { emitFrame(0, jpeg) }
}

var session: VTCompressionSession?
func startEncoder(width: Int32, height: Int32) {
  // Low-latency rate control: one frame in, one out, no bitrate reservoir bursts. Older systems fall back.
  let lowLatency = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue] as CFDictionary
  for spec in [lowLatency, nil] {
    VTCompressionSessionCreate(allocator: nil, width: width, height: height, codecType: kCMVideoCodecType_H264,
                               encoderSpecification: spec, imageBufferAttributes: nil, compressedDataAllocator: nil,
                               outputCallback: nil, refcon: nil, compressionSessionOut: &session)
    if session != nil { break }
  }
  guard let s = session else { fail("encoder-failed") }
  // ~2.3 Mbps at 1280x830@30 with a hard 1.5x ceiling per second: a relay link is the bottleneck.
  let bitrate = min(max(Int(width) * Int(height) * Int(fps) / 14, 1_000_000), 3_000_000)
  VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
  VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel)
  VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
  VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bitrate))
  VTSessionSetProperty(s, key: kVTCompressionPropertyKey_DataRateLimits, value: [NSNumber(value: bitrate * 3 / 16), NSNumber(value: 1)] as CFArray)
  VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
  // The transport is lossless, so no periodic keyframes; the client asks with "kf" when it needs one.
  VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: Int32.max))
  VTCompressionSessionPrepareToEncodeFrames(s)
}

let startCode: [UInt8] = [0, 0, 0, 1]
func annexB(_ sb: CMSampleBuffer) -> (Bool, Data)? {
  let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]]
  let key = !((attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
  var out = Data()
  if key, let format = CMSampleBufferGetFormatDescription(sb) {
    var count = 0
    CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                       parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
    for i in 0..<count {
      var pointer: UnsafePointer<UInt8>?
      var size = 0
      CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i, parameterSetPointerOut: &pointer,
                                                         parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
      if let pointer { out.append(contentsOf: startCode); out.append(pointer, count: size) }
    }
  }
  guard let block = CMSampleBufferGetDataBuffer(sb) else { return nil }
  // Copy out: the block buffer may not be contiguous.
  let length = CMBlockBufferGetDataLength(block)
  var avcc = [UInt8](repeating: 0, count: length)
  guard CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &avcc) == noErr else { return nil }
  var offset = 0
  while offset + 4 <= length {
    let nal = Int(avcc[offset]) << 24 | Int(avcc[offset + 1]) << 16 | Int(avcc[offset + 2]) << 8 | Int(avcc[offset + 3])
    guard nal > 0, offset + 4 + nal <= length else { return nil }
    out.append(contentsOf: startCode)
    out.append(contentsOf: avcc[(offset + 4)..<(offset + 4 + nal)])
    offset += 4 + nal
  }
  return (key, out)
}

// Runs on gate.
func pump() {
  if emitted - acked >= window, now() - lastAck > 2000 {
    acked = emitted // an ack got lost; don't stall forever
    lastAck = now()
  }
  guard emitted - acked + encoding < window else { return }
  var frame = takeLatest()
  if frame == nil && forceKey { frame = lastSent }
  guard let (pixels, time) = frame else { return }
  lastSent = frame
  guard let s = session else { return encodeJPEG(pixels) }
  let options = forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary : nil
  forceKey = false
  encoding += 1
  let status = VTCompressionSessionEncodeFrame(s, imageBuffer: pixels, presentationTimeStamp: time, duration: .invalid,
                                               frameProperties: options, infoFlagsOut: nil) { status, _, sb in
    let encoded = status == noErr ? sb.flatMap(annexB) : nil
    gate.async {
      encoding -= 1
      if let (key, data) = encoded { emitFrame(key ? 1 : 2, data) }
      pump()
    }
  }
  if status != noErr { encoding -= 1 }
}

final class Output: NSObject, SCStreamOutput, SCStreamDelegate {
  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, let pixels = sb.imageBuffer,
          let info = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let raw = info.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
    latestLock.lock()
    latest = (pixels, CMSampleBufferGetPresentationTimeStamp(sb))
    latestLock.unlock()
    gate.async { pump() }
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) { fail("stream-stopped: \(error.localizedDescription)") }
}

// Agent input goes to the frontmost app, so bring the target window's app forward first.
if inputOnly, let id = windowID,
   let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first,
   let pid = info[kCGWindowOwnerPID as String] as? pid_t {
  NSRunningApplication(processIdentifier: pid)?.activate()
  Thread.sleep(forTimeInterval: 0.15)
}

// ---- Capture ------------------------------------------------------------------------------
if !inputOnly {
  // A host laptop's screen is often asleep; wake it and keep it on while streaming.
  var wake: IOPMAssertionID = 0
  var awake: IOPMAssertionID = 0
  IOPMAssertionDeclareUserActivity("paseo-screen" as CFString, kIOPMUserActiveLocal, &wake)
  IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
                              IOPMAssertionLevel(kIOPMAssertionLevelOn), "paseo-screen" as CFString, &awake)
  var c = await content()
  for _ in 0..<30 where c.displays.isEmpty {
    try? await Task.sleep(nanoseconds: 100_000_000)
    c = await content()
  }
  let filter: SCContentFilter
  if target == "display" {
    guard let d = c.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? c.displays.first else { fail("no-display") }
    displayID = d.displayID
    filter = SCContentFilter(display: d, excludingWindows: [])
  } else {
    guard let id = UInt32(target), let w = c.windows.first(where: { $0.windowID == id }) else { fail("window-gone") }
    windowID = w.windowID
    filter = SCContentFilter(desktopIndependentWindow: w)
  }
  let scale = Double(filter.pointPixelScale)
  var width = Double(filter.contentRect.width) * scale
  var height = Double(filter.contentRect.height) * scale
  // Cap the longest side, so tall windows (phone-shaped video, portrait games) are not twice the pixels.
  let longest = max(width, height)
  if longest > maxWidth { width = width * maxWidth / longest; height = height * maxWidth / longest }
  let config = SCStreamConfiguration()
  config.width = max(2, Int(width) & ~1)
  config.height = max(2, Int(height) & ~1)
  // Slightly under 1/fps: exactly 1/30 at 60 Hz misses every other vsync and judders between 30 and 20 fps.
  config.minimumFrameInterval = CMTime(value: 1000, timescale: fps * 1050)
  config.queueDepth = 8
  config.showsCursor = true
  config.pixelFormat = useH264 ? kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange : kCVPixelFormatType_32BGRA
  if useH264 { startEncoder(width: Int32(config.width), height: Int32(config.height)) }
  let stream = SCStream(filter: filter, configuration: config, delegate: output)
  activeStream = stream
  do { try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames")) }
  catch { fail("capture-failed: \(error.localizedDescription)") }
  stream.startCapture { error in if let error { fail("capture-failed: \(error.localizedDescription)") } }
  // Retry stalled flow control even when the screen is idle.
  let timer = DispatchSource.makeTimerSource(queue: gate)
  timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
  timer.setEventHandler { pump() }
  timer.resume()
  stallTimer = timer
}

// ---- Input --------------------------------------------------------------------------------
// One command per stdin line, coordinates normalized 0..1 to the captured area.
//   m x y | d x y button | u x y button | w dx dy | k keycode 1/0 | s ms (pause) | a frames | kf
var cachedArea = CGRect.zero
var cachedAt = 0.0
func area() -> CGRect {
  if now() - cachedAt < 250 { return cachedArea }
  cachedAt = now()
  if let id = windowID,
     let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
     let b = list.first?[kCGWindowBounds as String] as? NSDictionary,
     let rect = CGRect(dictionaryRepresentation: b) { cachedArea = rect }
  else { cachedArea = CGDisplayBounds(displayID) }
  return cachedArea
}
let modifierFlags: [Int: CGEventFlags] = [56: .maskShift, 60: .maskShift, 59: .maskControl, 62: .maskControl,
                                          58: .maskAlternate, 61: .maskAlternate, 55: .maskCommand, 54: .maskCommand]
var held = CGEventFlags()
var buttons = Set<Int>()
var lastPoint = CGPoint.zero
func point(_ x: Double, _ y: Double) -> CGPoint {
  let r = area()
  return CGPoint(x: r.minX + r.width * min(max(x, 0), 1), y: r.minY + r.height * min(max(y, 0), 1))
}
func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton) {
  guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
  e.flags = held
  e.post(tap: .cghidEventTap)
}
DispatchQueue.global().async {
  while let line = readLine() {
    let p = line.split(separator: " ")
    guard let op = p.first else { continue }
    let n = p.dropFirst().compactMap { Double($0) }.filter(\.isFinite)
    switch (op, n.count) {
    case ("a", 1):
      let count = Int(min(max(n[0], 0), 1e9))
      gate.async { acknowledge(count); pump() }
    case ("s", 1):
      Thread.sleep(forTimeInterval: min(max(n[0], 0), 10_000) / 1000)
    case ("kf", 0):
      gate.async { forceKey = true; pump() }
    case ("m", 2):
      lastPoint = point(n[0], n[1])
      if buttons.contains(0) { mouse(.leftMouseDragged, lastPoint, .left) }
      else if buttons.contains(1) { mouse(.rightMouseDragged, lastPoint, .right) }
      else { mouse(.mouseMoved, lastPoint, .left) }
    case ("d", 3), ("u", 3):
      lastPoint = point(n[0], n[1])
      let right = n[2] == 2
      let down = op == "d"
      if down { buttons.insert(right ? 1 : 0) } else { buttons.remove(right ? 1 : 0) }
      mouse(right ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .leftMouseDown : .leftMouseUp), lastPoint, right ? .right : .left)
    case ("w", 2):
      let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                      wheel1: Int32(min(max(n[1], -10000), 10000)), wheel2: Int32(min(max(n[0], -10000), 10000)), wheel3: 0)
      e?.post(tap: .cghidEventTap)
    case ("k", 2):
      guard n[0] >= 0, n[0] <= 127 else { continue }
      let code = Int(n[0])
      let down = n[1] == 1
      if let flag = modifierFlags[code] { if down { held.insert(flag) } else { held.remove(flag) } }
      guard let e = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: down) else { continue }
      e.flags = held
      e.post(tap: .cghidEventTap)
    default: continue
    }
  }
  _exit(0)
}
while true { try? await Task.sleep(nanoseconds: 3_600_000_000_000) }
`;
