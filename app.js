// FT260 WebHID → I2C → PMBus (minimal demo)
// Target device: VID 0x0403, PID 0x6030

// --- FT260 constants ---
const VID = 0x0403;
const PID = 0x6030;

// Feature report ID
const FT260_SYSTEM_SETTINGS = 0xA1;

// Output report IDs
const FT260_I2C_READ_REQ = 0xC2;
const FT260_I2C_REPORT_MIN = 0xD0;

// Feature “request” codes (sent via sendFeatureReport with reportId 0xA1)
const FT260_SET_I2C_MODE = 0x02;
const FT260_SET_I2C_CLOCK_SPEED = 0x22;

// I2C Condition flags
const FT260_FLAG_NONE = 0x00;
const FT260_FLAG_START = 0x02;
const FT260_FLAG_START_STOP = 0x06;
const FT260_FLAG_START_STOP_REPEATED = 0x07;

// Limits used in this demo
const FT260_WR_DATA_MAX = 60;
const FT260_RD_DATA_MAX = 60;

function $(id) { return document.getElementById(id); }

const logEl = $("log");
function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function hex2(n, width = 2) {
  return n.toString(16).toUpperCase().padStart(width, "0");
}

function parseHexAddr7(s) {
  const v = parseInt(String(s).trim().replace(/^0x/i, ""), 16);
  if (!Number.isFinite(v) || v < 0 || v > 0x7F) throw new Error(`Invalid 7-bit addr: ${s}`);
  return v;
}

function i2cDataReportId(payloadLen) {
  // FT260 I2C data report id depends on payload length:
  // 0xD0 + floor((len-1)/4)
  return FT260_I2C_REPORT_MIN + Math.floor((payloadLen - 1) / 4);
}

let dev = null;

// Pending read state
let pendingRead = null; // { want, buf, resolve, reject, timeoutId }

function clearPendingRead(err) {
  if (!pendingRead) return;
  const pr = pendingRead;
  pendingRead = null;
  clearTimeout(pr.timeoutId);
  if (err) pr.reject(err);
}

// Input report handler for I2C read data
function onInputReport(e) {
  const reportId = e.reportId;
  const dv = e.data;

  // Convention used by FT260 I2C input reports:
  // byte0 = length, then payload bytes follow
  const len = dv.getUint8(0);
  const chunk = new Uint8Array(dv.buffer, dv.byteOffset + 1, Math.min(len, dv.byteLength - 1));

  log(`IN  report=0x${hex2(reportId)} len=${len} data=${[...chunk].map(b => hex2(b)).join(" ")}`);

  if (!pendingRead) return;

  const pr = pendingRead;
  const remaining = pr.want - pr.buf.length;
  const take = chunk.slice(0, Math.min(remaining, chunk.length));

  const merged = new Uint8Array(pr.buf.length + take.length);
  merged.set(pr.buf, 0);
  merged.set(take, pr.buf.length);
  pr.buf = merged;

  if (pr.buf.length >= pr.want) {
    pendingRead = null;
    clearTimeout(pr.timeoutId);
    pr.resolve(pr.buf.slice(0, pr.want));
  }
}

// --- FT260 actions ---

async function connectFT260() {
  if (!("hid" in navigator)) throw new Error("WebHID not supported. Use Chrome/Edge.");

  // Ask user to select FT260. TIP: if two entries appear, select BOTH (Ctrl/Shift).
  const picked = await navigator.hid.requestDevice({
    filters: [{ vendorId: 0x0403, productId: 0x6030 }]
  });
  if (!picked.length) throw new Error("No device selected.");

  // Prefer the HID interface that exposes I2C report IDs.
  const isFt260I2cInterface = (d) =>
    d.collections?.some(c =>
      c.featureReports?.some(r => r.reportId === 0xA1) ||          // SYSTEM_SETTINGS
      c.outputReports?.some(r => r.reportId === 0xC2) ||           // I2C_READ_REQ
      c.outputReports?.some(r => r.reportId >= 0xD0 && r.reportId <= 0xDE) // I2C data writes
    );

  let candidate = picked.find(isFt260I2cInterface) || picked[0];

  // Open & validate by sending the I2C enable feature report.
  // If it fails, try any other picked devices.
  for (const d of [candidate, ...picked.filter(x => x !== candidate)]) {
    try {
      await d.open();
      d.addEventListener("inputreport", onInputReport);

      // Enable I2C mode (Feature report 0xA1)
      await d.sendFeatureReport(0xA1, new Uint8Array([0x02, 0x01])); // SET_I2C_MODE, enable=1

      dev = d;
      log(`Connected (I2C): ${dev.productName} VID=0x${dev.vendorId.toString(16)} PID=0x${dev.productId.toString(16)}`);
      log("I2C enabled.");
      return;
    } catch (e) {
      try { d.removeEventListener("inputreport", onInputReport); } catch {}
      try { await d.close(); } catch {}
    }
  }

  throw new Error("Could not open an FT260 interface that supports I2C reports. Select the other FT260 entry in the picker.");
}


async function disconnectFT260() {
  if (!dev) return;
  try { dev.removeEventListener("inputreport", onInputReport); } catch {}
  try { await dev.close(); } catch {}
  dev = null;
  clearPendingRead(new Error("Disconnected."));
  log("Disconnected.");
}

