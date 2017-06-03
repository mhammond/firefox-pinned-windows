const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/sessionstore/SessionStore.jsm");

const SS_KEY_PINNED = "pinnedwindow:pinned";

function log(what) {
  console.log(" *** pinnedwindow: ", what);
}

// Convert chromeWindows <-> windowIds
// Return the webext windowId for a chrome window.
function getWindowId(domWindow) {
  let wu = domWindow.QueryInterface(Ci.nsIDOMWindow)
                    .QueryInterface(Ci.nsIInterfaceRequestor)
                    .getInterface(Ci.nsIDOMWindowUtils);
  return wu.outerWindowID;
}

// Return a chrome window for a webext windowID
function getChromeWindow(windowId) {
  let windowEnum = Services.wm.getEnumerator("navigator:browser");
  while (windowEnum.hasMoreElements()) {
    let domWindow = windowEnum.getNext();
    if (getWindowId(domWindow) == windowId) {
      return domWindow;
    }
  }
  return null;
}

// WebExtension shims
// webext key is `extension:${extensionId}:${key}`, val is JSON (bug 1322060)
// (but still not finalized...)
const WEBEXT_SS_KEY = "extension:pinned-window@mhammond.github.com:pinned";

function isPinned(windowId) {
  let chromeWindow = getChromeWindow(windowId);
  if (!chromeWindow) {
    return false;
  }

  // old-school addon set SS_KEY_PINNED - if that exists, migrate now.
  // XXX - not sure this actually works - it's difficult to test as debugging
  // involves the old addon being shutdown which removes the old pinned value.
  // Hopefully the upgrade process doesn't have the same issue.
  let pinned = SessionStore.getWindowValue(chromeWindow, SS_KEY_PINNED);
  if (pinned) {
    SessionStore.setWindowValue(chromeWindow, WEBEXT_SS_KEY, "true");
    // and delete the old one.
    SessionStore.deleteWindowValue(chromeWindow, SS_KEY_PINNED);
    log("migrated window with id " + windowId + " as pinned");
    return true;
  }
  // doesn't have the old key - look for the new one.
  pinned = SessionStore.getWindowValue(chromeWindow, WEBEXT_SS_KEY);
  return !!pinned;
}

function updateWindowPin(windowId, pinned) {
  // assume isPinned has migrated!
  let chromeWindow = getChromeWindow(windowId);
  if (pinned) {
    SessionStore.setWindowValue(chromeWindow, WEBEXT_SS_KEY, "true");
  } else {
    SessionStore.deleteWindowValue(chromeWindow, WEBEXT_SS_KEY);
  }
}

// We used to be in the "Tools" menu - to help avoid confusing users, add an
// entry there pointing at the context menu. This will be removed in the
// next version!
function loadIntoWindow(window) {
  if (window.document.getElementById("pinnedwindow-migrate-menuitem")) {
    return; // menu already exists.
  }
  let menuItem = window.document.createElement("menuitem");
  menuItem.setAttribute("id", "pinnedwindow-migrate-menuitem");
  menuItem.setAttribute("label", "(Pin/Unpin Window is now on the context menu!)");
  let menu = window.document.getElementById("menu_ToolsPopup");
  if (menu) {
    menu.appendChild(menuItem);
  }
}

let windowListener = {
  onOpenWindow: function(aWindow) {
    // Wait for the window to finish loading
    let domWindow = aWindow.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowInternal || Ci.nsIDOMWindow);
    domWindow.addEventListener("load", function onLoad() {
      domWindow.removeEventListener("load", onLoad, false);
      loadIntoWindow(domWindow);
    }, false);
  },

  onCloseWindow: function(aWindow) {},
  onWindowTitleChange: function(aWindow, aTitle) {}
};


/*
 * Extension entry points
 */
function startup({webExtension}, aReason) {
  // Load into any existing windows
  let windows = Services.wm.getEnumerator("navigator:browser");
  while (windows.hasMoreElements()) {
    let domWindow = windows.getNext().QueryInterface(Ci.nsIDOMWindow);
    loadIntoWindow(domWindow);
  }

  // Load into any new windows
  Services.wm.addListener(windowListener);

  // connect to our embedded web extension.
  webExtension.startup().then(api => {
    const {browser} = api;
    browser.runtime.onMessage.addListener((msg, sender, sendReply) => {
      try {
        if (msg.name == "is-window-pinned") {
          sendReply({pinned: isPinned(msg.windowId)});
        } else if (msg.name == "update-window-pin") {
          updateWindowPin(msg.windowId, msg.pinned);
          sendReply();
        } else {
          throw new Error("Unexpected command from extension");
        }
      } catch (err) {
        let failure = `Failed to handle message ${JSON.stringify(msg)} - ${err}\n${err.stack}\n`;
        log(failure);
        sendReply({error: failure});
      }
    });
  }).catch(err => log("Failed to init webExtension: " + err));
}

function shutdown(aData, aReason) {}
function install(aData, aReason) {}
function uninstall(aData, aReason) {}
