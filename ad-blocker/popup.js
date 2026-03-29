const countEl = document.getElementById("count");
const globalToggle = document.getElementById("globalToggle");
const siteSection = document.getElementById("siteSection");
const noSite = document.getElementById("noSite");
const siteDomain = document.getElementById("siteDomain");
const siteStatus = document.getElementById("siteStatus");
const whitelistBtn = document.getElementById("whitelistBtn");
const whitelistSection = document.getElementById("whitelistSection");
const whitelistCount = document.getElementById("whitelistCount");
const whitelistList = document.getElementById("whitelistList");
const whitelistHeader = document.getElementById("whitelistHeader");
const chevron = document.getElementById("chevron");

let currentDomain = null;
let currentTabId = null;
let isWhitelisted = false;

// Extract the domain from a URL
function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Update the whitelist button and status badge
function updateSiteUI() {
  if (isWhitelisted) {
    siteStatus.textContent = "⚠ Ads allowed";
    siteStatus.className = "site-status whitelisted";
    whitelistBtn.textContent = "Block ads on this site";
    whitelistBtn.className = "whitelist-btn remove";
  } else {
    siteStatus.textContent = "✓ Protected";
    siteStatus.className = "site-status protected";
    whitelistBtn.textContent = "Allow ads on this site";
    whitelistBtn.className = "whitelist-btn add";
  }
}

// Render the whitelist
function renderWhitelist(whitelist) {
  whitelistCount.textContent = whitelist.length;

  if (whitelist.length === 0) {
    whitelistSection.style.display = "none";
    return;
  }

  whitelistSection.style.display = "block";
  whitelistList.innerHTML = "";

  if (whitelist.length === 0) {
    whitelistList.innerHTML = '<div class="whitelist-empty">No whitelisted sites</div>';
    return;
  }

  whitelist
    .slice()
    .sort()
    .forEach((domain) => {
      const item = document.createElement("div");
      item.className = "whitelist-item";

      const domainSpan = document.createElement("span");
      domainSpan.className = "whitelist-item-domain";
      domainSpan.textContent = domain;

      const removeBtn = document.createElement("button");
      removeBtn.className = "whitelist-item-remove";
      removeBtn.textContent = "✕";
      removeBtn.title = "Remove from whitelist";
      removeBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage(
          { type: "removeWhitelist", domain },
          () => {
            if (domain === currentDomain) {
              isWhitelisted = false;
              updateSiteUI();
              // Reload tab so blocks take effect
              if (currentTabId) chrome.tabs.reload(currentTabId);
            }
            refreshWhitelist();
          }
        );
      });

      item.appendChild(domainSpan);
      item.appendChild(removeBtn);
      whitelistList.appendChild(item);
    });
}

function refreshWhitelist() {
  chrome.runtime.sendMessage({ type: "getWhitelist" }, (res) => {
    renderWhitelist(res?.whitelist || []);
  });
}

// --- Init ---

// Get the active tab
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  console.log("[Popup] tabs query result:", tabs);
  if (!tabs[0]) return;
  const tab = tabs[0];
  currentTabId = tab.id;
  console.log("[Popup] active tab:", tab.id, tab.url);

  // Show blocked count
  console.log("[Popup] sending getBlockedCount for tab:", tab.id);
  chrome.runtime.sendMessage(
    { type: "getBlockedCount", tabId: tab.id },
    (res) => {
      console.log("[Popup] getBlockedCount response:", res);
      const count = res?.count || 0;
      countEl.textContent = count;
      if (count > 0) countEl.classList.remove("zero");
    }
  );

  // Check if this is a real website
  currentDomain = getDomain(tab.url);
  if (currentDomain && (tab.url.startsWith("http://") || tab.url.startsWith("https://"))) {
    siteSection.style.display = "block";
    noSite.style.display = "none";
    siteDomain.textContent = currentDomain;

    // Check whitelist status
    chrome.runtime.sendMessage(
      { type: "isWhitelisted", domain: currentDomain },
      (res) => {
        isWhitelisted = res?.whitelisted || false;
        updateSiteUI();
      }
    );
  } else {
    siteSection.style.display = "none";
    noSite.style.display = "block";
  }
});

// Global toggle
chrome.runtime.sendMessage({ type: "getEnabled" }, (res) => {
  globalToggle.checked = res?.enabled !== false;
});

globalToggle.addEventListener("change", () => {
  chrome.runtime.sendMessage({
    type: "setEnabled",
    enabled: globalToggle.checked,
  }, () => {
    if (currentTabId) chrome.tabs.reload(currentTabId);
  });
});

// Whitelist button
whitelistBtn.addEventListener("click", () => {
  if (!currentDomain) return;

  if (isWhitelisted) {
    chrome.runtime.sendMessage(
      { type: "removeWhitelist", domain: currentDomain },
      () => {
        isWhitelisted = false;
        updateSiteUI();
        refreshWhitelist();
        // Reload tab so blocks take effect
        if (currentTabId) chrome.tabs.reload(currentTabId);
      }
    );
  } else {
    chrome.runtime.sendMessage(
      { type: "addWhitelist", domain: currentDomain },
      () => {
        isWhitelisted = true;
        countEl.textContent = "0";
        countEl.classList.add("zero");
        updateSiteUI();
        refreshWhitelist();
        // Reload tab so ads can load
        if (currentTabId) chrome.tabs.reload(currentTabId);
      }
    );
  }
});

// Collapsible whitelist
whitelistHeader.addEventListener("click", () => {
  whitelistList.classList.toggle("open");
  chevron.classList.toggle("open");
});

// Load whitelist
refreshWhitelist();
