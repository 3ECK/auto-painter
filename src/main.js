/** @file The main file. Everything in the userscript is executed from here.
 * @since 0.0.0
 */

import Overlay from './Overlay.js';
import Observers from './observers.js';
import ApiManager from './apiManager.js';
import TemplateManager from './templateManager.js';
import { consoleLog, consoleWarn, selectAllCoordinateInputs } from './utils.js';
import { initWasm, generateToken } from './wasmToken.js';

const name = GM_info.script.name.toString(); // Name of userscript
const version = GM_info.script.version.toString(); // Version of userscript
const consoleStyle = 'color: cornflowerblue;'; // The styling for the console logs

// AUTO-PAINT STATE
let isPainting = false;
let paintLoopId = null;
const TILE_SIZE = 1000; // From TemplateManager
const DEBUG_MODE = false; // Set to TRUE to log payloads without sending requests

async function handlePaintClick(overlayInstance) {
  if (isPainting) return;

  // Init WASM
  const wasmReady = await initWasm();
  if (!wasmReady) {
    overlayInstance.handleDisplayError("WASM Failed to Load! Cannot paint.");
    return;
  }

  isPainting = true;
  overlayInstance.updateInnerHTML('bm-button-autodraw', 'Painting...');
  overlayInstance.handleDisplayStatus("Preparing batch...");

  try {
    await executeSinglePaint(overlayInstance);
  } finally {
    isPainting = false;
    overlayInstance.updateInnerHTML('bm-button-autodraw', 'Paint');
    // message might be overwritten by executeSinglePaint, but this ensures reset state
  }
}

// Cached user info for paint loop
let cachedCharges = 0;

// 4a. Helper to fetch and display User Info (called on init)
async function fetchUserInfo(overlayInstance) {
  try {
    const me = await apiManager.me();
    if (!me) return;

    const nameEl = document.getElementById('bm-user-name');
    const dropletsEl = document.getElementById('bm-user-droplets');
    const chargesEl = document.getElementById('bm-user-charges');
    const nextLevelEl = document.getElementById('bm-user-nextlevel');
    const slider = document.querySelector('#bm-input-charges-limit');
    const sliderValEl = document.querySelector('#bm-charges-limit-val');

    if (nameEl) nameEl.textContent = `Username: ${me.name} (Lvl ${Math.floor(me.level)})`;
    if (dropletsEl) dropletsEl.textContent = `Droplets: ${me.droplets}`;

    if (chargesEl && me.charges) {
      const currentCharges = Math.floor(me.charges.count);
      chargesEl.textContent = `Charges: ${currentCharges} / ${me.charges.max}`;
      cachedCharges = currentCharges;
      // Update slider max to user's CURRENT charges
      if (slider) {
        slider.max = currentCharges;
        // If current value exceeds new max, adjust
        if (Number(slider.value) > currentCharges) {
          slider.value = currentCharges;
          if (sliderValEl) sliderValEl.textContent = currentCharges;
        }
      }
    }

    // Next level calc
    const levelProgress = me.level % 1;
    if (nextLevelEl) nextLevelEl.textContent = `Progress: ${(levelProgress * 100).toFixed(1)}%`;

  } catch (e) {
    console.error("Failed to fetch user info", e);
  }
}

