const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/sessionstore/SessionStore.jsm");

const SS_KEY_PINNED = "pinnedwindow:pinned";

// A weak map with the key being a window and the value being an object
// with the functions we overrode for that window.
let windowOverrides = new WeakMap();

function log(what) {
  dump(" *** pinnedwindow: " + what + "\n");
}

// Return a window suitable for "delegating" operations to (eg, the window
// in which the tab is actually going to be opened in)
function getNonPinnedWindow() {
  let enumerator = Services.wm.getEnumerator("navigator:browser");
  while (enumerator.hasMoreElements()) {
    let win = enumerator.getNext();
    if (!windowOverrides.has(win)) {
      return win;
    }
  }
}

// Monkey-patch various browser implementation functions.
// NOTE: The 'window' variables referenced here are the global window into
// which these functions are injected.
let patched_openURI = function (window, aURI, aOpener, aWhere, aContext) {
  switch (aWhere) {
    case Ci.nsIBrowserDOMWindow.OPEN_NEWWINDOW:
      return windowOverrides.get(window).openURI(aURI, aOpener, aWhere, aContext);
    default :
      let newWin = getNonPinnedWindow();
      if (newWin) {
        newWin.focus();
        return newWin.nsBrowserAccess.prototype.openURI(aURI, aOpener, aWhere, aContext);
      }
      return windowOverrides.get(window).openURI(aURI, aOpener, aWhere, aContext);
    }
};

let patched_openLinkIn = function openLinkIn(window, url, where, params) {
  if (where == "current" || where == "tab") {
    let win = getNonPinnedWindow();
    if (win) {
      win.focus();
      return win.openLinkIn(url, where, params);
    }
  }
  windowOverrides.get(window).openLinkIn(url, where, params);
};

// Install the monkey-patches into a window.
function installPatchesIntoWindow(chromeWindow) {
  let save = {};
  save['openURI'] = chromeWindow.nsBrowserAccess.prototype.openURI;
  chromeWindow.nsBrowserAccess.prototype.openURI = patched_openURI.bind(this, chromeWindow);

  save['openLinkIn'] = chromeWindow.openLinkIn;
  chromeWindow.openLinkIn = patched_openLinkIn.bind(this, chromeWindow);
  windowOverrides.set(chromeWindow, save);
}

function uninstallPatchesFromWindow(chromeWindow) {
  let saved = windowOverrides.get(chromeWindow)
  if (!saved) {
    return;
  }
  chromeWindow.nsBrowserAccess.prototype.openURI = saved['openURI'];
  chromeWindow.openLinkIn = saved['openLinkIn'];
  windowOverrides.delete(chromeWindow);
  // remove state from the session store.
  SessionStore.deleteWindowValue(chromeWindow, SS_KEY_PINNED);
}

function setPinned(menuItem, chromeWindow) {
  log("setting window as pinned");
  installPatchesIntoWindow(chromeWindow);
  menuItem.setAttribute("label", "Unpin Window");

  // and store the state in the session store.
  SessionStore.setWindowValue(chromeWindow, SS_KEY_PINNED, "true");
}

function setUnpinned(menuItem, chromeWindow) {
  log("setting window as unpinned");
  uninstallPatchesFromWindow(chromeWindow);
  menuItem.setAttribute("label", "Pin Window");
}

// Utilities to initialize the addon...
function loadIntoWindow(window) {
  if (!window)
    return;
  let wintype = window.document.documentElement.getAttribute('windowtype');
  if (wintype != "navigator:browser") {
    log("not installing pinned-window extension into window of type " + wintype);
    return;
  }
  // Add persistent UI elements to the "Tools" ment.
  let menuItem = window.document.createElement("menuitem");
  menuItem.setAttribute("id", "pinnedwindow-menuitem");
  menuItem.addEventListener("command", function() {
    let thisWin = this.ownerDocument.defaultView;
    if (windowOverrides.get(thisWin)) {
      // already configured, so unconfigure.
      setUnpinned(this, thisWin);
    } else {
      setPinned(this, thisWin);
    }
  }, true);
  let menu = window.document.getElementById("menu_ToolsPopup");
  if (!menu) {
    // might be a popup or similar.
    log("not installing pinned-window extension into browser window as there is no Tools menu");
  }
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
    try {
      unloadFromWindow(domWindow);
    } catch (ex) {
      log("Failed to reset window: " + ex + "\n" + ex.stack);
    }
  }
}

function install(aData, aReason) {}
function uninstall(aData, aReason) {}
