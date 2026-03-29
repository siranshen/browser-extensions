// ─── Pop-up Ad Blocker (Content Script) ───────────────────────────
// Detects and blocks pop-ups triggered by clicks on non-interactive
// elements (a strong signal that it's an ad, not user intent).
// Honors the per-site whitelist — does nothing on whitelisted sites.

(() => {
  "use strict";

  const PREFIX = "[Ad Blocker]";
  let whitelisted = false;

  chrome.runtime.sendMessage(
    { type: "isWhitelisted", domain: location.hostname },
    (res) => {
      whitelisted = res?.whitelisted || false;
      if (whitelisted) {
        // console.log(PREFIX, "Pop-up blocking DISABLED — site is whitelisted:", location.hostname);
      } else {
        // console.log(PREFIX, "Pop-up blocking active on:", location.hostname);
      }
    }
  );

  let globalEnabled = true;
  chrome.runtime.sendMessage({ type: "getEnabled" }, (res) => {
    globalEnabled = res?.enabled !== false;
    if (!globalEnabled) {
      // console.log(PREFIX, "Pop-up blocking DISABLED — ad blocker is off globally");
    }
  });

  function isActive() {
    return globalEnabled && !whitelisted;
  }

  // Track the most recent click target
  let lastClickTarget = null;
  let lastClickTime = 0;

  // ─── Click intent analysis ─────────────────────────────────────
  // We care about whether the user clicked something that SHOULD
  // open a new page. The key distinction:
  //
  //   INTERACTIVE (user expects navigation):
  //     <a>, <button>, <input>, <select>, <img> inside <a>,
  //     elements with role="button", role="link", onclick attr
  //
  //   NON-INTERACTIVE (user does NOT expect a pop-up):
  //     <div>, <span>, <p>, <body>, bare <img> not in a link,
  //     random page content

  const INTERACTIVE_TAGS = new Set([
    "A",
    "BUTTON",
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "SUMMARY",
    "VIDEO",
    "AUDIO",
  ]);

  // Tags that are only interactive if they're inside a link or button
  const MEDIA_TAGS = new Set(["IMG", "SVG", "PICTURE", "CANVAS"]);

  function isInteractiveElement(el) {
    let node = el;
    const isMedia = MEDIA_TAGS.has(el?.tagName);

    for (let i = 0; i < 10 && node && node !== document.body; i++) {
      // Direct interactive tag
      if (INTERACTIVE_TAGS.has(node.tagName)) return true;

      // ARIA roles
      const role = node.getAttribute("role");
      if (role === "button" || role === "link" || role === "menuitem") return true;

      // Explicit click handler (only counts for non-media elements,
      // or for any ancestor of media)
      if (node.hasAttribute("onclick") && (node !== el || !isMedia)) return true;

      // Tabindex on semantic elements
      if (
        node.hasAttribute("tabindex") &&
        node.tagName !== "DIV" &&
        node.tagName !== "SPAN"
      )
        return true;

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

  // Check if a URL goes to a different domain than the current page
  function isCrossDomain(url) {
    try {
      const targetHost = new URL(url, window.location.href).hostname;
      return targetHost !== location.hostname;
    } catch {
      return true;
    }
  }

  // ─── Share click context with background script ────────────────
  // So Layer 2 (webNavigation) can also make informed decisions

  document.addEventListener(
    "click",
    (e) => {
      lastClickTarget = e.target;
      lastClickTime = Date.now();

      // Tell background what was clicked
      const interactive = isInteractiveElement(e.target);
      const link = findNearestLink(e.target);
      const desc = describeElement(e.target);
      // console.log(PREFIX, "📌 Click detected:", {
      //   element: desc,
      //   isInteractive: interactive,
      //   nearestLink: link?.href || "none",
      // });
      chrome.runtime.sendMessage({
        type: "clickContext",
        element: desc,
        isInteractive: interactive,
        linkHref: link?.href || null,
        timestamp: Date.now(),
      });
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
      // console.log(PREFIX, "⏭ window.open SKIPPED (blocking inactive):", url);
      return originalWindowOpen.call(this, url, target, features);
    }

    if (!triggeredByClick) {
      // console.log(PREFIX, "⏭ window.open NOT from click (browser will handle):", url);
      return originalWindowOpen.call(this, url, target, features);
    }

    const clickedEl = describeElement(lastClickTarget);
    const clickedInteractive = lastClickTarget && isInteractiveElement(lastClickTarget);
    const nearestLink = findNearestLink(lastClickTarget);
    const crossDomain = url && isCrossDomain(url);

    // console.log(PREFIX, "🔍 window.open intercepted:", {
    //   url,
    //   clickedElement: clickedEl,
    //   isInteractive: clickedInteractive,
    //   nearestLink: nearestLink?.href || "none",
    //   crossDomain,
    //   timeSinceClick: timeSinceClick + "ms",
    // });

    // BLOCK: clicked on non-interactive element
    if (!clickedInteractive) {
      // console.log(PREFIX, "🚫 BLOCKED pop-up — non-interactive click on:", clickedEl, "→", url);
      return null;
    }

    // BLOCK: clicked a link but window.open goes to a different domain (hijack)
    if (nearestLink?.href && url) {
      if (!clickedLinkMatchesUrl(url)) {
        try {
          const linkHost = new URL(nearestLink.href).hostname;
          const openHost = new URL(url, window.location.href).hostname;
          if (linkHost !== openHost) {
            // console.log(PREFIX, "🚫 BLOCKED hijacked click — link →", linkHost, "but pop-up →", openHost);
            return null;
          }
        } catch {}
      }
    }

    // ALLOW
    // console.log(PREFIX, "✅ ALLOWED pop-up — legitimate interactive click:", clickedEl, "→", url);
    return originalWindowOpen.call(this, url, target, features);
  };

  // ─── Block ad overlays ──────────────────────────────────────────

  const observer = new MutationObserver((mutations) => {
    if (!isActive()) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const style = node instanceof HTMLElement && window.getComputedStyle(node);
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

        if (isFullPage && isTransparent && node.tagName !== "VIDEO" && node.tagName !== "CANVAS") {
          const hasLink = node.querySelector("a") || node.tagName === "A";
          if (hasLink || node.style.cursor === "pointer") {
            // console.log(PREFIX, "🗑 Removed invisible click overlay:", describeElement(node));
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
