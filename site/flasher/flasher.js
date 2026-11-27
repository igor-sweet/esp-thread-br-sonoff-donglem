import { ESPLoader, Transport } from "https://unpkg.com/esptool-js@0.7.1/bundle.js";

const $ = (id) => document.getElementById(id);
const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
const MODE = {
  fresh: { address: 0x0, manifestKey: "full", label: "Fresh installation", destructive: true, flashes: true },
  upgrade: { address: 0x20000, manifestKey: "upgrade", label: "Upgrade", destructive: false, flashes: true },
  settings: { label: "Device settings only", destructive: false, flashes: false }
};
let releaseManifest = null;
let busy = false;
let session = null; // console kept open between reading and applying in "Device settings only"
let current = null; // settings reported by the device
const log = (message) => {
  const time = new Date().toLocaleTimeString();
  $("log").textContent += `[${time}] ${String(message)}\n`;
  $("log").scrollTop = $("log").scrollHeight;
};
const status = (message) => { $("status").textContent = message; log(message); };
const currentMode = () => MODE[modeInputs.find(i => i.checked).value];
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
function deviceSettings() {
  const hostname = $("hostname").value.trim();
  return { netmode: $("netmode").value, hostname, valid: !hostname || HOSTNAME.test(hostname) };
}

function refresh() {
  const mode = currentMode();
  const custom = $("source").value === "custom";
  $("firmware-source").hidden = !mode.flashes;
  $("step2-title").textContent = mode.flashes ? "2 · Select firmware" : "2 · Device settings";
  if (!mode.flashes) $("advanced").open = true;
  $("latest-details").hidden = custom;
  $("custom-details").hidden = !custom;
  $("mode-warning").innerHTML = !mode.flashes
    ? "Device settings only reads and changes the network mode and hostname with the firmware's <strong>dongle</strong> console command. <strong>No firmware is written.</strong> It needs firmware with device settings support. Connecting may restart the Dongle-M."
    : mode.destructive
    ? "Fresh installation <strong>erases all ESP32 flash</strong> and clears existing network and Thread settings. Use this for first-time installation or when replacing stock Sonoff ESP32 firmware. The MG24 RCP is not changed."
    : "Upgrade is <strong>only for devices already running Scoobler OpenThread Border Router firmware</strong>. It updates the ESP32 application and Web UI from <strong>0x20000</strong> while retaining supported network and Thread settings. Use Fresh installation when replacing stock Sonoff firmware.";
  $("confirmation-label").lastChild.textContent = mode.destructive
    ? " I understand this will erase all ESP32 settings, and have backed up my Thread dataset if one exists."
    : " This device already runs Scoobler OpenThread Border Router firmware, and I have backed up my Thread dataset.";
  $("confirmation-label").hidden = !mode.flashes;
  $("flash").textContent = mode.flashes ? "Connect and flash" : session ? "Apply settings" : "Connect and read settings";
  $("flash").disabled = busy || !deviceSettings().valid ||
    (mode.flashes && (!$("confirm").checked || (custom ? !$("custom-file").files.length : !releaseManifest)));
  $("current-settings").hidden = !current;
  if (current) {
    $("current-settings").textContent = `Device reports: network mode ${current.netmode}, hostname ${current.hostname}.`;
  }
}
modeInputs.forEach(i => i.addEventListener("change", async () => {
  // The acknowledgement belongs to the selected operation; changing
  // between Upgrade and Fresh installation requires a new acknowledgement.
  $("confirm").checked = false;
  await closeSession();
  refresh();
}));
$("source").addEventListener("change", refresh);
$("custom-file").addEventListener("change", refresh);
$("confirm").addEventListener("change", refresh);
$("netmode").addEventListener("change", refresh);
$("hostname").addEventListener("input", refresh);

const bytesToHex = (array) => [...array].map(x => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (data) => bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
const formatMiB = (n) => (n / 1024 / 1024).toFixed(2) + " MiB";

async function getImage(mode) {
  const custom = $("source").value === "custom";
  if (custom) {
    const file = $("custom-file").files[0];
    if (!file) throw Error("Choose a firmware image");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) throw Error("Selected firmware file is empty");
    // Merged full images are based at 0x0 but the bootloader begins at 0x1000.
    if (mode.destructive && (bytes.length <= 0x1000 || bytes[0x1000] !== 0xe9)) {
      throw Error("Fresh install merged image must contain the ESP32 bootloader at 0x1000 (magic 0xE9)");
    }
    if (!mode.destructive && bytes[0] !== 0xe9) {
      throw Error("Upgrade image should start with an ESP32 application header (0xE9)");
    }
    status(`Loaded custom file ${file.name}, ${formatMiB(bytes.length)}`);
    return bytes;
  }
  const record = releaseManifest[mode.manifestKey];
  if (!record || !record.file || !/^[a-f0-9]{64}$/i.test(record.sha256)) {
    throw Error("Invalid published firmware manifest");
  }
  const url = new URL(record.file, window.location.href);
  if (url.origin !== window.location.origin) throw Error("Firmware URL must be hosted on this site");
  status(`Downloading ${record.file}…`);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw Error(`Firmware download failed (${response.status})`);
  const data = await response.arrayBuffer();
  status(`Verifying SHA-256 of ${formatMiB(data.byteLength)} image…`);
  const digest = await sha256(data);
  if (digest.toLowerCase() !== record.sha256.toLowerCase()) {
    throw Error("SHA-256 mismatch: refusing to flash firmware");
  }
  status("Firmware checksum verified.");
  return new Uint8Array(data);
}

