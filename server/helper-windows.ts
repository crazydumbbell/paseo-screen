// C# source for the Windows capture/input helper, compiled once per source hash with the csc.exe
// that ships with .NET Framework 4 on every Windows 10/11 install. C# 5: no $"", ?., or =>-members.
// Same command line and stdin/stdout protocol as the macOS helper in helper-source.ts.
export const HELPER_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Helper {
  // ---- Win32 ---------------------------------------------------------------------------------
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public int mouseData; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PROCESSENTRY32 {
    public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  delegate bool EnumWindowsProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
  [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
  [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int w, int h, int step, IntPtr brush, int flags);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr d);
  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  // ---- Output ----------------------------------------------------------------------------------
  static readonly Stream stdout = Console.OpenStandardOutput();
  static readonly object outLock = new object();
  static void Emit(byte[] data) {
    lock (outLock) {
      try { stdout.Write(data, 0, data.Length); stdout.Flush(); } catch (IOException) { Environment.Exit(0); }
    }
  }
  static void Fail(string message) {
    Console.Error.WriteLine(message);
    Console.Error.Flush();
    Environment.Exit(2);
  }
  static double Now() { return clock.Elapsed.TotalMilliseconds; }
  static readonly Stopwatch clock = Stopwatch.StartNew();

  static string Json(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  // ---- Windows and processes -------------------------------------------------------------------
  static Dictionary<uint, string> exeNames = new Dictionary<uint, string>();
  static List<uint[]> parents = new List<uint[]>();
  static void ReadProcesses() {
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return;
    var e = new PROCESSENTRY32();
    e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
    for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e)) {
      exeNames[e.th32ProcessID] = Path.GetFileNameWithoutExtension(e.szExeFile);
      parents.Add(new uint[] { e.th32ProcessID, e.th32ParentProcessID });
    }
    CloseHandle(snap);
  }

  static RECT Bounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }

  static void List() {
    ReadProcesses();
    var items = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      if ((GetWindowLongPtr(h, -20).ToInt64() & 0x80) != 0) return true; // tool windows
      int cloaked;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      var title = new StringBuilder(512);
      GetWindowText(h, title, title.Capacity);
      if (title.Length == 0) return true;
      RECT r = Bounds(h);
      int w = r.Right - r.Left, ht = r.Bottom - r.Top;
      if (w < 120 || ht < 80) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      string app;
      if (!exeNames.TryGetValue(pid, out app)) app = "pid " + pid;
      items.Add("{\"id\":" + h.ToInt64() + ",\"pid\":" + pid + ",\"app\":" + Json(app) + ",\"title\":" + Json(title.ToString()) +
                ",\"width\":" + w + ",\"height\":" + ht + "}");
      return true;
    }, IntPtr.Zero);
    var tree = new List<string>();
    foreach (var p in parents) tree.Add("[" + p[0] + "," + p[1] + "]");
    var json = "{\"canControl\":true,\"windows\":[" + string.Join(",", items) + "],\"parents\":[" + string.Join(",", tree) + "]}";
    Emit(Encoding.UTF8.GetBytes(json));
  }

  // ---- Capture -----------------------------------------------------------------------------------
  static IntPtr window = IntPtr.Zero; // zero = primary display

  static Rectangle Area() {
    if (window == IntPtr.Zero) return new Rectangle(0, 0, GetSystemMetrics(0), GetSystemMetrics(1));
    RECT r = Bounds(window);
    return new Rectangle(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
  }

  static void DrawCursor(Graphics g, Rectangle area) {
    var ci = new CURSORINFO();
    ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref ci) || (ci.flags & 1) == 0) return;
    ICONINFO info;
    int hx = 0, hy = 0;
    if (GetIconInfo(ci.hCursor, out info)) {
      hx = info.xHotspot; hy = info.yHotspot;
      if (info.hbmMask != IntPtr.Zero) DeleteObject(info.hbmMask);
      if (info.hbmColor != IntPtr.Zero) DeleteObject(info.hbmColor);
    }
    int x = ci.pt.X - area.X - hx, y = ci.pt.Y - area.Y - hy;
    if (x < -64 || y < -64 || x > area.Width || y > area.Height) return;
    IntPtr hdc = g.GetHdc();
    DrawIconEx(hdc, x, y, ci.hCursor, 0, 0, 0, IntPtr.Zero, 3);
    g.ReleaseHdc(hdc);
  }

  /** Full-resolution picture of the target, or null when it cannot be captured right now. */
  static Bitmap Capture() {
    if (window != IntPtr.Zero && !IsWindow(window)) Fail("window-gone");
    if (window != IntPtr.Zero && IsIconic(window)) return null;
    Rectangle area = Area();
    if (area.Width < 2 || area.Height < 2) return null;
    var bmp = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppRgb);
    using (var g = Graphics.FromImage(bmp)) {
      bool done = false;
      if (window != IntPtr.Zero) {
        // PrintWindow renders the window even when covered. It draws the full GetWindowRect,
        // which can include invisible resize borders around the DWM frame bounds.
        RECT wr;
        GetWindowRect(window, out wr);
        using (var full = new Bitmap(Math.Max(1, wr.Right - wr.Left), Math.Max(1, wr.Bottom - wr.Top), PixelFormat.Format32bppRgb))
        using (var fg = Graphics.FromImage(full)) {
          IntPtr hdc = fg.GetHdc();
          done = PrintWindow(window, hdc, 2);
          fg.ReleaseHdc(hdc);
          // Some GPU-drawn windows (Vulkan, flip-model DirectX) come back black; copy the screen instead.
          if (done && IsBlack(full)) done = false;
          if (done) g.DrawImageUnscaled(full, wr.Left - area.X, wr.Top - area.Y);
        }
      }
      if (!done) {
        IntPtr dst = g.GetHdc();
        IntPtr screen = GetDC(IntPtr.Zero);
        BitBlt(dst, 0, 0, area.Width, area.Height, screen, area.X, area.Y, 0x00CC0020 | 0x40000000);
        ReleaseDC(IntPtr.Zero, screen);
        g.ReleaseHdc(dst);
      }
      DrawCursor(g, area);
    }
    return bmp;
  }

  static unsafe bool IsBlack(Bitmap bmp) {
    var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
    bool black = true;
    for (int i = 1; i < 16 && black; i++)
      for (int j = 1; j < 16 && black; j++) {
        uint* row = (uint*)((byte*)data.Scan0 + (long)(data.Height * i / 16) * data.Stride);
        if ((row[data.Width * j / 16] & 0xFFFFFFu) != 0) black = false;
      }
    bmp.UnlockBits(data);
    return black;
  }

  static Bitmap Fit(Bitmap src, int maxSide, bool byWidth) {
    double scale = byWidth ? (double)maxSide / src.Width : (double)maxSide / Math.Max(src.Width, src.Height);
    if (scale >= 1) return src;
    int w = Math.Max(2, (int)(src.Width * scale)), h = Math.Max(2, (int)(src.Height * scale));
    var dst = new Bitmap(w, h, PixelFormat.Format32bppRgb);
    using (var g = Graphics.FromImage(dst)) {
      g.InterpolationMode = InterpolationMode.Bilinear;
      g.PixelOffsetMode = PixelOffsetMode.Half;
      g.DrawImage(src, 0, 0, w, h);
    }
    src.Dispose();
    return dst;
  }

  static unsafe ulong Fingerprint(Bitmap bmp) {
    var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
    ulong h = 14695981039346656037UL;
    for (int y = 0; y < data.Height; y++) {
      uint* row = (uint*)((byte*)data.Scan0 + (long)y * data.Stride);
      for (int x = 0; x < data.Width; x++) h = (h ^ (row[x] & 0xFFFFFFu)) * 1099511628211UL;
    }
    bmp.UnlockBits(data);
    return h;
  }

  static ImageCodecInfo jpegCodec;
  static byte[] Jpeg(Bitmap bmp, long quality) {
    if (jpegCodec == null) foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpegCodec = c;
    var ps = new EncoderParameters(1);
    ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
    using (var ms = new MemoryStream()) { bmp.Save(ms, jpegCodec, ps); return ms.ToArray(); }
  }

  // ---- Flow control (same scheme as the macOS helper) ------------------------------------------
  static readonly object gate = new object();
  static int emitted, acked, windowSize = 4;
  static readonly Dictionary<int, double> sentAt = new Dictionary<int, double>();
  static readonly List<double[]> rtts = new List<double[]>();
  static double lastAck = 0;
  static bool forceFrame = true;
  static int fps = 30;

  static void EmitFrame(byte type, byte[] payload) {
    var frame = new byte[payload.Length + 5];
    int len = payload.Length + 1;
    frame[0] = (byte)(len >> 24); frame[1] = (byte)(len >> 16); frame[2] = (byte)(len >> 8); frame[3] = (byte)len;
    frame[4] = type;
    Buffer.BlockCopy(payload, 0, frame, 5, payload.Length);
    lock (gate) { emitted++; sentAt[emitted] = Now(); }
    Emit(frame);
  }

  static void Acknowledge(int count) {
    lock (gate) {
      int n = Math.Min(count, emitted);
      if (n <= acked) return;
      double t = Now(), sent;
      if (sentAt.TryGetValue(n, out sent)) rtts.Add(new double[] { t, t - sent });
      for (int i = acked + 1; i <= n; i++) sentAt.Remove(i);
      acked = n;
      lastAck = t;
      rtts.RemoveAll(delegate (double[] s) { return t - s[0] > 5000; });
      double min = double.MaxValue;
      foreach (var s in rtts) min = Math.Min(min, s[1]);
      if (min < double.MaxValue) windowSize = Math.Min(Math.Max((int)Math.Ceiling(min * fps / 1000) + 2, 4), 15);
    }
  }

  static bool MaySend() {
    lock (gate) {
      if (emitted - acked >= windowSize && Now() - lastAck > 2000) { acked = emitted; lastAck = Now(); }
      return emitted - acked < windowSize;
    }
  }

  static void Stream(int maxWidth) {
    SetThreadExecutionState(0x80000000u | 0x2u | 0x1u); // keep display and system awake
    var wake = new INPUT[1];
    wake[0].type = 0; wake[0].mi.dwFlags = 0x1; // a zero mouse move wakes a sleeping display
    SendInput(1, wake, Marshal.SizeOf(typeof(INPUT)));
    lastAck = Now();
    ulong last = 0;
    double interval = 1000.0 / fps;
    while (true) {
      double started = Now();
      if (MaySend()) {
        Bitmap shot = Capture();
        if (shot != null) {
          shot = Fit(shot, maxWidth, false); // cap the longest side, like the macOS helper
          ulong print = Fingerprint(shot);
          bool force;
          lock (gate) { force = forceFrame; forceFrame = false; }
          if (force || print != last) {
            EmitFrame(0, Jpeg(shot, 55));
            last = print;
          }
          shot.Dispose();
        }
      }
      int rest = (int)(interval - (Now() - started));
      if (rest > 0) Thread.Sleep(rest);
    }
  }

  static void Shot(string path) {
    Bitmap shot = Capture();
    if (shot == null) Fail("window-minimized");
    shot = Fit(shot, 1600, false);
    shot.Save(path, ImageFormat.Png);
    Console.Out.Write(shot.Width + " " + shot.Height);
    Console.Out.Flush();
  }

  // ---- Input ---------------------------------------------------------------------------------
  static Rectangle cachedArea;
  static double cachedAt = -1000;
  static readonly HashSet<int> held = new HashSet<int>();
  static readonly HashSet<int> extendedKeys = new HashSet<int> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x6F, 0xA3, 0xA5 };

  static void Send(INPUT input) {
    var inputs = new INPUT[] { input };
    SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  static void Mouse(double nx, double ny, uint flags, int data) {
    if (Now() - cachedAt > 250) { cachedArea = Area(); cachedAt = Now(); }
    double x = cachedArea.X + cachedArea.Width * Math.Min(Math.Max(nx, 0), 1);
    double y = cachedArea.Y + cachedArea.Height * Math.Min(Math.Max(ny, 0), 1);
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = Math.Max(2, GetSystemMetrics(78)), vh = Math.Max(2, GetSystemMetrics(79));
    var input = new INPUT();
    input.type = 0;
    input.mi.dx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
    input.mi.dy = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
    input.mi.mouseData = data;
    input.mi.dwFlags = 0x1 | 0x8000 | 0x4000 | flags; // move, absolute, virtual desktop
    Send(input);
  }

  static void Wheel(int dx, int dy) {
    var input = new INPUT();
    input.type = 0;
    if (dy != 0) { input.mi.dwFlags = 0x0800; input.mi.mouseData = (int)Math.Round(dy * 1.2); Send(input); }
    if (dx != 0) { input.mi.dwFlags = 0x1000; input.mi.mouseData = (int)Math.Round(-dx * 1.2); Send(input); }
  }

  static void Key(int vk, bool down) {
    var input = new INPUT();
    input.type = 1;
    input.ki.wVk = (ushort)vk;
    input.ki.wScan = (ushort)MapVirtualKey((uint)vk, 0);
    // Scan codes reach games that read physical keys (Godot does); extended keys need the flag.
    input.ki.dwFlags = 0x8 | (extendedKeys.Contains(vk) ? 0x1u : 0u) | (down ? 0u : 0x2u);
    if (input.ki.wScan == 0) input.ki.dwFlags &= ~0x8u;
    Send(input);
    if (down) held.Add(vk); else held.Remove(vk);
  }

  static void Activate() {
    if (window == IntPtr.Zero) return;
    if (IsIconic(window)) ShowWindow(window, 9);
    // Windows only lets the foreground app hand over focus; a synthetic Alt press counts as user input.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    SetForegroundWindow(window);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    Thread.Sleep(150);
  }

  static void ReadInput() {
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      var parts = line.Split(' ');
      var n = new List<double>();
      for (int i = 1; i < parts.Length; i++) {
        double v;
        if (double.TryParse(parts[i], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v) &&
            !double.IsNaN(v) && !double.IsInfinity(v)) n.Add(v);
      }
      string op = parts[0];
      if (op == "a" && n.Count == 1) Acknowledge((int)Math.Min(Math.Max(n[0], 0), 1e9));
      else if (op == "kf" && n.Count == 0) { lock (gate) forceFrame = true; }
      else if (op == "s" && n.Count == 1) Thread.Sleep((int)Math.Min(Math.Max(n[0], 0), 10000));
      else if (op == "m" && n.Count == 2) Mouse(n[0], n[1], 0, 0);
      else if ((op == "d" || op == "u") && n.Count == 3) {
        bool right = n[2] == 2, down = op == "d";
        Mouse(n[0], n[1], right ? (down ? 0x8u : 0x10u) : (down ? 0x2u : 0x4u), 0);
      }
      else if (op == "w" && n.Count == 2) Wheel((int)Math.Min(Math.Max(n[0], -10000), 10000), (int)Math.Min(Math.Max(n[1], -10000), 10000));
      else if (op == "k" && n.Count == 2 && n[0] > 0 && n[0] < 256) Key((int)n[0], n[1] == 1);
    }
    foreach (int vk in new List<int>(held)) Key(vk, false);
    Environment.Exit(0);
  }

  // ---- Main ------------------------------------------------------------------------------------
  static void Main(string[] args) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
    IntPtr desk = OpenInputDesktop(0, false, 0x0100);
    if (desk == IntPtr.Zero) Fail("screen-locked");
    CloseDesktop(desk);

    string mode = args.Length > 0 ? args[0] : "";
    if (mode == "list") { List(); return; }
    if (args.Length < 2) Fail("usage: helper list | input <display|hwnd> | shot <display|hwnd> <path> | stream <display|hwnd> <fps> <maxWidth> <codec>");
    if (args[1] != "display") {
      long id;
      if (!long.TryParse(args[1], out id) || !IsWindow(new IntPtr(id))) Fail("window-gone");
      window = new IntPtr(id);
    }
    if (mode == "shot" && args.Length >= 3) { Shot(args[2]); return; }
    if (mode == "input") { Activate(); ReadInput(); return; }
    if (mode == "stream" && args.Length >= 4) {
      fps = Math.Max(1, Math.Min(60, int.Parse(args[2])));
      var reader = new Thread(ReadInput);
      reader.IsBackground = true;
      reader.Start();
      Stream(Math.Max(320, int.Parse(args[3])));
      return;
    }
    Fail("bad-arguments");
  }
}
`;
