'use strict';

const APP_VERSION         = '1.1.0';
const GITHUB_RELEASES_API = 'https://api.github.com/repos/ginTronic-io/transparentSea/releases';
const USB_FILTERS         = [{ vendorId: 0x0483, productId: 0xDF11 }];
const TRANSFER_SIZE       = 2048;

let connectedDevice   = null;
let selectedAssetUrl  = null;
let isFlashing        = false;
const releaseDescriptions = new Map();

// ── DOM refs ──────────────────────────────────────────────────────────────────
const releaseSelect   = document.getElementById('release-select');
const releaseNotes    = document.getElementById('release-notes');
const connectBtn      = document.getElementById('connect-btn');
const flashBtn        = document.getElementById('flash-btn');
const statusBadge     = document.getElementById('status-badge');
const progressWrap    = document.getElementById('progress-wrap');
const progressBar     = document.getElementById('progress-bar');
const progressLabel   = document.getElementById('progress-label');
const logEl           = document.getElementById('log');
const browserWarning  = document.getElementById('browser-warning');

// ── Browser check ─────────────────────────────────────────────────────────────
if (!navigator.usb) {
    browserWarning.classList.remove('d-none');
    connectBtn.disabled = true;
    flashBtn.disabled   = true;
}

// ── Fetch releases from GitHub ────────────────────────────────────────────────
async function loadReleases() {
    appendLog('Fetching firmware releases…');
    try {
        const res      = await fetch(GITHUB_RELEASES_API);
        if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
        const releases = await res.json();

        const options = [];
        for (const release of releases) {
            if (release.draft) continue;
            const binAssets = release.assets.filter(a => a.name.endsWith('.bin'));
            for (const asset of binAssets) {
                options.push({
                    label:       release.tag_name + (release.prerelease ? '  (pre-release)' : ''),
                    url:         `firmware/${asset.name}`,
                    name:        asset.name,
                    description: release.body || ''
                });
            }
        }

        if (options.length === 0) {
            appendLog('No firmware releases found.', 'warning');
            return;
        }

        releaseSelect.innerHTML = '';
        releaseDescriptions.clear();
        for (const opt of options) {
            const el    = document.createElement('option');
            el.value    = opt.url;
            el.textContent = opt.label;
            releaseSelect.appendChild(el);
            releaseDescriptions.set(opt.url, opt.description);
        }

        onReleaseChange();
        appendLog(`Found ${options.length} firmware release(s).`, 'success');
    } catch (err) {
        appendLog('Could not fetch releases: ' + err.message, 'error');
    }
}

function onReleaseChange() {
    selectedAssetUrl = releaseSelect.value || null;
    const desc = selectedAssetUrl ? (releaseDescriptions.get(selectedAssetUrl) || '') : '';
    if (desc.trim()) {
        releaseNotes.textContent = desc;
        releaseNotes.classList.remove('d-none');
    } else {
        releaseNotes.classList.add('d-none');
    }
    updateFlashButton();
}

releaseSelect.addEventListener('change', onReleaseChange);

// ── Connect ───────────────────────────────────────────────────────────────────
connectBtn.addEventListener('click', async () => {
    if (!navigator.usb) return;
    try {
        connectBtn.disabled = true;
        setStatus('connecting');
        appendLog('Opening USB device picker…');

        const usbDevice  = await navigator.usb.requestDevice({ filters: USB_FILTERS });
        const interfaces = dfu.findDeviceDfuInterfaces(usbDevice);

        if (interfaces.length === 0) {
            throw new Error('No DFU interface found. Is the device in DFU mode?');
        }

        // Use first interface to open and read memory map
        let targetIntf = interfaces.find(i => i.name && i.name.startsWith('@')) || interfaces[0];
        connectedDevice = new dfuse.Device(usbDevice, targetIntf);
        await connectedDevice.open();

        // If memory info wasn't in the interface name, read it from string descriptors
        if (!connectedDevice.memoryInfo) {
            try {
                const nameMap = await connectedDevice.readInterfaceNames();
                const conf    = targetIntf.configuration.configurationValue;
                const intf    = targetIntf.interface.interfaceNumber;
                const alt     = targetIntf.alternate.alternateSetting;
                const name    = nameMap[conf]?.[intf]?.[alt];
                if (name && name.startsWith('@')) {
                    connectedDevice.memoryInfo = dfuse.parseMemoryDescriptor(name);
                    appendLog('Memory map: ' + name);
                }
            } catch (e) {
                appendLog('Could not read memory map: ' + e, 'warning');
            }
        } else {
            appendLog('Memory map: ' + targetIntf.name);
        }

        setStatus('connected');
        appendLog('Device connected and ready.', 'success');
        updateFlashButton();

        // Listen for disconnect
        navigator.usb.addEventListener('disconnect', (event) => {
            if (event.device === usbDevice) {
                connectedDevice = null;
                setStatus('disconnected');
                appendLog('Device disconnected.', 'warning');
                connectBtn.disabled = false;
                updateFlashButton();
            }
        }, { once: true });

    } catch (err) {
        if (err.name !== 'NotFoundError') {           // user cancelled picker
            appendLog('Connection failed: ' + err.message, 'error');
        }
        connectedDevice = null;
        setStatus('disconnected');
        connectBtn.disabled = false;
        updateFlashButton();
    }
});