// Firmware with device settings support prints this line at boot, after the "dongle" command is registered.
const READY = /dongle_m_settings: Network mode: (\w+), hostname: ([a-z0-9-]+)\r?\n/;
// Reply to "dongle": the stored values, e.g. "netmode:  ethernet" and "hostname: esp-ot-br (default)".
const SHOWN = /netmode:\s+(\w+)[^\n]*\n\s*hostname:\s+([a-z0-9-]+)/;
const FAILED = /Usage:|Invalid hostname[^\r\n]*\r?\n|Failed to store[^\r\n]*\r?\n/;

async function openConsole(port) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  await port.open({ baudRate: 115200 });
  // Keep EN and GPIO0 released so opening the port does not reset the ESP32.
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  const reader = port.readable.getReader();
  const writer = port.writable.getWriter();
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    } catch (e) { /* the port was closed */ }
  })();
  return {
    async waitFor(pattern, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = buffer.match(pattern);
        if (match) {
          buffer = buffer.slice(match.index + match[0].length);
          return match;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return null;
    },
    async send(command) {
      log(`> ${command}`);
      await writer.write(encoder.encode(command + "\r\n"));
    },
    async close() {
      try { await reader.cancel(); } catch (e) { /* already closed */ }
      await pump;
      reader.releaseLock();
      writer.releaseLock();
      await port.close();
    }
  };
}

async function readSettings(con) {
  await con.send("dongle");
  let match = await con.waitFor(SHOWN, 3000);
  if (!match) {
    // Opening the port may have restarted the ESP32; the boot line reports the same values.
    match = await con.waitFor(READY, 25000);
    if (match) log("The device restarted when the port was opened.");
  }
  if (!match) throw Error("No reply to 'dongle': this firmware does not support device settings");
  return { netmode: match[1], hostname: match[2] };
}

async function applyChanges(con, wanted, reported) {
  // Only differences are sent, and the device only restarts if something changed.
  const changes = [];
  if (wanted.netmode && wanted.netmode !== reported.netmode) {
    changes.push([`dongle netmode ${wanted.netmode}`, /Network mode set to \w+/]);
  }
  if (wanted.hostname && wanted.hostname !== reported.hostname) {
    changes.push([`dongle hostname ${wanted.hostname}`, /Hostname set to [a-z0-9-]+/]);
  }
  if (!changes.length) {
    status("Device settings already match; nothing to change.");
    return false;
  }
  for (const [command, success] of changes) {
    await con.send(command);
    const reply = await con.waitFor(new RegExp(`${success.source}|${FAILED.source}`), 5000);
    if (!reply || !success.test(reply[0])) {
      throw Error(`'${command}' failed${reply ? `: ${reply[0].trim()}` : " (no reply)"}`);
    }
    log(reply[0].trim());
  }
  await con.send("dongle reboot");
  status("Device settings applied. Waiting for the Dongle-M to restart…");
  // The boot line after the restart shows what the device actually loaded from NVS.
  const ready = await con.waitFor(READY, 30000);
  if (!ready) {
    status("Settings were applied, but the restart could not be confirmed. Check the device.");
    return true;
  }
  log(ready[0].trim());
  const mismatch = (wanted.netmode && ready[1] !== wanted.netmode) ||
    (wanted.hostname && ready[2] !== wanted.hostname);
  status(mismatch
    ? `Warning: after the restart the device reports network mode ${ready[1]}, hostname ${ready[2]}.`
    : `Restart complete. The device loaded network mode ${ready[1]}, hostname ${ready[2]}, as requested. ` +
      "Network and Thread will be ready in about half a minute.");
  return true;
}

async function closeSession() {
  if (!session) return;
  const con = session;
  session = null;
  current = null;
  try { await con.close(); } catch (e) { log(`Disconnect: ${e.message || e}`); }
}

async function settingsOnly() {
  if (busy || !deviceSettings().valid) return;
  busy = true; refresh();
  try {
    if (!session) {
      if (!("serial" in navigator)) throw Error("Web Serial is unavailable. Use desktop Chrome or Edge over HTTPS.");
      status("Select the Dongle-M USB serial port in the browser prompt.");
      session = await openConsole(await navigator.serial.requestPort());
      status("Reading current device settings…");
      current = await readSettings(session);
      $("netmode").value = current.netmode;
      $("hostname").value = current.hostname;
      status(`Current settings: network mode ${current.netmode}, hostname ${current.hostname}. ` +
        "Change them and select Apply settings.");
    } else {
      await applyChanges(session, deviceSettings(), current);
      await closeSession();
    }
  } catch (error) {
    status(`Error: ${error.message || error}`);
    await closeSession();
  } finally {
    busy = false;
    refresh();
  }
}