// 4b. Modified paintLoop (uses cachedCharges, no fetch per loop)
// 4b. Single Paint Execution (uses cachedCharges)
async function executeSinglePaint(overlayInstance) {
  // Use cached charges (updated on init and after each paint response)
  const sliderVal = Number(document.querySelector('#bm-input-charges-limit')?.value || 30);

  if (cachedCharges < 1) {
    overlayInstance.handleDisplayStatus("No charges!");
    return;
  }

  // 2. Get Candidates
  // 2. Get Candidates
  let candidates = templateManager.getAllWrongPixels();
  if (candidates.length === 0) {
    overlayInstance.handleDisplayStatus("No wrong pixels found.");
    return;
  }

  // Filter candidates by Enabled status immediately
  const t = templateManager.templatesArray?.[0];
  if (t && t.colorPalette) {
    candidates = candidates.filter(p => {
      const rgbKey = `${p.color[0]},${p.color[1]},${p.color[2]}`;

      // #DEFACE = RGB(222, 250, 206), treated as transparent
      const isTransparent = (p.color[3] === 0) || (rgbKey === '222,250,206');

      if (isTransparent) {
        return t.colorPalette['#deface']?.enabled !== false;
      } else {
        let paletteKey = rgbKey;
        // Fallback to 'other' if specific color not found in palette
        if (!t.colorPalette[paletteKey] && t.colorPalette['other']) {
          paletteKey = 'other';
        }
        return t.colorPalette[paletteKey]?.enabled !== false;
      }
    });
  }

  if (candidates.length === 0) {
    overlayInstance.handleDisplayStatus("No enabled pixels found in candidate list.");
    return;
  }

  // 3. Group by Tile
  const batchByTile = new Map();
  // candidates.sort(() => Math.random() - 0.5); // Shuffle

  candidates.forEach(p => {
    const tileX = Math.floor(p.x / TILE_SIZE);
    const tileY = Math.floor(p.y / TILE_SIZE);
    const key = `${tileX},${tileY}`;

    if (!batchByTile.has(key)) batchByTile.set(key, []);
    const list = batchByTile.get(key);

    // Check batch limit per tile based on SLIDER
    if (list.length < sliderVal) {
      list.push(p);
    }
  });

  // 4. Select a Batch
  const targetTileKey = batchByTile.keys().next().value;
  if (!targetTileKey) {
    overlayInstance.handleDisplayStatus("No valid batch.");
    return;
  }

  const pixelsToPaint = batchByTile.get(targetTileKey);
  const [tileX, tileY] = targetTileKey.split(',').map(Number);

  // 5. Prepare Payload
  const colors = [];
  const coords = [];
  // const t = templateManager.templatesArray?.[0]; // Already defined above

  if (!t || !t.rgbToMeta) {
    overlayInstance.handleDisplayError("Template metadata missing!");
    return;
  }

  let droppedMeta = 0;

  for (const p of pixelsToPaint) {
    const rgbKey = `${p.color[0]},${p.color[1]},${p.color[2]}`;

    // Check transparent FIRST (before meta lookup which might incorrectly match #deface to Teal)
    // #DEFACE = RGB(222, 250, 206)
    const isTransparent = (p.color[3] === 0) || (rgbKey === '222,250,206');

    if (isTransparent) {
      colors.push(0); // Color 0 = transparent / erase
      const relX = Math.floor(p.x % TILE_SIZE);
      const relY = Math.floor(p.y % TILE_SIZE);
      coords.push(relX, relY);
      continue; // Skip to next pixel, don't look up meta

    }

    const meta = t.rgbToMeta.get(rgbKey);
    if (meta && typeof meta.id === 'number') {
      colors.push(meta.id);
      const relX = Math.floor(p.x % TILE_SIZE);
      const relY = Math.floor(p.y % TILE_SIZE);
      coords.push(relX, relY);
    } else {
      droppedMeta++;
      if (droppedMeta === 1) console.log(`[BM DEBUG] First dropped meta: ${rgbKey}. Palette has it? ${!!t.colorPalette[rgbKey]}`);
    }
  }

  if (colors.length === 0) {
    overlayInstance.handleDisplayStatus(`Batch failed: No valid colors. (MetaFail: ${droppedMeta})`);
    return;
  }

  // Cap batch size by slider (cachedCharges was already checked above)
  const effectiveBatchSize = Math.min(colors.length, sliderVal);

  if (effectiveBatchSize <= 0) {
    overlayInstance.handleDisplayStatus("Batch size 0.");
    return;
  }

  const finalColors = colors.slice(0, effectiveBatchSize);
  const finalCoords = coords.slice(0, effectiveBatchSize * 2);

  const fpValue = document.querySelector('#bm-input-fp')?.value || 'a0529c6623486c6946452301dd40f943';

  const payload = {
    "colors": finalColors,
    "coords": finalCoords,
    "fp": fpValue
  };

  // 6. Send Request
  overlayInstance.handleDisplayStatus(`Painting ${effectiveBatchSize} pixels at ${tileX},${tileY}...`);

  if (DEBUG_MODE) {
    // ... debug code ...
    console.log("Debug Paint", payload);
    return;
  }

  try {
    const json = await apiManager.paint(payload, tileX, tileY);

    // Update local tracking
    const currentWrong = templateManager.wrongPixelsMap.get(targetTileKey) || [];
    const newWrong = currentWrong.filter(wp => {
      const relX = Math.floor(wp.x % TILE_SIZE);
      const relY = Math.floor(wp.y % TILE_SIZE);
      for (let i = 0; i < finalCoords.length; i += 2) {
        if (finalCoords[i] === relX && finalCoords[i + 1] === relY) return false;
      }
      return true;
    });
    templateManager.wrongPixelsMap.set(targetTileKey, newWrong);

    // Check result
    if (json.success === false) {
      overlayInstance.handleDisplayStatus(`Paint Failed: ${json.error || 'Unknown'}`);
    } else {
      overlayInstance.handleDisplayStatus(`Painted ${effectiveBatchSize} pixels successfully!`);
      await fetchUserInfo(overlayInstance);
    }

  } catch (e) {
    overlayInstance.handleDisplayError(`Paint Error: ${e.message}`);
  }
}

/** Injects code into the client
 * This code will execute outside of TamperMonkey's sandbox
 * @param {*} callback - The code to execute
 * @since 0.11.15
 */
function inject(callback) {
  const script = document.createElement('script');
  script.setAttribute('bm-name', name); // Passes in the name value
  script.setAttribute('bm-cStyle', consoleStyle); // Passes in the console style value
  script.textContent = `(${callback})();`;
  document.documentElement?.appendChild(script);
  script.remove();
}

/** What code to execute instantly in the client (webpage) to spy on fetch calls.
 * This code will execute outside of TamperMonkey's sandbox.
 * @since 0.11.15
 */
