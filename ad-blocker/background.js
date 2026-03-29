// --- Click context from content script ────────────────────────────
// The content script sends us what the user clicked, so we can make
// better decisions about pop-up tabs.

const lastClickContext = {}; // keyed by tabId

// --- Pop-up tab blocking (safety net) ─────────────────────────────
// Catches new tabs/windows opened by pages that the content script missed.
// Uses click context + domain blocklist.

chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  const url = details.url;
  const sourceTabId = details.sourceTabId;

  // Check if ad blocking is globally enabled
  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled === false) {
    // console.log("[Ad Blocker] ⏭ Pop-up tab ignored — ad blocker is off globally");
    return;
  }

  // Check if the source tab's site is whitelisted
  let sourceHost = null;
  try {
    const sourceTab = await chrome.tabs.get(sourceTabId);
    sourceHost = new URL(sourceTab.url).hostname;
    const whitelist = await getWhitelist();
    if (whitelist.includes(sourceHost)) {
      // console.log("[Ad Blocker] ⏭ Pop-up tab ignored — source site whitelisted:", sourceHost);
      return;
    }
  } catch {}

  // Get click context from content script
  const clickCtx = lastClickContext[sourceTabId];
  const clickAge = clickCtx ? Date.now() - clickCtx.timestamp : Infinity;
  const recentClick = clickAge < 2000;

  // console.log("[Ad Blocker] 🔍 New tab opened:", {
  //   url: url || "about:blank",
  //   sourceTab: sourceTabId,
  //   sourceHost,
  //   clickContext: recentClick
  //     ? { element: clickCtx.element, isInteractive: clickCtx.isInteractive, linkHref: clickCtx.linkHref }
  //     : "no recent click",
  // });

  if (!recentClick) {
    // console.log("[Ad Blocker] ⚠️ No recent click context — falling through to domain check only");
  }

  // BLOCK: recent click was on a non-interactive element → pop-up ad
  if (recentClick && !clickCtx.isInteractive) {
    // console.log("[Ad Blocker] 🚫 Closed pop-up tab — triggered by non-interactive click on:", clickCtx.element, "→", url);
    chrome.tabs.remove(details.tabId);
    return;
  }

  // BLOCK: recent click was on a link, but this tab goes to a different domain (hijack)
  if (recentClick && clickCtx.linkHref && url && url !== "about:blank") {
    try {
      const linkHost = new URL(clickCtx.linkHref).hostname;
      const popupHost = new URL(url).hostname;
      if (linkHost !== popupHost && sourceHost !== popupHost) {
        // console.log("[Ad Blocker] 🚫 Closed hijacked pop-up — clicked link →", linkHost, "but tab opened →", popupHost);
        chrome.tabs.remove(details.tabId);
        return;
      }
    } catch {}
  }

  if (!url || url === "about:blank") {
    // console.log("[Ad Blocker] 🔍 Monitoring about:blank pop-up tab:", details.tabId);
    setTimeout(async () => {
      try {
        const tab = await chrome.tabs.get(details.tabId);
        if (tab.url && tab.url !== "about:blank") {
          const matches = await chrome.declarativeNetRequest.getMatchedRules({
            tabId: details.tabId,
          });
          if (matches.rulesMatchedInfo.length > 0) {
            // console.log("[Ad Blocker] 🚫 Closed pop-up tab that redirected to blocked domain:", tab.url);
            chrome.tabs.remove(details.tabId);
          } else {
            // console.log("[Ad Blocker] ✅ about:blank pop-up allowed — redirected to:", tab.url);
          }
        }
      } catch {}
    }, 1500);
    return;
  }

  // For non-blank URLs, also check against domain blocklist
  try {
    const matches = await chrome.declarativeNetRequest.testMatchOutcome({
      url,
      type: "sub_frame",
      initiator: new URL((await chrome.tabs.get(sourceTabId)).url).origin,
    });
    const blocked = matches.matchedRules.some((r) => r.action?.type === "block");
    if (blocked) {
      // console.log("[Ad Blocker] 🚫 Closed pop-up tab to blocked domain:", url);
      chrome.tabs.remove(details.tabId);
    } else {
      // console.log("[Ad Blocker] ✅ Pop-up tab allowed:", url);
    }
  } catch {}
});

// --- Blocked count tracking ---
// Use onRuleMatchedDebug for live counting, with a one-time
// getMatchedRules catch-up when the popup opens (in case the
// service worker was asleep and missed events).

