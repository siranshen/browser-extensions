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
  if (enabled === false) return;

  // Check if the source tab's site is whitelisted
  let sourceHost = null;
  try {
    const sourceTab = await chrome.tabs.get(sourceTabId);
    sourceHost = new URL(sourceTab.url).hostname;
    const whitelist = await getWhitelist();
    if (whitelist.includes(sourceHost)) return;
  } catch {}

  // Get click context from content script
  const clickCtx = lastClickContext[sourceTabId];
  const clickAge = clickCtx ? Date.now() - clickCtx.timestamp : Infinity;
  const recentClick = clickAge < 2000;

  // BLOCK: recent click was on a non-interactive element → pop-up ad
  if (recentClick && !clickCtx.isInteractive) {
    chrome.tabs.remove(details.tabId);
    return;
  }

  // BLOCK: recent click was on a link, but this tab goes to a different domain (hijack)
  if (recentClick && clickCtx.linkHref && url && url !== "about:blank") {
    try {
      const linkHost = new URL(clickCtx.linkHref).hostname;
      const popupHost = new URL(url).hostname;
      if (linkHost !== popupHost && sourceHost !== popupHost) {
        chrome.tabs.remove(details.tabId);
        return;
      }
    } catch {}
  }

  if (!url || url === "about:blank") {
    setTimeout(async () => {
      try {
        const tab = await chrome.tabs.get(details.tabId);
        if (tab.url && tab.url !== "about:blank") {
          // Check if the tab's main URL is on a blocked domain
          const outcome = await chrome.declarativeNetRequest.testMatchOutcome({
            url: tab.url,
            type: "sub_frame",
            initiator: tab.url,
          });
          const blocked = outcome.matchedRules.some(
            (r) => r.action?.type === "block"
          );
          if (blocked) {
            chrome.tabs.remove(details.tabId);
          }
        }
      } catch {}
    }, 1500);
    return;
  }

  // For non-blank URLs, check against domain blocklist
  try {
    const matches = await chrome.declarativeNetRequest.testMatchOutcome({
      url,
      type: "sub_frame",
      initiator: new URL((await chrome.tabs.get(sourceTabId)).url).origin,
    });
    const blocked = matches.matchedRules.some(
      (r) => r.action?.type === "block"
    );
    if (blocked) {
      chrome.tabs.remove(details.tabId);
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

// Live event listener — counts blocks as they happen.
// Skip counting on whitelisted sites (the rule still "matches"
// but is overridden by the higher-priority allow rule).
chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
  const tabId = info.request.tabId;
  if (tabId < 0) return;

  // Check if this tab's site is whitelisted
  try {
    const tab = await chrome.tabs.get(tabId);
    const host = new URL(tab.url).hostname;
    const whitelist = await getWhitelist();
    if (whitelist.includes(host)) return;
  } catch {}

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
  delete lastClickContext[tabId];
});

// One-time catch-up: if the service worker was asleep and missed
// events, ask Chrome for the real count. Only called from popup.
async function getCountForTab(tabId) {
  // If whitelisted, always return 0
  try {
    const tab = await chrome.tabs.get(tabId);
    const host = new URL(tab.url).hostname;
    const whitelist = await getWhitelist();
    if (whitelist.includes(host)) return 0;
  } catch {}

  if (!catchUpDone[tabId]) {
    try {
      const result = await chrome.declarativeNetRequest.getMatchedRules({
        tabId,
      });
      const apiCount = result.rulesMatchedInfo.length;
      if (apiCount > (blockedCounts[tabId] || 0)) {
        blockedCounts[tabId] = apiCount;
        updateBadge(tabId);
      }
      catchUpDone[tabId] = true;
    } catch {}
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

// Sync whitelist rules on startup in case storage and dynamic rules drifted
syncWhitelistRules();

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
  // Store click context from content script (via postMessage bridge)
  if (message.type === "clickContext") {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      lastClickContext[tabId] = message;
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
    chrome.declarativeNetRequest
      .updateEnabledRulesets({
        enableRulesetIds: enabled ? ["default_rules"] : [],
        disableRulesetIds: enabled ? [] : ["default_rules"],
      })
      .then(() => sendResponse({ success: true }));
    return true;
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
