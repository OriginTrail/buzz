// Open a memory-panel link in the system browser. Raw `target="_blank"`
// anchors are at the native webview's mercy (macOS WKWebView swallows the
// new-window request unless something handles it), so left-clicks go through
// the Tauri opener plugin — the same path the in-app "Open link" action and
// the Rust side use — with window.open as a non-Tauri fallback.
import { openUrl } from "@tauri-apps/plugin-opener";

export function openExternal(
  event: { preventDefault: () => void },
  href: string,
): void {
  event.preventDefault();
  void openUrl(href).catch(() => {
    window.open(href, "_blank", "noreferrer");
  });
}
