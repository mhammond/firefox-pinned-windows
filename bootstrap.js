const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/sessionstore/SessionStore.jsm");

const SS_KEY_PINNED = "pinnedwindow:pinned";

const PREF_VERBOSE = "extensions.pinnedwindow.verbose";
let verbose = false;

// A weak map with the key being a window and the value being an object
// with the functions we overrode for that window.
let windowOverrides = new WeakMap();

function log(what) {
  console.log(" *** pinnedwindow: ", what);
}

function debug(what) {
  if (verbose) {
    console.log(" ***** pinnedwindow: ", what);
  }
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

// Open a new window with the specified url. Used when no non-pinned windows
// can be found.
function openNewBrowserWindow(url) {
  // Set up window.arguments.
  let sa = Cc["@mozilla.org/supports-array;1"].createInstance(Ci.nsISupportsArray);
  let wuri = null;
  if (url) {
    wuri = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
    wuri.data = url;
  }
  sa.AppendElement(wuri);
  // These 2 args apparently need to be specified, even if they are null.
  sa.AppendElement(null); // charset
  sa.AppendElement(null); // referrer
  let features = "chrome,dialog=no,all";
  let newWindow = Services.ww.openWindow(null, "chrome://browser/content/browser.xul", null, features, sa);
  newWindow.focus();
}

// Monkey-patch various browser implementation functions.
// NOTE: The 'window' variables referenced here are the global window into
// which these functions are injected.
let patched_openURI = function (window, aURI, aOpener, aWhere, aContext) {
  debug("openURI " + (aURI ? aURI.spec : "<null>") + " in " + aWhere);
  switch (aWhere) {
    case Ci.nsIBrowserDOMWindow.OPEN_NEWWINDOW:
      return windowOverrides.get(window).openURI(aURI, aOpener, aWhere, aContext);
    default :
      let newWin = getNonPinnedWindow();
      if (newWin) {
        newWin.focus();
        debug("openURI found non-pinned window");
        return newWin.nsBrowserAccess.prototype.openURI(aURI, aOpener, aWhere, aContext);
      }
      debug("openURI can't find a non-pinned window so creating a new window");
      openNewBrowserWindow(aURI.spec);
      return null;
    }
};

let patched_openURIInFrame = function(window, uri, params, where, context) {
  debug("openURIInFrame " + (uri ? uri.spec : "<null>") + " in " + where);
  let win = getNonPinnedWindow();
  if (win) {
    win.focus();
    debug("openURIInFrame found non-pinned window");
    return win.nsBrowserAccess.prototype.openURIInFrame(uri, params, where, context);
  }
  // This is very tricky to support the semantics of openURIInFrame into a new
  // window (ie, we need to wait for it to load before we can delegate it to
  // the new window, but we need the result synchronously here.)
  // So just open in this window.
  debug("openURIInFrame can't find a non-pinned window so opening in original window");
  return windowOverrides.get(window).openURIInFrame(uri, params, where, context);
}

let patched_openLinkIn = function openLinkIn(window, url, where, params) {
  debug("openLinkIn " + url + " in " + where);// + " with " + JSON.stringify(params));
  // params.allowPinnedTabHostChange is a param sent when the user enters a
  // URL into the awesomebar, so we allow that to go to the current window.
  let useSameWindow = params && params.allowPinnedTabHostChange;
  if (!useSameWindow && (where == "current" || where == "tab")) {
    let win = getNonPinnedWindow();
    if (win) {
      win.focus();
      debug("openLinkIn found non-pinned window");
      return win.openLinkIn(url, where, params);
    }
  }
  debug("openLinkIn can't find a non-pinned window so opening in new window");
  openNewBrowserWindow(url);
};

// Install the monkey-patches into a window.
function installPatchesIntoWindow(chromeWindow) {
  let save = {};
  save['openURI'] = chromeWindow.nsBrowserAccess.prototype.openURI;
  chromeWindow.nsBrowserAccess.prototype.openURI = patched_openURI.bind(this, chromeWindow);

  save['openURIInFrame'] = chromeWindow.nsBrowserAccess.prototype.openURIInFrame;
  chromeWindow.nsBrowserAccess.prototype.openURIInFrame = patched_openURIInFrame.bind(this, chromeWindow);

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
  chromeWindow.nsBrowserAccess.prototype.openURIInFrame = saved['openURIInFrame'];
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
  debug("installing pinnedwindow into new window");

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

function prefObserver(subject, topic, data) {
  switch (data) {
    case PREF_VERBOSE:
      try {
        verbose = Services.prefs.getBoolPref(PREF_VERBOSE);
      } catch (ex) {}
      break;
  }
}

/*
 * Extension entry points
 */
function startup(aData, aReason) {
  // Watch for prefs we care about.
  Services.prefs.addObserver(PREF_VERBOSE, prefObserver, false);
  // And ensure initial values are picked up.
  prefObserver(null, "", PREF_VERBOSE);

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
  Services.prefs.removeObserver(PREF_VERBOSE, prefObserver);
}

function install(aData, aReason) {}
function uninstall(aData, aReason) {}
