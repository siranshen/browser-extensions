// ─── Helpers ───────────────────────────────────────────────────────

function originPattern(url) {
  const u = new URL(url);
  return `${u.origin}/*`;
}

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function getJsSetting(url) {
  return new Promise((resolve) => {
    chrome.contentSettings.javascript.get(
      { primaryUrl: url },
      (details) => resolve(details.setting)
    );
  });
}

async function updateBadge(tabId, url) {
  if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }

  const setting = await getJsSetting(url);
  const isOn = setting === "allow";

  chrome.action.setBadgeText({ tabId, text: isOn ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: isOn ? "#4CAF50" : "#F44336",
  });
  chrome.action.setIcon({
    tabId,
    path: isOn
      ? { 16: "icons/js-on-16.png", 48: "icons/js-on-48.png", 128: "icons/js-on-128.png" }
      : { 16: "icons/js-off-16.png", 48: "icons/js-off-48.png", 128: "icons/js-off-128.png" },
  });
}

// ─── Blacklist management ─────────────────────────────────────────

async function getBlacklist() {
  const data = await chrome.storage.local.get("jsBlacklist");
  return data.jsBlacklist || [];
}

async function addToBlacklist(domain) {
  const list = await getBlacklist();
  if (!list.includes(domain)) {
    list.push(domain);
    await chrome.storage.local.set({ jsBlacklist: list });
  }
}

async function removeFromBlacklist(domain) {
  let list = await getBlacklist();
  list = list.filter((d) => d !== domain);
  await chrome.storage.local.set({ jsBlacklist: list });
}

// ─── Message handling ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getStatus") {
    const { url } = message;
    getJsSetting(url).then((setting) => {
      sendResponse({ setting });
    });
    return true;
  }

  if (message.type === "toggle") {
    const { url, tabId } = message;
    const domain = getDomain(url);
    getJsSetting(url).then(async (current) => {
      const newValue = current === "allow" ? "block" : "allow";
      chrome.contentSettings.javascript.set(
        { primaryPattern: originPattern(url), setting: newValue },
        async () => {
          if (newValue === "block") {
            await addToBlacklist(domain);
          } else {
            await removeFromBlacklist(domain);
          }
          updateBadge(tabId, url);
          chrome.tabs.reload(tabId);
          sendResponse({ setting: newValue });
        }
      );
    });
    return true;
  }

  if (message.type === "getBlacklist") {
    getBlacklist().then((list) => sendResponse({ list }));
    return true;
  }

  if (message.type === "removeBlacklist") {
    const { domain } = message;
    // Re-enable JS for this domain on both http and https
    const httpsUrl = `https://${domain}/`;
    const httpUrl = `http://${domain}/`;
    chrome.contentSettings.javascript.set(
      { primaryPattern: originPattern(httpsUrl), setting: "allow" },
      () => {
        chrome.contentSettings.javascript.set(
          { primaryPattern: originPattern(httpUrl), setting: "allow" },
          async () => {
            await removeFromBlacklist(domain);
            sendResponse({ success: true });
          }
        );
      }
    );
    return true;
  }
});

// ─── Keep badge in sync ───────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    updateBadge(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url) updateBadge(tabId, tab.url);
});
