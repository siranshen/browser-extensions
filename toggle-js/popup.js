const siteDomain = document.getElementById("siteDomain");
const siteStatus = document.getElementById("siteStatus");
const toggleBtn = document.getElementById("toggleBtn");
const siteSection = document.getElementById("siteSection");
const noSite = document.getElementById("noSite");
const blacklistSection = document.getElementById("blacklistSection");
const blacklistCount = document.getElementById("blacklistCount");
const blacklistList = document.getElementById("blacklistList");
const blacklistHeader = document.getElementById("blacklistHeader");
const chevron = document.getElementById("chevron");

let currentTab = null;
let currentSetting = "allow";

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

function updateUI() {
  const isOn = currentSetting === "allow";
  if (isOn) {
    siteStatus.textContent = "✓ JavaScript enabled";
    siteStatus.className = "site-status enabled";
    toggleBtn.textContent = "Disable JavaScript";
    toggleBtn.className = "toggle-btn disable";
  } else {
    siteStatus.textContent = "✗ JavaScript disabled";
    siteStatus.className = "site-status disabled";
    toggleBtn.textContent = "Enable JavaScript";
    toggleBtn.className = "toggle-btn enable";
  }
}

function renderBlacklist(list) {
  blacklistCount.textContent = list.length;
  if (list.length === 0) {
    blacklistSection.style.display = "none";
    return;
  }

  blacklistSection.style.display = "block";
  blacklistList.innerHTML = "";

  list.slice().sort().forEach((domain) => {
    const item = document.createElement("div");
    item.className = "blacklist-item";

    const domainSpan = document.createElement("span");
    domainSpan.className = "blacklist-item-domain";
    domainSpan.textContent = domain;

    const removeBtn = document.createElement("button");
    removeBtn.className = "blacklist-item-remove";
    removeBtn.textContent = "✓";
    removeBtn.title = "Re-enable JavaScript";
    removeBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "removeBlacklist", domain }, () => {
        if (currentTab && getDomain(currentTab.url) === domain) {
          currentSetting = "allow";
          updateUI();
          chrome.tabs.reload(currentTab.id);
        }
        refreshBlacklist();
      });
    });

    item.appendChild(domainSpan);
    item.appendChild(removeBtn);
    blacklistList.appendChild(item);
  });
}

function refreshBlacklist() {
  chrome.runtime.sendMessage({ type: "getBlacklist" }, (res) => {
    renderBlacklist(res?.list || []);
  });
}

// --- Init ---

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs[0]) return;
  currentTab = tabs[0];

  const domain = getDomain(currentTab.url);
  if (domain && (currentTab.url.startsWith("http://") || currentTab.url.startsWith("https://"))) {
    siteSection.style.display = "block";
    noSite.style.display = "none";
    siteDomain.textContent = domain;

    chrome.runtime.sendMessage({ type: "getStatus", url: currentTab.url }, (res) => {
      currentSetting = res?.setting || "allow";
      updateUI();
    });
  } else {
    siteSection.style.display = "none";
    noSite.style.display = "block";
  }
});

// Toggle button
toggleBtn.addEventListener("click", () => {
  if (!currentTab) return;
  chrome.runtime.sendMessage(
    { type: "toggle", url: currentTab.url, tabId: currentTab.id },
    (res) => {
      currentSetting = res?.setting || currentSetting;
      updateUI();
      refreshBlacklist();
    }
  );
});

// Collapsible blacklist
blacklistHeader.addEventListener("click", () => {
  blacklistList.classList.toggle("open");
  chevron.classList.toggle("open");
});

// Load blacklist
refreshBlacklist();