inject(() => {

  const script = document.currentScript; // Gets the current script HTML Script Element
  const name = script?.getAttribute('bm-name') || 'Blue Marble'; // Gets the name value that was passed in. Defaults to "Blue Marble" if nothing was found
  const consoleStyle = script?.getAttribute('bm-cStyle') || ''; // Gets the console style value that was passed in. Defaults to no styling if nothing was found
  const fetchedBlobQueue = new Map(); // Blobs being processed

  window.addEventListener('message', (event) => {
    const { source, endpoint, blobID, blobData, blink } = event.data;

    const elapsed = Date.now() - blink;

    // Since this code does not run in the userscript, we can't use consoleLog().
    // console.groupCollapsed(`%c${name}%c: ${fetchedBlobQueue.size} Recieved IMAGE message about blob "${blobID}"`, consoleStyle, '');
    // console.log(`Blob fetch took %c${String(Math.floor(elapsed / 60000)).padStart(2, '0')}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')}.${String(elapsed % 1000).padStart(3, '0')}%c MM:SS.mmm`, consoleStyle, '');
    // console.log(fetchedBlobQueue);
    // console.groupEnd();


    // The modified blob won't have an endpoint, so we ignore any message without one.
    if ((source == 'blue-marble') && !!blobID && !!blobData && !endpoint) {

      const callback = fetchedBlobQueue.get(blobID); // Retrieves the blob based on the UUID

      // If the blobID is a valid function...
      if (typeof callback === 'function') {

        callback(blobData); // ...Retrieve the blob data from the blobID function
      } else {
        // ...else the blobID is unexpected. We don't know what it is, but we know for sure it is not a blob. This means we ignore it.

        consoleWarn(`%c${name}%c: Attempted to retrieve a blob (%s) from queue, but the blobID was not a function! Skipping...`, consoleStyle, '', blobID);
      }

      fetchedBlobQueue.delete(blobID); // Delete the blob from the queue, because we don't need to process it again
    }
  });

  // Spys on "spontaneous" fetch requests made by the client
  const originalFetch = window.fetch; // Saves a copy of the original fetch

  // Overrides fetch
  window.fetch = async function (...args) {

    const response = await originalFetch.apply(this, args); // Sends a fetch
    const cloned = response.clone(); // Makes a copy of the response

    // Retrieves the endpoint name. Unknown endpoint = "ignore"
    const endpointName = ((args[0] instanceof Request) ? args[0]?.url : args[0]) || 'ignore';

    // Check Content-Type to only process JSON
    const contentType = cloned.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {


      // Since this code does not run in the userscript, we can't use consoleLog().
      // console.log(`%c${name}%c: Sending JSON message about endpoint "${endpointName}"`, consoleStyle, '');


      // Sends a message about the endpoint it spied on
      cloned.json()
        .then(jsonData => {
          window.postMessage({
            source: 'blue-marble',
            endpoint: endpointName,
            jsonData: jsonData
          }, '*');
        })
        .catch(err => {
          console.error(`%c${name}%c: Failed to parse JSON: `, consoleStyle, '', err);
        });
    } else if (contentType.includes('image/') && (!endpointName.includes('openfreemap') && !endpointName.includes('maps'))) {
      // Fetch custom for all images but opensourcemap

      const blink = Date.now(); // Current time

      const blob = await cloned.blob(); // The original blob

      // Since this code does not run in the userscript, we can't use consoleLog().
      // console.log(`%c${name}%c: ${fetchedBlobQueue.size} Sending IMAGE message about endpoint "${endpointName}"`, consoleStyle, '');


      // Returns the manipulated blob
      return new Promise((resolve) => {
        const blobUUID = crypto.randomUUID(); // Generates a random UUID

        // Store the blob while we wait for processing
        fetchedBlobQueue.set(blobUUID, (blobProcessed) => {
          // The response that triggers when the blob is finished processing

          // Creates a new response
          resolve(new Response(blobProcessed, {
            headers: cloned.headers,
            status: cloned.status,
            statusText: cloned.statusText
          }));

          // Since this code does not run in the userscript, we can't use consoleLog().
          // console.log(`%c${name}%c: ${fetchedBlobQueue.size} Processed blob "${blobUUID}"`, consoleStyle, '');

        });

        window.postMessage({
          source: 'blue-marble',
          endpoint: endpointName,
          blobID: blobUUID,
          blobData: blob,
          blink: blink
        });
      }).catch(exception => {
        const elapsed = Date.now();
        console.error(`%c${name}%c: Failed to Promise blob!`, consoleStyle, '');
        // console.groupCollapsed(`%c${name}%c: Details of failed blob Promise:`, consoleStyle, '');
        // console.log(`Endpoint: ${endpointName}\nThere are ${fetchedBlobQueue.size} blobs processing...\nBlink: ${blink.toLocaleString()}\nTime Since Blink: ${String(Math.floor(elapsed / 60000)).padStart(2, '0')}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')}.${String(elapsed % 1000).padStart(3, '0')} MM:SS.mmm`);
        console.error(`Exception stack:`, exception);
        // console.groupEnd();

      });

      // cloned.blob().then(blob => {
      //   window.postMessage({
      //     source: 'blue-marble',
      //     endpoint: endpointName,
      //     blobData: blob
      //   }, '*');
      // });
    }

    return response; // Returns the original response
  };
});

// Imports the CSS file from dist folder on github
const cssOverlay = GM_getResourceText("CSS-BM-File");
GM_addStyle(cssOverlay);

// Imports the Roboto Mono font family
var stylesheetLink = document.createElement('link');
stylesheetLink.href = 'https://fonts.googleapis.com/css2?family=Roboto+Mono:ital,wght@0,100..700;1,100..700&display=swap';
stylesheetLink.rel = 'preload';
stylesheetLink.as = 'style';
stylesheetLink.onload = function () {
  this.onload = null;
  this.rel = 'stylesheet';
};
document.head?.appendChild(stylesheetLink);