// ── Flash ─────────────────────────────────────────────────────────────────────
flashBtn.addEventListener('click', async () => {
    if (!connectedDevice || !selectedAssetUrl || isFlashing) return;

    isFlashing       = true;
    connectBtn.disabled = true;
    flashBtn.disabled   = true;
    releaseSelect.disabled = true;

    setProgress(0, 1, 'Starting…');
    progressWrap.classList.remove('d-none');

    // Wire up device logging
    connectedDevice.logInfo    = (msg) => appendLog(msg, 'info');
    connectedDevice.logWarning = (msg) => appendLog(msg, 'warning');
    connectedDevice.logError   = (msg) => appendLog(msg, 'error');
    connectedDevice.logDebug   = (msg) => {};          // suppress debug noise

    let erasePhase = true;
    connectedDevice.logProgress = (done, total) => {
        if (typeof total !== 'undefined') {
            if (erasePhase) {
                setProgress(done, total, `Erasing… ${pct(done, total)}%`);
                if (done >= total) erasePhase = false;
            } else {
                setProgress(done, total, `Writing… ${pct(done, total)}%`);
            }
        }
    };

    try {
        appendLog('Downloading firmware from GitHub…');
        setProgress(0, 1, 'Downloading firmware…');

        const res = await fetch(selectedAssetUrl);
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const firmwareData = await res.arrayBuffer();
        appendLog(`Downloaded ${(firmwareData.byteLength / 1024).toFixed(1)} KB`);

        setProgress(0, 1, 'Erasing…');
        erasePhase = true;

        await connectedDevice.do_download(TRANSFER_SIZE, firmwareData, false);

        setProgress(1, 1, 'Complete');
        setStatus('success');
        appendLog('Firmware flashed successfully! The device is restarting.', 'success');

    } catch (err) {
        appendLog('Flash failed: ' + err, 'error');
        setStatus('error');
    } finally {
        isFlashing             = false;
        connectBtn.disabled    = false;
        releaseSelect.disabled = false;
        updateFlashButton();
    }
});

// ── UI helpers ────────────────────────────────────────────────────────────────
function updateFlashButton() {
    flashBtn.disabled = !(connectedDevice && selectedAssetUrl && !isFlashing);
}

function setStatus(state) {
    const states = {
        disconnected: { text: 'Not connected',  cls: 'bg-secondary' },
        connecting:   { text: 'Connecting…',    cls: 'bg-warning text-dark' },
        connected:    { text: 'Device ready',   cls: 'bg-success' },
        success:      { text: 'Flash complete', cls: 'bg-success' },
        error:        { text: 'Error',          cls: 'bg-danger' },
    };
    const s = states[state] || states.disconnected;
    statusBadge.textContent = s.text;
    statusBadge.className   = 'badge ' + s.cls;
}

function setProgress(done, total, label) {
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    progressBar.style.width       = percent + '%';
    progressBar.setAttribute('aria-valuenow', percent);
    progressLabel.textContent     = label || (percent + '%');
}

function pct(done, total) {
    return total > 0 ? Math.round((done / total) * 100) : 0;
}

function appendLog(msg, level) {
    const line   = document.createElement('div');
    const clsMap = { info: '', warning: 'text-warning', error: 'text-danger', success: 'text-success' };
    line.className   = clsMap[level] || '';
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.getElementById('app-version').textContent = 'Updater v' + APP_VERSION;
setStatus('disconnected');
loadReleases();
