// ─── Pop-up Ad Blocker (MAIN World) ───────────────────────────────
// Runs in the page's JS context so it can override window.open.
// Communicates with the isolated world bridge via window.postMessage.

(() => {
  "use strict";

  let whitelisted = false;
  let globalEnabled = true;

  // Receive config from the bridge script (isolated world)
  window.addEventListener("message", (e) => {
    if (e.data?.source !== "adblocker-bridge") return;
    if (e.data.type === "config") {
      if ("whitelisted" in e.data) whitelisted = e.data.whitelisted;
      if ("globalEnabled" in e.data) globalEnabled = e.data.globalEnabled;
    }
  });

  function isActive() {
    return globalEnabled && !whitelisted;
  }

  // Track the most recent click target
  let lastClickTarget = null;
  let lastClickTime = 0;

  // ─── Click intent analysis ─────────────────────────────────────

  const INTERACTIVE_TAGS = new Set([
    "A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "VIDEO", "AUDIO",
  ]);

  const MEDIA_TAGS = new Set(["IMG", "SVG", "PICTURE", "CANVAS"]);

  function isInteractiveElement(el) {
    let node = el;
    const isMedia = MEDIA_TAGS.has(el?.tagName);

    for (let i = 0; i < 10 && node && node !== document.body; i++) {
      if (INTERACTIVE_TAGS.has(node.tagName)) return true;
      const role = node.getAttribute("role");
      if (role === "button" || role === "link" || role === "menuitem") return true;
      if (node.hasAttribute("onclick") && (node !== el || !isMedia)) return true;
      if (
        node.hasAttribute("tabindex") &&
        node.tagName !== "DIV" &&
        node.tagName !== "SPAN"
      ) return true;
      node = node.parentElement;
    }
    return false;
  }

  function describeElement(el) {
    if (!el) return "null";
    let desc = el.tagName;
    if (el.id) desc += `#${el.id}`;
    if (el.className && typeof el.className === "string") {
      const classes = el.className.trim();
      if (classes) desc += `.${classes.split(/\s+/).join(".")}`;
    }
    return desc;
  }

  function findNearestLink(el) {
    let node = el;
    for (let i = 0; i < 10 && node && node !== document.body; i++) {
      if (node.tagName === "A") return node;
      node = node.parentElement;
    }
    return null;
  }

  function clickedLinkMatchesUrl(url) {
    if (!lastClickTarget) return false;
    const link = findNearestLink(lastClickTarget);
    if (!link || !link.href) return false;
    try {
      const linkHost = new URL(link.href).hostname;
      const openHost = new URL(url, window.location.href).hostname;
      return linkHost === openHost;
    } catch {
      return false;
    }
  }

  // ─── Track clicks ──────────────────────────────────────────────

  document.addEventListener(
    "click",
    (e) => {
      lastClickTarget = e.target;
      lastClickTime = Date.now();

      // Send click context to bridge → background
      const interactive = isInteractiveElement(e.target);
      const link = findNearestLink(e.target);
      window.postMessage(
        {
          source: "adblocker-main",
          type: "clickContext",
          element: describeElement(e.target),
          isInteractive: interactive,
          linkHref: link?.href || null,
          timestamp: Date.now(),
        },
        "*"
      );
    },
    true
  );

  document.addEventListener(
    "mousedown",
    (e) => {
      lastClickTarget = e.target;
      lastClickTime = Date.now();
    },
    true
  );

  // ─── Override window.open ───────────────────────────────────────

  const originalWindowOpen = window.open;

  window.open = function (url, target, features) {
    const timeSinceClick = Date.now() - lastClickTime;
    const triggeredByClick = timeSinceClick < 1000;

    if (!isActive()) {
      return originalWindowOpen.call(this, url, target, features);
    }

    if (!triggeredByClick) {
      return originalWindowOpen.call(this, url, target, features);
    }

    const clickedInteractive =
      lastClickTarget && isInteractiveElement(lastClickTarget);
    const nearestLink = findNearestLink(lastClickTarget);

    // BLOCK: clicked on non-interactive element
    if (!clickedInteractive) {
      return null;
    }

    // BLOCK: clicked a link but window.open goes to a different domain (hijack)
    if (nearestLink?.href && url) {
      if (!clickedLinkMatchesUrl(url)) {
        try {
          const linkHost = new URL(nearestLink.href).hostname;
          const openHost = new URL(url, window.location.href).hostname;
          if (linkHost !== openHost) {
            return null;
          }
        } catch {}
      }
    }

    // ALLOW
    return originalWindowOpen.call(this, url, target, features);
  };

  // ─── Block ad overlays ──────────────────────────────────────────

  const observer = new MutationObserver((mutations) => {
    if (!isActive()) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const style =
          node instanceof HTMLElement && window.getComputedStyle(node);
        if (!style) continue;

        const isFullPage =
          (style.position === "fixed" || style.position === "absolute") &&
          parseFloat(style.width) >= window.innerWidth * 0.8 &&
          parseFloat(style.height) >= window.innerHeight * 0.8;

        const isTransparent =
          parseFloat(style.opacity) < 0.15 ||
          style.backgroundColor === "transparent" ||
          style.background === "transparent" ||
          style.background === "none";

        if (
          isFullPage &&
          isTransparent &&
          node.tagName !== "VIDEO" &&
          node.tagName !== "CANVAS"
        ) {
          const hasLink = node.querySelector("a") || node.tagName === "A";
          if (hasLink || node.style.cursor === "pointer") {
            node.remove();
          }
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
