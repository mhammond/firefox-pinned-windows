# Pinned Windows extension for Firefox

This extension implements a concept similar to Pinned Tabs, but for Firefox
windows.  Once a window is pinned, all new tabs that would have previously
been opened in that window are now opened in a different, non-pinned window.

It is most useful for people who generally have multiple Firefox windows open,
with each window dedicated to a particular site or task.

Note that you can still drag and drop tabs to and from pinned windows - this
only affects new tabs that would be opened by clicking on a link.

This extension adds a new item to the Context menu - "Pin Window" which toggles
the pinned state for that window.  The pinned state is stored with
SessionRestore, so the pinned or unpinned state of windows remains across
browser restarts.

## Use-cases

### IRCCloud

You use IRCCloud for IRC conversations, and have IRCCloud open in its own
window.  Normally, if you click on links in the IRC channel, links are opened
in the same window with IRCCloud open.

If you pin the IRCClould window, such links now open in a different browser
window.

### Music Window

You have a window open which is dedicated to listening to music - eg, this
window might have a Pandora tab open along with a streaming radio station.

If you interact with this window (eg, start music playing), then go back to
reading your email via Thunderbird, then click on a link in your email.
Normally, this link will open in this music window, as that is now the most
recent Firefox window you interacted with.  You then need to drag the tab
back to a normal window so the music window keeps only music related sites
open.

If you pin this music window, the link you follow from your mail client will
open in a different browser window instead of in the music window.

# Development

The easiest way to develop/debug this is:

* In your profile directory's "extensions" subdir, create a file named
  pinned-window@mhammond.github.com
* Add a line to this file with the full path to the addon source dir.  Be sure
  to include the trailing slash (or backslash if on Windows)
* Start Firefox
* To see verbose debug messages, create a boolean preference
  "extensions.pinnedwindow.verbose" to true - message will be
  sent to the browser console.
