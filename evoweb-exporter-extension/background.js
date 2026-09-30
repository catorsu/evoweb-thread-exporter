import { attachDownloadPort, isThread } from "./download.mjs";

chrome.runtime.onConnect.addListener((port) => {
  attachDownloadPort(port, { extensionId: chrome.runtime.id });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !isThread(tab.url)) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "OPEN" });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: "Open a thread at https://evoweb.uk, then click again.",
    });
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: "ISOLATED",
      files: ["transport.js", "exporter.js"],
    });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: "Evo-Web exporter is ready on the page.",
    });
  } catch (error) {
    console.error("Could not open Evo-Web exporter:", error);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "ERR" });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: `Refresh the thread and check extension site access. ${error.message}`,
    });
  }
});
