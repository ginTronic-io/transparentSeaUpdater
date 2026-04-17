# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static GitHub Pages site that lets users flash TransparentSea firmware over USB directly from a browser, using the **WebUSB API** and the **STM32 DfuSe protocol**. No backend. No build step. Deploy by pushing to the `gh-pages` branch (or configure GitHub Pages to serve from `main`).

## Deployment

- Hosted on GitHub Pages at `gintronic.github.io/transparentSea` (or a custom domain redirect from `gintronic.io`)
- `.nojekyll` is present to prevent GitHub Pages from running Jekyll
- No dependencies to install — pure HTML/CSS/JS, loaded from CDN or local files

## Firmware releases

Firmware `.bin` files are published as GitHub Release assets on:
`https://github.com/ginTronic-io/transparentSea/releases`

The app fetches available versions via the public GitHub REST API:
`https://api.github.com/repos/ginTronic-io/transparentSea/releases`

Release asset naming convention: `transparentSea-vX.Y.Z.bin`

## Architecture

```
index.html          — single page, no framework
css/style.css       — all styling, dark navy theme, no Bootstrap dependency
js/dfu.js           — standard USB DFU protocol (from devanlai/webdfu, MIT)
js/dfuse.js         — STM32 DfuSe extension (from devanlai/webdfu, MIT); depends on dfu.js
js/app.js           — application logic: release fetching, USB connect, flash orchestration
images/             — company-logo.png (white, for dark bg), device-logo.png (TransparentSea)
```

**Script load order is important:** `dfu.js` → `dfuse.js` → `app.js`. The dfuse namespace extends dfu, and app.js depends on both.

## Key implementation details

**WebUSB device filter** — The Daisy Seed STM32H750 DFU bootloader presents as:
- VID `0x0483` (STMicroelectronics), PID `0xDF11`

**DfuSe memory map** — The STM32 bootloader advertises its memory layout as a string descriptor on the DFU interface (e.g. `@Internal Flash  /0x08000000/01*128Ke,07*128Kg`). `dfuse.Device` reads and parses this automatically; if unavailable at interface detection time, `app.js` calls `readInterfaceNames()` after opening the device to populate it.

**Transfer size** — 2048 bytes (`TRANSFER_SIZE` in `app.js`). Works reliably with the Daisy bootloader.

**Manifestation** — `do_download` is called with `manifestationTolerant = false` because STM32H750 is not manifestation tolerant. The device resets and disconnects after flashing; a USB disconnect error at that point is expected and handled.

**Firmware fetch** — `fetch(browser_download_url)` follows the GitHub CDN redirect to `objects.githubusercontent.com`, which returns `Access-Control-Allow-Origin: *`. This works in Chrome/Edge without a proxy.

## Browser support

WebUSB is **Chrome and Edge only** (desktop). The page shows a warning and disables controls if `navigator.usb` is absent.

## Color scheme

| Token        | Value     | Use                          |
|--------------|-----------|------------------------------|
| `--bg`       | `#0d0d1c` | Page background              |
| `--bg-card`  | `#14142a` | Card background              |
| `--red`      | `#cc2525` | Primary action buttons       |
| `--blue`     | `#3d5080` | TransparentSea brand accent  |
| `--text`     | `#f0f0f0` | Body text                    |
| `--border`   | `#2a2a50` | Card/input borders           |
