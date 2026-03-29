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
      console.warn("[AdBlocker] getMatchedRules catch-up failed:", err.message);
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