async function flash() {
  if (busy) return;
  const mode = currentMode();
  const custom = $("source").value === "custom";
  const settings = deviceSettings();
  if (!$("confirm").checked || !settings.valid || (!custom && !releaseManifest)) return;
  // The explicit mode-specific acknowledgement checkbox above is the
  // confirmation. Do not show a redundant native browser confirm dialog.
  busy = true; refresh();
  $("progress").value = 0;
  let transport = null;
  try {
    if (!("serial" in navigator)) throw Error("Web Serial is unavailable. Use desktop Chrome or Edge over HTTPS.");
    // requestPort requires transient user activation. Prompt before fetching
    // and hashing a multi-megabyte image, which can outlast that activation.
    status("Select the Dongle-M USB serial port in the browser prompt.");
    const port = await navigator.serial.requestPort();
    const image = await getImage(mode);
    transport = new Transport(port, true);
    const terminal = {
      clean() {},
      writeLine(text) { log(text); },
      write(text) { if (String(text).trim()) log(text); }
    };
    const loader = new ESPLoader({ transport, baudrate: 115200, terminal, debugLogging: false });
    const chip = await loader.main();
    status(`Connected: ${chip}`);
    // esptool-js may report the classic ESP32 as "Unknown ESP32 (revision 3)".
    // Check variant suffixes only immediately after "ESP32": a broad /P[0-9]/
    // would incorrectly reject the "P3" within the name "ESP32" itself.
    const chipMatch = String(chip).match(/\bESP32(?:[-_]?([SCHP]\d+))?\b/i);
    if (!chipMatch || chipMatch[1]) {
      throw Error(`Unsupported chip ${chip}. Dongle-M requires the original ESP32.`);
    }
    if (mode.destructive) {
      status("Erasing entire ESP32 flash…");
      await loader.eraseFlash();
      status("Full chip erase complete. Programming merged firmware at 0x0…");
    } else {
      status("Programming upgrade image at 0x20000 without full-chip erase…");
    }
    await loader.writeFlash({
      fileArray: [{ data: image, address: mode.address }],
      eraseAll: false,
      compress: true,
      flashMode: mode.destructive ? "dio" : "keep",
      flashFreq: mode.destructive ? "40m" : "keep",
      flashSize: mode.destructive ? "16MB" : "keep",
      reportProgress(_index, written, total) {
        $("progress").value = Math.min(100, 100 * written / total);
      }
    });
    // esptool-js v0.7.1 after("hard_reset") only deasserts RTS; it does
    // not pulse EN/reset. The Dongle-M can remain in ROM download mode.
    // Release GPIO0 (DTR=0), pulse EN low (RTS=1), then release EN.
    status("Firmware written and verified. Pulsing ESP32 hardware reset…");
    await loader.after("custom_reset", false, "D0|R0|W100|R1|W150|R0|W400");
    status(mode.destructive
      ? "Fresh installation complete; ESP32 reset pulse sent. Connect via Ethernet, or use the setup access point to configure Wi-Fi if needed. Then set up or restore your Thread network."
      : "Upgrade complete; ESP32 reset pulse sent. The Dongle-M should reconnect over its configured Ethernet or Wi-Fi network with the Thread dataset preserved.");
    if (settings.netmode || settings.hostname) {
      await transport.disconnect();
      transport = null;
      const con = await openConsole(port);
      try {
        status("Waiting for the firmware to start…");
        const ready = await con.waitFor(READY, 25000);
        if (!ready) {
          throw Error("Flashing succeeded, but this firmware did not report device settings support, so the " +
            "advanced settings were not applied");
        }
        log(ready[0].trim());
        await applyChanges(con, settings, { netmode: ready[1], hostname: ready[2] });
      } finally {
        await con.close();
      }
    }
  } catch (error) {
    status(`Error: ${error.message || error}`);
  } finally {
    if (transport) {
      try { await transport.disconnect(); } catch (e) { log(`Disconnect: ${e.message || e}`); }
    }
    busy = false;
    refresh();
  }
}
$("flash").addEventListener("click", () => (currentMode().flashes ? flash() : settingsOnly()));

async function loadManifest() {
  try {
    const response = await fetch("./firmware.json", { cache: "no-store" });
    if (!response.ok) throw Error("No published firmware manifest available yet");
    const json = await response.json();
    if (!json.version || json.full?.offset !== 0 || json.upgrade?.offset !== 0x20000 ||
        !json.full?.file || !json.upgrade?.file) throw Error("Firmware manifest is invalid");
    releaseManifest = json;
    $("release").textContent = `Published release: ${json.version} · Fresh: ${json.full.file} · Upgrade: ${json.upgrade.file}`;
    status(`Release ${json.version} available.`);
  } catch (error) {
    $("release").textContent = `Published release unavailable: ${error.message}. You can still use a trusted custom file.`;
    status("No published firmware loaded.");
  }
  refresh();
}
loadManifest();