// CONSTRUCTORS
const observers = new Observers(); // Constructs a new Observers object
const overlayMain = new Overlay(name, version); // Constructs a new Overlay object for the main overlay
const overlayTabTemplate = new Overlay(name, version); // Constructs a Overlay object for the template tab
const templateManager = new TemplateManager(name, version, overlayMain); // Constructs a new TemplateManager object
const apiManager = new ApiManager(templateManager); // Constructs a new ApiManager object

overlayMain.setApiManager(apiManager); // Sets the API manager

const storageTemplates = JSON.parse(GM_getValue('bmTemplates', '{}'));
console.log(storageTemplates);
templateManager.importJSON(storageTemplates); // Loads the templates

const userSettings = JSON.parse(GM_getValue('bmUserSettings', '{}')); // Loads the user settings
console.log(userSettings);
console.log(Object.keys(userSettings).length);
if (Object.keys(userSettings).length == 0) {
  const uuid = crypto.randomUUID(); // Generates a random UUID
  console.log(uuid);
  GM.setValue('bmUserSettings', JSON.stringify({
    'uuid': uuid
  }));
}

buildOverlayMain(); // Builds the main overlay

overlayMain.handleDrag('#bm-overlay', '#bm-bar-drag'); // Creates dragging capability on the drag bar for dragging the overlay

apiManager.spontaneousResponseListener(overlayMain); // Reads spontaneous fetch responces

fetchUserInfo(overlayMain); // Initial fetch of user info (Charges etc)

observeBlack(); // Observes the black palette color

consoleLog(`%c${name}%c (${version}) userscript has loaded!`, 'color: cornflowerblue;', '');

/** Observe the black color, and add the "Move" button.
 * @since 0.66.3
 */
