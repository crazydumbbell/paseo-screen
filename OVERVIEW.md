# Run & Watch

Run an app or game on a Mac host and watch and play it from any Paseo desktop app connected to that host. Useful when the code lives on a laptop but you sit at another computer.

Open **화면** from a workspace's + menu, type a command such as `godot --path .`, and press 실행. The command runs in the workspace folder through a login shell, and the tab switches to the first window the app opens. You can also pick any open window or the whole screen. Mouse, wheel, and keyboard input in the tab go to the host while the view has focus. The tab shows frame rate, bandwidth, and the app's last log line.

Agents on the host get five tools: `screen_run`, `screen_stop`, `screen_status` (running state, exit code, recent output), `screen_capture` (saves a PNG and returns its path), and `screen_input` (clicks and key presses in screenshot coordinates). An agent can launch the game, look at it, and play through a menu while you watch in the same tab.

## Setup

The host must be a Mac running macOS 14 or later with Xcode Command Line Tools (`xcode-select --install`). On first use the plugin compiles a small Swift helper into `~/Library/Caches/paseo-screen`. Grant Paseo Screen Recording to capture and Accessibility to send input. The helper is rebuilt when the plugin updates. If the host has an Apple Development certificate it is signed with it, so the approval carries over. Otherwise macOS asks again after an update.

## How it streams

Video is H.264 at up to 30 fps and 1280 pixels wide, encoded with VideoToolbox on the host and decoded with WebCodecs in the app. A moving game window takes about 180 KB/s, and a still screen sends nothing. The host only sends as many frames as the link has acknowledged, so a slow relay drops frames instead of falling behind. Clients without WebCodecs get JPEG.

## Limits

- The view works in the desktop and web apps, not on phones.
- Sound is not streamed.
- A locked host screen cannot be captured. Streaming wakes the display and keeps it on, but set the host to not require a password after the display sleeps.
- Resizing the captured window while streaming keeps the old frame size until you pick the window again.
- The tab's buttons and labels are in Korean.
