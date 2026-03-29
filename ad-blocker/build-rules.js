#!/usr/bin/env node

// Fetches popular ad/tracking domain blocklists and converts them
// to Chrome declarativeNetRequest rules.
//
// Usage: node build-rules.js

const fs = require("fs");
const https = require("https");
const http = require("http");

// Public blocklist sources (hosts-file format or domain lists)
const SOURCES = [
  // Peter Lowe's ad/tracking server list (~3,500 domains)
  "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext",
  // AdGuard simplified domain names filter
  "https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt",
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, { headers: { "User-Agent": "AdblockerRuleBuilder/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// Parse various formats into a set of domains
function parseDomains(text) {
  const domains = new Set();
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;

    // hosts file format: "127.0.0.1 domain.com" or "0.0.0.0 domain.com"
    const hostsMatch = line.match(/^(?:127\.0\.0\.1|0\.0\.0\.0)\s+(.+)/);
    if (hostsMatch) {
      const domain = hostsMatch[1].trim().split(/\s+/)[0];
      if (domain && domain !== "localhost" && domain.includes(".")) {
        domains.add(domain.toLowerCase());
      }
      continue;
    }

    // AdGuard/ABP format: "||domain.com^"
    const adguardMatch = line.match(/^\|\|([a-z0-9][a-z0-9\-.]+\.[a-z]{2,})\^?\s*$/i);
    if (adguardMatch) {
      domains.add(adguardMatch[1].toLowerCase());
      continue;
    }

    // Plain domain format (one domain per line, no spaces)
    if (/^[a-z0-9][a-z0-9\-.]+\.[a-z]{2,}$/.test(line)) {
      domains.add(line.toLowerCase());
    }
  }
  return domains;
}

async function main() {
  console.log("Fetching blocklists...\n");
  const allDomains = new Set();

  for (const url of SOURCES) {
    try {
      console.log(`  Fetching: ${url.substring(0, 80)}...`);
      const text = await fetch(url);
      const domains = parseDomains(text);
      console.log(`  → Got ${domains.size} domains\n`);
      for (const d of domains) allDomains.add(d);
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}\n`);
    }
  }

  // Filter out overly broad domains that might break things
  const skipDomains = new Set([
    "localhost",
    "local",
    "broadcasthost",
    "ip6-localhost",
    "ip6-loopback",
  ]);

  const filtered = [...allDomains]
    .filter((d) => !skipDomains.has(d))
    .filter((d) => d.length > 3)
    .sort();

  // Chrome allows up to 30,000 static rules. We'll use requestDomains
  // instead of urlFilter for cleaner domain-based blocking.
  // One rule can hold multiple domains, but for clarity we'll batch them.
  // Actually, we can put all domains in a single rule using requestDomains!

  // Chrome limits requestDomains to... let's batch into groups to be safe
  const BATCH_SIZE = 500;
  const rules = [];
  let ruleId = 1;

  for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
    const batch = filtered.slice(i, i + BATCH_SIZE);
    rules.push({
      id: ruleId++,
      priority: 1,
      action: { type: "block" },
      condition: {
        requestDomains: batch,
        resourceTypes: [
          "script",
          "image",
          "sub_frame",
          "xmlhttprequest",
          "media",
          "stylesheet",
          "font",
          "ping",
          "other",
        ],
      },
    });
  }

  const outPath = __dirname + "/rules.json";
  fs.writeFileSync(outPath, JSON.stringify(rules, null, 2));

  console.log(`Done! ${filtered.length} domains → ${rules.length} rules`);
  console.log(`Written to: ${outPath}`);
}

main().catch(console.error);