function observeBlack() {
  const observer = new MutationObserver((mutations, observer) => {

    const black = document.querySelector('#color-1'); // Attempt to retrieve the black color element for anchoring

    if (!black) { return; } // Black color does not exist yet. Kills iteself

    let move = document.querySelector('#bm-button-move'); // Tries to find the move button

    // If the move button does not exist, we make a new one
    if (!move) {
      move = document.createElement('button');
      move.id = 'bm-button-move';
      move.textContent = 'Move ↑';
      move.className = 'btn btn-soft';
      move.onclick = function () {
        const roundedBox = this.parentNode.parentNode.parentNode.parentNode; // Obtains the rounded box
        const shouldMoveUp = (this.textContent == 'Move ↑');
        roundedBox.parentNode.className = roundedBox.parentNode.className.replace(shouldMoveUp ? 'bottom' : 'top', shouldMoveUp ? 'top' : 'bottom'); // Moves the rounded box to the top
        roundedBox.style.borderTopLeftRadius = shouldMoveUp ? '0px' : 'var(--radius-box)';
        roundedBox.style.borderTopRightRadius = shouldMoveUp ? '0px' : 'var(--radius-box)';
        roundedBox.style.borderBottomLeftRadius = shouldMoveUp ? 'var(--radius-box)' : '0px';
        roundedBox.style.borderBottomRightRadius = shouldMoveUp ? 'var(--radius-box)' : '0px';
        this.textContent = shouldMoveUp ? 'Move ↓' : 'Move ↑';
      }

      // Attempts to find the "Paint Pixel" element for anchoring
      const paintPixel = black.parentNode.parentNode.parentNode.parentNode.querySelector('h2');

      paintPixel.parentNode?.appendChild(move); // Adds the move button
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

/** Deploys the overlay to the page with minimize/maximize functionality.
 * Creates a responsive overlay UI that can toggle between full-featured and minimized states.
 * 
 * Parent/child relationships in the DOM structure below are indicated by indentation.
 * @since 0.58.3
 */
function buildOverlayMain() {
  let isMinimized = false; // Overlay state tracker (false = maximized, true = minimized)
  // Load last saved coordinates (if any)
  let savedCoords = {};
  try { savedCoords = JSON.parse(GM_getValue('bmCoords', '{}')) || {}; } catch (_) { savedCoords = {}; }
  const persistCoords = () => {
    try {
      const tx = Number(document.querySelector('#bm-input-tx')?.value || '');
      const ty = Number(document.querySelector('#bm-input-ty')?.value || '');
      const px = Number(document.querySelector('#bm-input-px')?.value || '');
      const py = Number(document.querySelector('#bm-input-py')?.value || '');
      const data = { tx, ty, px, py };
      GM.setValue('bmCoords', JSON.stringify(data));
    } catch (_) { }
  };

  overlayMain.addDiv({ 'id': 'bm-overlay', 'style': 'top: 10px; right: 75px;' })
    .addDiv({ 'id': 'bm-contain-header' })
    .addDiv({ 'id': 'bm-bar-drag' }).buildElement()
    .addImg({ 'alt': 'Blue Marble Icon - Click to minimize/maximize', 'src': 'https://raw.githubusercontent.com/3eck/auto-painter/main/dist/assets/Favicon.png', 'style': 'cursor: pointer;' },
      (instance, img) => {
        /** Click event handler for overlay minimize/maximize functionality.
         * 
         * Toggles between two distinct UI states:
         * 1. MINIMIZED STATE (60×76px):
         *    - Shows only the Blue Marble icon and drag bar
         *    - Hides all input fields, buttons, and status information
         *    - Applies fixed dimensions for consistent appearance
         *    - Repositions icon with 3px right offset for visual centering
         * 
         * 2. MAXIMIZED STATE (responsive):
         *    - Restores full functionality with all UI elements
         *    - Removes fixed dimensions to allow responsive behavior
         *    - Resets icon positioning to default alignment
         *    - Shows success message when returning to maximized state
         * 
         * @param {Event} event - The click event object (implicit)
         */
        img.addEventListener('click', () => {
          isMinimized = !isMinimized; // Toggle the current state

          const overlay = document.querySelector('#bm-overlay');
          const header = document.querySelector('#bm-contain-header');
          const dragBar = document.querySelector('#bm-bar-drag');
          const coordsContainer = document.querySelector('#bm-contain-coords');
          const coordsButton = document.querySelector('#bm-button-coords');
          const createButton = document.querySelector('#bm-button-create');
          const enableButton = document.querySelector('#bm-button-enable');
          const disableButton = document.querySelector('#bm-button-disable');
          const coordInputs = document.querySelectorAll('#bm-contain-coords input');

          // Pre-restore original dimensions when switching to maximized state
          // This ensures smooth transition and prevents layout issues
          if (!isMinimized) {
            overlay.style.width = "auto";
            overlay.style.maxWidth = "300px";
            overlay.style.minWidth = "200px";
            overlay.style.padding = "10px";
          }

          // Define elements that should be hidden/shown during state transitions
          // Each element is documented with its purpose for maintainability
          const elementsToToggle = [
            '#bm-overlay h1',                    // Main title "Blue Marble"
            '#bm-contain-userinfo',              // User information section (username, droplets, level)
            '#bm-overlay hr',                    // Visual separator lines
            '#bm-contain-automation > *:not(#bm-contain-coords)', // Automation section excluding coordinates
            '#bm-input-file-template',           // Template file upload interface
            '#bm-contain-buttons-action',        // Action buttons container
            `#${instance.outputStatusId}`,       // Status log textarea for user feedback
            '#bm-contain-colorfilter'            // Color filter UI
          ];

          // Apply visibility changes to all toggleable elements
          elementsToToggle.forEach(selector => {
            const elements = document.querySelectorAll(selector);
            elements.forEach(element => {
              element.style.display = isMinimized ? 'none' : '';
            });
          });
          // Handle coordinate container and button visibility based on state
          if (isMinimized) {
            // ==================== MINIMIZED STATE CONFIGURATION ====================
            // In minimized state, we hide ALL interactive elements except the icon and drag bar
            // This creates a clean, unobtrusive interface that maintains only essential functionality

            // Hide coordinate input container completely
            if (coordsContainer) {
              coordsContainer.style.display = 'none';
            }

            // Hide coordinate button (pin icon)
            if (coordsButton) {
              coordsButton.style.display = 'none';
            }

            // Hide create template button
            if (createButton) {
              createButton.style.display = 'none';
            }

            // Hide enable templates button
            if (enableButton) {
              enableButton.style.display = 'none';
            }

            // Hide disable templates button
            if (disableButton) {
              disableButton.style.display = 'none';
            }

            // Hide all coordinate input fields individually (failsafe)
            coordInputs.forEach(input => {
              input.style.display = 'none';
            });

            // Apply fixed dimensions for consistent minimized appearance
            // These dimensions were chosen to accommodate the icon while remaining compact
            overlay.style.width = '60px';    // Fixed width for consistency
            overlay.style.height = '76px';   // Fixed height (60px + 16px for better proportions)
            overlay.style.maxWidth = '60px';  // Prevent expansion
            overlay.style.minWidth = '60px';  // Prevent shrinking
            overlay.style.padding = '8px';    // Comfortable padding around icon

            // Apply icon positioning for better visual centering in minimized state
            // The 3px offset compensates for visual weight distribution
            img.style.marginLeft = '3px';

            // Configure header layout for minimized state
            header.style.textAlign = 'center';
            header.style.margin = '0';
            header.style.marginBottom = '0';

            // Ensure drag bar remains visible and properly spaced
            if (dragBar) {
              dragBar.style.display = '';
              dragBar.style.marginBottom = '0.25em';
            }
          } else {
            // ==================== MAXIMIZED STATE RESTORATION ====================
            // In maximized state, we restore all elements to their default functionality
            // This involves clearing all style overrides applied during minimization

            // Restore coordinate container to default state
            if (coordsContainer) {
              coordsContainer.style.display = '';           // Show container
              coordsContainer.style.flexDirection = '';     // Reset flex layout
              coordsContainer.style.justifyContent = '';    // Reset alignment
              coordsContainer.style.alignItems = '';        // Reset alignment
              coordsContainer.style.gap = '';               // Reset spacing
              coordsContainer.style.textAlign = '';         // Reset text alignment
              coordsContainer.style.margin = '';            // Reset margins
            }

            // Restore coordinate button visibility
            if (coordsButton) {
              coordsButton.style.display = '';
            }

            // Restore create button visibility and reset positioning
            if (createButton) {
              createButton.style.display = '';
              createButton.style.marginTop = '';
            }

            // Restore enable button visibility and reset positioning
            if (enableButton) {
              enableButton.style.display = '';
              enableButton.style.marginTop = '';
            }

            // Restore disable button visibility and reset positioning
            if (disableButton) {
              disableButton.style.display = '';
              disableButton.style.marginTop = '';
            }

            // Restore all coordinate input fields
            coordInputs.forEach(input => {
              input.style.display = '';
            });

            // Reset icon positioning to default (remove minimized state offset)
            img.style.marginLeft = '';

            // Restore overlay to responsive dimensions
            overlay.style.padding = '10px';

            // Reset header styling to defaults
            header.style.textAlign = '';
            header.style.margin = '';
            header.style.marginBottom = '';

            // Reset drag bar spacing
            if (dragBar) {
              dragBar.style.marginBottom = '0.5em';
            }

            // Remove all fixed dimensions to allow responsive behavior
            // This ensures the overlay can adapt to content changes
            overlay.style.width = '';
            overlay.style.height = '';
          }

          // ==================== ACCESSIBILITY AND USER FEEDBACK ====================
          // Update accessibility information for screen readers and tooltips

          // Update alt text to reflect current state for screen readers and tooltips
          img.alt = isMinimized ?
            'Blue Marble Icon - Minimized (Click to maximize)' :
            'Blue Marble Icon - Maximized (Click to minimize)';

          // No status message needed - state change is visually obvious to users
        });
      }
    ).buildElement()
    .addHeader(1, { 'textContent': name }).buildElement()
    .buildElement()

    .addHr().buildElement()

    .addDiv({ 'id': 'bm-contain-userinfo' })
    .addP({ 'id': 'bm-user-name', 'textContent': 'Username:' }).buildElement()
    .addP({ 'id': 'bm-user-charges', 'textContent': 'Charges:' }).buildElement()
    .addP({ 'id': 'bm-user-droplets', 'textContent': 'Droplets:' }).buildElement()
    .addP({ 'id': 'bm-user-nextlevel', 'textContent': 'Next level in...' }).buildElement()
    .buildElement()

    .addHr().buildElement()

    .addDiv({ 'id': 'bm-contain-automation' })
    .addDiv({ 'style': 'display: flex; align-items: center; gap: 5px; margin-bottom: 5px;' })
    .addSmall({ 'textContent': 'Max Px:', 'style': 'white-space: nowrap;' }).buildElement()
    .addInput({ 'type': 'range', 'id': 'bm-input-charges-limit', 'min': 1, 'max': 1100, 'step': 1, 'value': (GM_getValue('bmMaxCharges', 30)), 'style': 'width: 100%;' }, (instance, input) => {
      input.addEventListener('input', () => {
        const val = input.value;
        document.querySelector('#bm-charges-limit-val').textContent = val;
        GM.setValue('bmMaxCharges', Number(val));
      });
    }).buildElement()
    .addSmall({ 'id': 'bm-charges-limit-val', 'textContent': (GM_getValue('bmMaxCharges', 30)), 'style': 'min-width: 25px; text-align: right;' }).buildElement()
    .buildElement()
    .addDiv({ 'style': 'display: flex; align-items: center; gap: 5px; margin-bottom: 5px;' })
    .addSmall({ 'textContent': 'FP:', 'style': 'color: gray; white-space: nowrap;' }).buildElement()
    .addInput({ 'type': 'text', 'id': 'bm-input-fp', 'placeholder': 'Fingerprint', 'style': 'width: 100%; font-size: 11px; background: #222; color: #fff; border: 1px solid #444; padding: 2px 4px; border-radius: 3px;', 'value': (GM_getValue('bmFingerprint', 'a0529c6623486c6946452301dd40f943')) }, (instance, input) => {
      input.addEventListener('input', () => {
        GM.setValue('bmFingerprint', input.value.trim());
      });
    }).buildElement()
    .buildElement()
    .addDiv({ 'id': 'bm-contain-coords' })
    .addButton({ 'id': 'bm-button-coords', 'className': 'bm-help', 'style': 'margin-top: 0;', 'innerHTML': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 6"><circle cx="2" cy="2" r="2"></circle><path d="M2 6 L3.7 3 L0.3 3 Z"></path><circle cx="2" cy="2" r="0.7" fill="white"></circle></svg></svg>' },
      (instance, button) => {
        button.onclick = () => {
          const coords = instance.apiManager?.coordsTilePixel; // Retrieves the coords from the API manager
          if (!coords?.[0]) {
            instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?');
            return;
          }
          instance.updateInnerHTML('bm-input-tx', coords?.[0] || '');
          instance.updateInnerHTML('bm-input-ty', coords?.[1] || '');
          instance.updateInnerHTML('bm-input-px', coords?.[2] || '');
          instance.updateInnerHTML('bm-input-py', coords?.[3] || '');
          persistCoords();
        }
      }
    ).buildElement()
    .addInput({ 'type': 'number', 'id': 'bm-input-tx', 'placeholder': 'Tl X', 'min': 0, 'max': 2047, 'step': 1, 'required': true, 'value': (savedCoords.tx ?? '') }, (instance, input) => {
      //if a paste happens on tx, split and format it into other coordinates if possible
      input.addEventListener("paste", (event) => {
        let splitText = (event.clipboardData || window.clipboardData).getData("text").split(" ").filter(n => n).map(Number).filter(n => !isNaN(n)); //split and filter all Non Numbers

        if (splitText.length !== 4) { // If we don't have 4 clean coordinates, end the function.
          return;
        }

        let coords = selectAllCoordinateInputs(document);

        for (let i = 0; i < coords.length; i++) {
          coords[i].value = splitText[i]; //add the split vales
        }

        event.preventDefault(); //prevent the pasting of the original paste that would overide the split value
      })
      const handler = () => persistCoords();
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    }).buildElement()
    .addInput({ 'type': 'number', 'id': 'bm-input-ty', 'placeholder': 'Tl Y', 'min': 0, 'max': 2047, 'step': 1, 'required': true, 'value': (savedCoords.ty ?? '') }, (instance, input) => {
      const handler = () => persistCoords();
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    }).buildElement()
    .addInput({ 'type': 'number', 'id': 'bm-input-px', 'placeholder': 'Px X', 'min': 0, 'max': 2047, 'step': 1, 'required': true, 'value': (savedCoords.px ?? '') }, (instance, input) => {
      const handler = () => persistCoords();
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    }).buildElement()
    .addInput({ 'type': 'number', 'id': 'bm-input-py', 'placeholder': 'Px Y', 'min': 0, 'max': 2047, 'step': 1, 'required': true, 'value': (savedCoords.py ?? '') }, (instance, input) => {
      const handler = () => persistCoords();
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    }).buildElement()
    .buildElement()
    // Color filter UI
    .addDiv({ 'id': 'bm-contain-colorfilter', 'style': 'max-height: 140px; overflow: auto; border: 1px solid rgba(255,255,255,0.1); padding: 4px; border-radius: 4px; display: none;' })
    .addDiv({ 'style': 'display: flex; gap: 6px; margin-bottom: 6px;' })
    .addButton({ 'id': 'bm-button-colors-enable-all', 'textContent': 'Enable All' }, (instance, button) => {
      button.onclick = () => {
        const t = templateManager.templatesArray[0];
        if (!t?.colorPalette) { return; }
        Object.values(t.colorPalette).forEach(v => v.enabled = true);
        buildColorFilterList();
        instance.handleDisplayStatus('Enabled all colors');
      };
    }).buildElement()
    .addButton({ 'id': 'bm-button-colors-disable-all', 'textContent': 'Disable All' }, (instance, button) => {
      button.onclick = () => {
        const t = templateManager.templatesArray[0];
        if (!t?.colorPalette) { return; }
        Object.values(t.colorPalette).forEach(v => v.enabled = false);
        buildColorFilterList();
        instance.handleDisplayStatus('Disabled all colors');
      };
    }).buildElement()
    .buildElement()
    .addDiv({ 'id': 'bm-colorfilter-list' }).buildElement()
    .buildElement()
    .addInputFile({ 'id': 'bm-input-file-template', 'textContent': 'Upload Template', 'accept': 'image/png, image/jpeg, image/webp, image/bmp, image/gif' }).buildElement()
    .addDiv({ 'id': 'bm-contain-buttons-template' })
    .addButton({ 'id': 'bm-button-enable', 'textContent': 'Enable' }, (instance, button) => {
      button.onclick = () => {
        instance.apiManager?.templateManager?.setTemplatesShouldBeDrawn(true);
        instance.handleDisplayStatus(`Enabled templates!`);
      }
    }).buildElement()
    .addButton({ 'id': 'bm-button-create', 'textContent': 'Create' }, (instance, button) => {
      button.onclick = () => {
        const input = document.querySelector('#bm-input-file-template');

        const coordTlX = document.querySelector('#bm-input-tx');
        if (!coordTlX.checkValidity()) { coordTlX.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return; }
        const coordTlY = document.querySelector('#bm-input-ty');
        if (!coordTlY.checkValidity()) { coordTlY.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return; }
        const coordPxX = document.querySelector('#bm-input-px');
        if (!coordPxX.checkValidity()) { coordPxX.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return; }
        const coordPxY = document.querySelector('#bm-input-py');
        if (!coordPxY.checkValidity()) { coordPxY.reportValidity(); instance.handleDisplayError('Coordinates are malformed! Did you try clicking on the canvas first?'); return; }

        // Kills itself if there is no file
        if (!input?.files[0]) { instance.handleDisplayError(`No file selected!`); return; }

        templateManager.createTemplate(input.files[0], input.files[0]?.name.replace(/\.[^/.]+$/, ''), [Number(coordTlX.value), Number(coordTlY.value), Number(coordPxX.value), Number(coordPxY.value)]);

        // console.log(`TCoords: ${apiManager.templateCoordsTilePixel}\nCoords: ${apiManager.coordsTilePixel}`);
        // apiManager.templateCoordsTilePixel = apiManager.coordsTilePixel; // Update template coords
        // console.log(`TCoords: ${apiManager.templateCoordsTilePixel}\nCoords: ${apiManager.coordsTilePixel}`);
        // templateManager.setTemplateImage(input.files[0]);

        instance.handleDisplayStatus(`Drew to canvas!`);
      }
    }).buildElement()
    .addButton({ 'id': 'bm-button-disable', 'textContent': 'Disable' }, (instance, button) => {
      button.onclick = () => {
        instance.apiManager?.templateManager?.setTemplatesShouldBeDrawn(false);
        instance.handleDisplayStatus(`Disabled templates!`);
      }
    }).buildElement()
    .buildElement()
    .addTextarea({ 'id': overlayMain.outputStatusId, 'placeholder': `Status: Sleeping...\nVersion: ${version}`, 'readOnly': true }).buildElement()
    .addDiv({ 'id': 'bm-contain-buttons-action' })
    .addDiv()
    // .addButton({'id': 'bm-button-teleport', 'className': 'bm-help', 'textContent': '✈'}).buildElement()
    // .addButton({'id': 'bm-button-favorite', 'className': 'bm-help', 'innerHTML': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><polygon points="10,2 12,7.5 18,7.5 13.5,11.5 15.5,18 10,14 4.5,18 6.5,11.5 2,7.5 8,7.5" fill="white"></polygon></svg>'}).buildElement()
    // .addButton({'id': 'bm-button-templates', 'className': 'bm-help', 'innerHTML': '🖌'}).buildElement()

    .addButton({ 'id': 'bm-button-autodraw', 'className': 'btn', 'style': 'width: 80%; margin: 5px auto; display: block; background-color: #4CAF50; color: white; padding: 8px; font-size: 13px;', 'textContent': 'Paint' }, (instance, button) => {
      button.onclick = () => {
        handlePaintClick(instance);
      };
    }).buildElement()
    .buildElement()
    .addSmall({ 'textContent': '', 'style': 'margin-top: auto;' }).buildElement()
    .buildElement()
    .buildElement()
    .buildOverlay(document.body);

  // ------- Helper: Build the color filter list -------
  window.buildColorFilterList = function buildColorFilterList() {
    const listContainer = document.querySelector('#bm-colorfilter-list');
    const t = templateManager.templatesArray?.[0];
    if (!listContainer || !t?.colorPalette) {
      if (listContainer) { listContainer.innerHTML = '<small>No template colors to display.</small>'; }
      return;
    }

    listContainer.innerHTML = '';
    const entries = Object.entries(t.colorPalette)
      .sort((a, b) => b[1].count - a[1].count); // sort by frequency desc

    for (const [rgb, meta] of entries) {
      let row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
      row.style.margin = '4px 0';

      let swatch = document.createElement('div');
      swatch.style.width = '14px';
      swatch.style.height = '14px';
      swatch.style.border = '1px solid rgba(255,255,255,0.5)';

      let label = document.createElement('span');
      label.style.fontSize = '12px';
      let labelText = `${meta.count.toLocaleString()}`;

      // Special handling for "other" and "transparent"
      if (rgb === 'other') {
        swatch.style.background = '#888'; // Neutral color for "Other"
        labelText = `Other • ${labelText}`;
      } else if (rgb === '#deface') {
        swatch.style.background = '#deface';
        labelText = `Transparent • ${labelText}`;
      } else {
        const [r, g, b] = rgb.split(',').map(Number);
        swatch.style.background = `rgb(${r},${g},${b})`;
        try {
          const tMeta = templateManager.templatesArray?.[0]?.rgbToMeta?.get(rgb);
          if (tMeta && typeof tMeta.id === 'number') {
            const displayName = tMeta?.name || `rgb(${r},${g},${b})`;
            const starLeft = tMeta.premium ? '★ ' : '';
            labelText = `#${tMeta.id} ${starLeft}${displayName} • ${labelText}`;
          }
        } catch (ignored) { }
      }
      label.textContent = labelText;

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !!meta.enabled;
      toggle.addEventListener('change', () => {
        meta.enabled = toggle.checked;
        overlayMain.handleDisplayStatus(`${toggle.checked ? 'Enabled' : 'Disabled'} ${rgb}`);
        try {
          const t = templateManager.templatesArray?.[0];
          const key = t?.storageKey;
          if (t && key && templateManager.templatesJSON?.templates?.[key]) {
            templateManager.templatesJSON.templates[key].palette = t.colorPalette;
            // persist immediately
            GM.setValue('bmTemplates', JSON.stringify(templateManager.templatesJSON));
          }
        } catch (_) { }
      });

      row.appendChild(toggle);
      row.appendChild(swatch);
      row.appendChild(label);
      listContainer.appendChild(row);
    }
  };

  // Listen for template creation/import completion to (re)build palette list
  window.addEventListener('message', (event) => {
    if (event?.data?.bmEvent === 'bm-rebuild-color-list') {
      try { buildColorFilterList(); } catch (_) { }
    }
  });

  // If a template was already loaded from storage, show the color UI and build list
  setTimeout(() => {
    try {
      if (templateManager.templatesArray?.length > 0) {
        const colorUI = document.querySelector('#bm-contain-colorfilter');
        if (colorUI) { colorUI.style.display = ''; }
        buildColorFilterList();
      }
    } catch (_) { }
  }, 0);
}


function buildOverlayTabTemplate() {
  overlayTabTemplate.addDiv({ 'id': 'bm-tab-template', 'style': 'top: 20%; left: 10%;' })
    .addDiv()
    .addDiv({ 'className': 'bm-dragbar' }).buildElement()
    .addButton({ 'className': 'bm-button-minimize', 'textContent': '↑' },
      (instance, button) => {
        button.onclick = () => {
          let isMinimized = false;
          if (button.textContent == '↑') {
            button.textContent = '↓';
          } else {
            button.textContent = '↑';
            isMinimized = true;
          }


        }
      }
    ).buildElement()
    .buildElement()
    .buildElement()
    .buildOverlay();
}