async function setI2cClock(khz) {
  if (!dev) throw new Error("Not connected.");
  khz = Number(khz);
  if (!Number.isFinite(khz) || khz < 60 || khz > 3400) {
    throw new Error("Clock must be 60–3400 kHz.");
  }
  const lo = khz & 0xFF;
  const hi = (khz >> 8) & 0xFF;

  await dev.sendFeatureReport(FT260_SYSTEM_SETTINGS, new Uint8Array([
    FT260_SET_I2C_CLOCK_SPEED, lo, hi
  ]));

  log(`I2C clock set to ${khz} kHz.`);
}

async function i2cWrite(addr7, bytes, flag = FT260_FLAG_START_STOP) {
  if (!dev) throw new Error("Not connected.");
  if (bytes.length > FT260_WR_DATA_MAX) throw new Error("Write > 60 bytes not supported in this demo.");

  const reportId = i2cDataReportId(bytes.length);

  // Payload excludes reportId in WebHID:
  // [addr7, flag, length, ...data]
  const payload = new Uint8Array(3 + bytes.length);
  payload[0] = addr7 & 0x7F;
  payload[1] = flag & 0xFF;
  payload[2] = bytes.length & 0xFF;
  payload.set(bytes, 3);

  log(`OUT write report=0x${hex2(reportId)} addr=0x${hex2(addr7)} flag=0x${hex2(flag)} len=${bytes.length} data=${[...bytes].map(b => hex2(b)).join(" ")}`);
  await dev.sendReport(reportId, payload);
}

async function i2cRead(addr7, length, flag = FT260_FLAG_START_STOP, timeoutMs = 1500) {
  if (!dev) throw new Error("Not connected.");
  if (length < 0 || length > FT260_RD_DATA_MAX) throw new Error("Read length must be 0–60 in this demo.");
  if (pendingRead) throw new Error("Another read is already pending.");

  const lo = length & 0xFF;
  const hi = (length >> 8) & 0xFF;

  // Report 0xC2, payload: [addr7, flag, len_lo, len_hi]
  const req = new Uint8Array([addr7 & 0x7F, flag & 0xFF, lo, hi]);

  log(`OUT readReq report=0x${hex2(FT260_I2C_READ_REQ)} addr=0x${hex2(addr7)} flag=0x${hex2(flag)} len=${length}`);
  await dev.sendReport(FT260_I2C_READ_REQ, req);

  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      clearPendingRead(new Error("Read timeout waiting for input report(s)."));
    }, timeoutMs);

    pendingRead = { want: length, buf: new Uint8Array(0), resolve, reject, timeoutId };
  });
}

// PMBus helpers
async function pmbusReadWord(addr7, command) {
  // Write command with START only (no stop)
  await i2cWrite(addr7, new Uint8Array([command & 0xFF]), FT260_FLAG_START);

  // Read 2 bytes with repeated start + stop
  const data = await i2cRead(addr7, 2, FT260_FLAG_START_STOP_REPEATED);

  // SMBus “read word” is little-endian
  const word = data[0] | (data[1] << 8);
  return { raw: data, word };
}

// --- UI wiring ---
function setUiConnected(isConnected) {
  $("btnConnect").disabled = isConnected;
  $("btnDisconnect").disabled = !isConnected;
  $("btnSetClock").disabled = !isConnected;
  $("btnReadVout").disabled = !isConnected;
  $("btnReadStatusWord").disabled = !isConnected;
}

$("btnConnect").addEventListener("click", async () => {
  try {
    await connectFT260();
    setUiConnected(true);
  } catch (e) {
    log(`ERROR: ${e.message || String(e)}`);
    setUiConnected(false);
  }
});

$("btnDisconnect").addEventListener("click", async () => {
  await disconnectFT260();
  setUiConnected(false);
});

$("btnSetClock").addEventListener("click", async () => {
  try {
    const khz = parseInt($("i2cKhz").value, 10);
    await setI2cClock(khz);
  } catch (e) {
    log(`ERROR: ${e.message || String(e)}`);
  }
});

$("btnReadVout").addEventListener("click", async () => {
  try {
    const addr7 = parseHexAddr7($("addr").value);
    const READ_VOUT = 0x8B;

    const { raw, word } = await pmbusReadWord(addr7, READ_VOUT);
    log(`PMBus READ_VOUT raw=[${[...raw].map(b => hex2(b)).join(" ")}] word=0x${hex2(word, 4)} (${word})`);
    log("Note: Decode using VOUT_MODE (Linear/Direct) for real volts.");
  } catch (e) {
    log(`ERROR: ${e.message || String(e)}`);
  }
});

$("btnReadStatusWord").addEventListener("click", async () => {
  try {
    const addr7 = parseHexAddr7($("addr").value);
    const STATUS_WORD = 0x79;

    const { raw, word } = await pmbusReadWord(addr7, STATUS_WORD);
    log(`PMBus STATUS_WORD raw=[${[...raw].map(b => hex2(b)).join(" ")}] word=0x${hex2(word, 4)}`);
  } catch (e) {
    log(`ERROR: ${e.message || String(e)}`);
  }
});

// Initial state
setUiConnected(false);
log("Ready. Click “Connect FT260”.");
