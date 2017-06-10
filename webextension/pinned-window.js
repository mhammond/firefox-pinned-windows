// until bug 1322060 is fixed, we talk with a legacy addon to keep track
// of what windows are pinned or not.
async function isWindowPinned(windowId) {
  let reply = await browser.runtime.sendMessage({name: "is-window-pinned", windowId});
  return reply.pinned;
}

async function updateWindowPin(windowId, pinned) {
  return browser.runtime.sendMessage({name: "update-window-pin", windowId, pinned});
}

async function findUnpinnedWindow(windowId) {
  if (!(await isWindowPinned(windowId))) {
    return windowId;
  }
  // enumerate every other window.
  let allWindows = await browser.windows.getAll({windowTypes: ["normal"]});
  for (let info of allWindows) {
    if (info.id != windowId) {
      if (!(await isWindowPinned(info.id))) {
        return info.id;
      }
    }
  }
  return null; // no unpinned window.
}

async function moveToUnpinned(tabId, windowId, url) {
  let targetWindowId = await findUnpinnedWindow(windowId);
  if (targetWindowId == windowId) {
    // window is already unpinned, so we don't need to touch it.
    return;
  }
  if (!targetWindowId) {
    // can't find an unpinned window, so open a new one and move it there.
    targetWindowId = await browser.windows.create({tabId});
  }
  // We want to open next to the currently selected tab in the target window,
  // so get the current index (but note it can't be pinned!)
  let index = -1;
  let info = await browser.tabs.query({active: true, windowId: targetWindowId, pinned: false});
  if (info && info.length && info[0].index !== undefined) {
    index = info[0].index + 1;
  }
  // Doesn't seem a need to await for the move or update, and it's smoother if we don't.
  chrome.tabs.move(tabId, {windowId: targetWindowId, index});
  browser.windows.update(targetWindowId, {focused: true});
  // for reasons I don't understand, tabs opened because of a target=_blank
  // don't load correctly. I work around this by updating the URL too.
  let updateInfo = {active: true};
  if (url) {
    updateInfo.url = url;
  }
  browser.tabs.update(tabId, updateInfo);
}

// Let addEventListener's be safely async - errors aren't reported otherwise -
// I should file a bug :)
function runasync(asyncFun) {
  return (...args) => {
    asyncFun.apply(asyncFun, args).catch(err => console.log("Handler failed", err, err.stack));
  }
}

let lastTabId = undefined;

// This is fired immediately after the tab is created and gives us enough info
// to decide what we should do with the tab.
// Sadly though, it is *not* fired when a link is opened by an external app
// (eg, when you click on a link in your mail client)
browser.webNavigation.onCreatedNavigationTarget.addListener(runasync(async function(details) {
  console.log("onCreatedNavigationTarget", JSON.stringify(details));
  if (details.sourceFrameId == 0) {
    lastTabId = details.tabId;
    return moveToUnpinned(details.tabId, details.windowId, details.url);
  }
}));

// This is fired soon after a tab is created, but not as soon as onCreatedNavigationTarget.
// However, it *is* called when a link is opened by an external app.
// We ignore the event if it is the same tab we last saw in onCreatedNavigationTarget.
browser.webNavigation.onCommitted.addListener(runasync(async function(details) {
  console.log("onCommitted", JSON.stringify(details));
  if (details.frameId == 0 &&
      details.transitionType == "link" &&
      details.tabId != lastTabId) {
    return moveToUnpinned(details.tabId, details.windowId);
  }
}));

// Context menu support.
browser.contextMenus.create({
  id: "pinned",
  type: "checkbox",
  title: "Pin Window",
  contexts: ["all"],
});

browser.contextMenus.onClicked.addListener(runasync(async function(info, tab) {
  // toggle the window state.
  updateWindowPin(tab.windowId, info.checked);
}));

// and we need a listener to update the state of the context menu.
browser.windows.onFocusChanged.addListener(runasync(async function(windowId) {
  if (windowId != browser.windows.WINDOW_ID_NONE) {
    // Check if the window is "normal" - which throws if it isn't.
    try {
      await browser.windows.get(windowId, {windowTypes: ["normal"]});
    } catch (ex) {
      return;
    }
    let checked = await isWindowPinned(windowId);
    browser.contextMenus.update("pinned", { checked });
  }
}));

console.log(browser.runtime.id, "loaded");