const blockedCounts = {};
const catchUpDone = {};

function updateBadge(tabId) {
  const count = blockedCounts[tabId] || 0;
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#e74c3c", tabId });
}

// Live event listener — counts blocks as they happen
chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
  const tabId = info.request.tabId;
  if (tabId < 0) return;
  blockedCounts[tabId] = (blockedCounts[tabId] || 0) + 1;
  updateBadge(tabId);
});

// Reset count when a tab navigates
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    blockedCounts[tabId] = 0;
    catchUpDone[tabId] = false;
    updateBadge(tabId);
  }
});

// Clean up when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete blockedCounts[tabId];
  delete catchUpDone[tabId];
});

// One-time catch-up: if the service worker was asleep and missed
// events, ask Chrome for the real count. Only called from popup.
async function getCountForTab(tabId) {
  if (!catchUpDone[tabId]) {
    try {
      const result = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
      const apiCount = result.rulesMatchedInfo.length;
      // Use whichever is higher — the live count or the API count
      if (apiCount > (blockedCounts[tabId] || 0)) {
        blockedCounts[tabId] = apiCount;
        updateBadge(tabId);
      }
      catchUpDone[tabId] = true;
    } catch (err) {
      // console.warn("[AdBlocker] getMatchedRules catch-up failed:", err.message);
    }
  }
  return blockedCounts[tabId] || 0;
}

// --- Whitelist management ---

const WHITELIST_ID_BASE = 90001;

async function getWhitelist() {
  const data = await chrome.storage.local.get("whitelist");
  return data.whitelist || [];
}

async function saveWhitelist(whitelist) {
  await chrome.storage.local.set({ whitelist });
}

async function syncWhitelistRules() {
  const whitelist = await getWhitelist();

  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existingRules.map((r) => r.id);

  const addRules = whitelist.map((domain, i) => ({
    id: WHITELIST_ID_BASE + i,
    priority: 2,
    action: { type: "allowAllRequests" },
    condition: {
      initiatorDomains: [domain],
      resourceTypes: [
        "main_frame",
        "sub_frame",
        "script",
        "image",
        "xmlhttprequest",
        "media",
        "other",
      ],
    },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds,
    addRules,
  });
}

async function addToWhitelist(domain) {
  const whitelist = await getWhitelist();
  if (!whitelist.includes(domain)) {
    whitelist.push(domain);
    await saveWhitelist(whitelist);
    await syncWhitelistRules();
  }
}

async function removeFromWhitelist(domain) {
  let whitelist = await getWhitelist();
  whitelist = whitelist.filter((d) => d !== domain);
  await saveWhitelist(whitelist);
  await syncWhitelistRules();
}

// --- Message handling ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Store click context from content script
  if (message.type === "clickContext") {
    const tabId = sender.tab?.id;
    if (tabId) {
      lastClickContext[tabId] = message;
      // console.log("[Ad Blocker] 📌 Click context received from tab", tabId + ":", {
      //   element: message.element,
      //   isInteractive: message.isInteractive,
      //   linkHref: message.linkHref,
      // });
    }
    return;
  }

  if (message.type === "getBlockedCount") {
    getCountForTab(message.tabId).then((count) => sendResponse({ count }));
    return true;
  }

  if (message.type === "getEnabled") {
    chrome.storage.local.get("enabled", (data) => {
      sendResponse({ enabled: data.enabled !== false });
    });
    return true;
  }

  if (message.type === "setEnabled") {
    const enabled = message.enabled;
    chrome.storage.local.set({ enabled });
    chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enabled ? ["default_rules"] : [],
      disableRulesetIds: enabled ? [] : ["default_rules"],
    });
    sendResponse({ success: true });
    return;
  }

  if (message.type === "getWhitelist") {
    getWhitelist().then((whitelist) => sendResponse({ whitelist }));
    return true;
  }

  if (message.type === "isWhitelisted") {
    getWhitelist().then((whitelist) => {
      sendResponse({ whitelisted: whitelist.includes(message.domain) });
    });
    return true;
  }

  if (message.type === "addWhitelist") {
    addToWhitelist(message.domain).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === "removeWhitelist") {
    removeFromWhitelist(message.domain).then(() =>
      sendResponse({ success: true })
    );
    return true;
  }
});
