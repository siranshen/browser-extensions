// ─── Content Bridge (Isolated World) ──────────────────────────────
// Runs in Chrome's isolated world where chrome.runtime is available.
// Communicates with the MAIN world content script via window.postMessage
// and relays click context to the background script.

(() => {
  "use strict";

  // Fetch whitelist/enabled status and pass to MAIN world
  chrome.runtime.sendMessage(
    { type: "isWhitelisted", domain: location.hostname },
    (res) => {
      window.postMessage(
        {
          source: "adblocker-bridge",
          type: "config",
          whitelisted: res?.whitelisted || false,
        },
        "*"
      );
    }
  );

  chrome.runtime.sendMessage({ type: "getEnabled" }, (res) => {
    window.postMessage(
      {
        source: "adblocker-bridge",
        type: "config",
        globalEnabled: res?.enabled !== false,
      },
      "*"
    );
  });

  // Relay click context from MAIN world to background script
  window.addEventListener("message", (e) => {
    if (e.data?.source !== "adblocker-main") return;
    if (e.data.type === "clickContext") {
      try {
        chrome.runtime.sendMessage({
          type: "clickContext",
          element: e.data.element,
          isInteractive: e.data.isInteractive,
          linkHref: e.data.linkHref,
          timestamp: e.data.timestamp,
        });
      } catch {}
    }
  });
})();
