/* global ChromeUtils, Services, Zotero */
/* exported install, uninstall, startup, shutdown, onMainWindowLoad, onMainWindowUnload */

var chromeHandle;
var addonRootURI;

function install(data, reason) {}

function uninstall(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }) {
  addonRootURI = rootURI;

  await Zotero.initializationPromise;

  // Register chrome:// URL mapping so dialogs and scripts can be loaded via chrome:// protocol
  const aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);

  const manifestURI = Services.io.newURI(
    "manifest.json",
    null,
    Services.io.newURI(rootURI),
  );
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "__addonRef__", "content/"],
  ]);

  // Load the bundled script via registered chrome:// URL
  Services.scriptloader.loadSubScript(
    "chrome://__addonRef__/content/scripts/index.js",
  );

  // Initialize the addon, passing rootURI
  await DoubanToZotero.Hooks.onStartup(rootURI);

  // If main window is already open, add menu items now
  // (onMainWindowLoad may not be called for already-open windows during ADDON_INSTALL)
  const win = Zotero.getMainWindow();
  if (win) {
    onMainWindowLoad({ window: win });
  }
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  // APP_SHUTDOWN = 2
  if (reason === 2) return;

  if (typeof DoubanToZotero !== "undefined") {
    DoubanToZotero.Hooks.onShutdown();
  }

  // Unregister chrome resources
  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function onMainWindowLoad({ window }) {
  if (typeof DoubanToZotero !== "undefined") {
    // Guard against duplicate calls
    if (window.document.getElementById("douban-to-zotero-menu")) return;
    DoubanToZotero.Hooks.onMainWindowLoad(window);
  }
}

function onMainWindowUnload({ window }) {
  if (typeof DoubanToZotero !== "undefined") {
    DoubanToZotero.Hooks.onMainWindowUnload(window);
  }
}
