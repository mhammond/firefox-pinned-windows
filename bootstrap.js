const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/sessionstore/SessionStore.jsm");

const SS_KEY_PINNED = "pinnedwindow:pinned";

function log(what) {
  dump(" *** pinnedwindow: " + what + "\n");
}

function getNonPinnedWindow() {
  let enumerator = Services.wm.getEnumerator("navigator:browser");
  while (enumerator.hasMoreElements()) {
    let win = enumerator.getNext();
    if (!win.__pinned_window_monkey) {
      return win;
    }
  }
}

let patched_openURI = function (aURI, aOpener, aWhere, aContext) {
  switch (aWhere) {
    case Ci.nsIBrowserDOMWindow.OPEN_NEWWINDOW :
      return chromeWindow._origOpenURI(aURI, aOpener, aWhere, aContext);
    default :
      let newWin = getNonPinnedWindow();
      if (newWin) {
        newWin.focus();
        return newWin.nsBrowserAccess.prototype.openURI(aURI, aOpener, aWhere, aContext);
      }
      return window.__pinned_window_monkey.openURI(aURI, aOpener, aWhere, aContext);
    }
};

let patched_openLinkIn = function openLinkIn(url, where, params) {
  if (where == "current" || where == "tab") {
    let win = getNonPinnedWindow();
    if (win) {
      win.focus();
      return win.openLinkIn(url, where, params);
    }
  }
  window.__pinned_window_monkey.openLinkIn(url, where, params);
};

function installPatchesIntoWindow(chromeWindow) {
  let save = chromeWindow.__pinned_window_monkey = {};
  save['openURI'] = chromeWindow.nsBrowserAccess.prototype.openURI;
  chromeWindow.nsBrowserAccess.prototype.openURI = patched_openURI;

  save['openLinkIn'] = chromeWindow.openLinkIn;
  chromeWindow.openLinkIn = patched_openLinkIn;
}

function uninstallPatchesFromWindow(chromeWindow) {
  let saved = chromeWindow.__pinned_window_monkey;
  if (!saved) {
    return;
  }
  chromeWindow.nsBrowserAccess.prototype.openURI = saved['openURI'];
  chromeWindow.openLinkIn = saved['openLinkIn'];
  delete chromeWindow.__pinned_window_monkey;
  SessionStore.setWindowValue(chromeWindow, SS_KEY_PINNED, false);
}

function setPinned(menuItem, chromeWindow) {
  log("setting window as pinned");
  installPatchesIntoWindow(chromeWindow);
  menuItem.setAttribute("label", "Unpin Window");

  // and store the state in the session store.
  SessionStore.setWindowValue(chromeWindow, SS_KEY_PINNED, true);
}

function setUnpinned(menuItem, chromeWindow) {
  log("setting window as unpinned");
  uninstallPatchesFromWindow(chromeWindow);
  menuItem.setAttribute("label", "Pin Window");

  // and store the state in the session store.
  SessionStore.setWindowValue(chromeWindow, SS_KEY_PINNED, false);
}

function loadIntoWindow(window) {
  if (!window)
    return;
  // Add any persistent UI elements
  let menuItem = window.document.createElement("menuitem");
  menuItem.setAttribute("id", "pinnedwindow-menuitem");
  menuItem.addEventListener("command", function() {
    let thisWin = this.ownerDocument.defaultView;
    if (thisWin.__pinned_window_monkey) {
      // already configured, so unconfigure.
      setUnpinned(this, thisWin);
    } else {
      setPinned(this, thisWin);
    }
  }, true);
  let menu = window.document.getElementById("contentAreaContextMenu");
  menu.appendChild(menuItem);

  SessionStore.promiseInitialized.then(
    () => {
      log("SessionStore ready");
      if (SessionStore.getWindowValue(window, SS_KEY_PINNED)) {
        setPinned(menuItem, window);
      } else {
        setUnpinned(menuItem, window);
      }
    }
  );
}

function unloadFromWindow(window) {
  if (!window)
    return;
  uninstallPatchesFromWindow(window);
  window.document.getElementById("pinnedwindow-menuitem").remove();
  // Remove any persistent UI elements
  // Perform any other cleanup
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
function startup(aData, aReason) {
  // Load into any existing windows
  let windows = Services.wm.getEnumerator("navigator:browser");
  while (windows.hasMoreElements()) {
    let domWindow = windows.getNext().QueryInterface(Ci.nsIDOMWindow);
    loadIntoWindow(domWindow);
  }

  // Load into any new windows
  Services.wm.addListener(windowListener);
}

function shutdown(aData, aReason) {
  // When the application is shutting down we normally don't have to clean
  // up any UI changes made
  if (aReason == APP_SHUTDOWN)
    return;

  let wm = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);

  // Stop listening for new windows
  wm.removeListener(windowListener);

  // Unload from any existing windows
  let windows = wm.getEnumerator("navigator:browser");
  while (windows.hasMoreElements()) {
    let domWindow = windows.getNext().QueryInterface(Ci.nsIDOMWindow);
    unloadFromWindow(domWindow);
  }
}

function install(aData, aReason) {}
function uninstall(aData, aReason) {}
