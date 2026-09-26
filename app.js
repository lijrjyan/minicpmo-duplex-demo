// Lite public page for a native full-duplex /v1/realtime session behind the demo gate.
// Protocol handling lives in session.js and audio I/O in worklet.js (both unchanged).
import { DuplexSession, INPUT_RATE, PACKET_SAMPLES } from "./session.js";

const JITTER_MS = 300;
const STATUS_POLL_MS = 5000;
const SESSION_CAP_S = 600;
const MIC_TALK_RMS = 0.02;
const MODEL_TALK_RMS = 0.005;

const ids = ["connectBtn", "startMicBtn", "stopMicBtn", "interruptBtn", "closeBtn", "connectionState", "warnings", "transcript", "youDot", "modelDot", "timer"];
const ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

function wsUrl() {
  const base = window.DEMO_WS_URL || "";
  const token = new URLSearchParams(location.search).get("token");
  if (!token) return base;
  return `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

const CLOSE_MESSAGES = {
  4401: "This demo needs an access link with a token.",
  4408: "The 10-minute limit was reached. Thanks for trying the demo!",
  4429: "Someone else is talking to the model right now, please try again in a minute.",
};

let socket = null;
let session = null;
let connecting = false;
let startingMic = false;
let micGeneration = 0;
let captureContext = null;
let captureStream = null;
let captureNode = null;
let playbackContext = null;
let playbackNode = null;
let playbackRate = 24000;
let transcriptStarted = false;
let eventChain = Promise.resolve();
let remoteBusy = false;
let serverUp = true;
let lastCloseCode = null;
let sessionStart = null;
let micHot = 0;
let modelHot = 0;

function setState(label, state) {
  ui.connectionState.textContent = label;
  ui.connectionState.dataset.state = state;
}

function isOpen() {
  return Boolean(socket) && socket.readyState === WebSocket.OPEN;
}

function isReady() {
  return Boolean(session) && session.state === "ready" && isOpen();
}

function inputActive() {
  return Boolean(captureStream);
}

let mutedResponse = false;

function setButtons() {
  ui.interruptBtn.disabled = !(session && session.responseOpen) || mutedResponse;
  ui.connectBtn.disabled = isOpen() || connecting || (!socket && (remoteBusy || !serverUp));
  ui.startMicBtn.disabled = !isReady() || inputActive() || startingMic;
  ui.stopMicBtn.disabled = !inputActive();
  ui.closeBtn.disabled = !isOpen();
}

// Status line: connected / listening / speaking while in a session, busy / disconnected otherwise.
function refreshState() {
  if (isOpen() && session) {
    if (session.state === "error") setState("error", "error");
    else if (session.state !== "ready") setState(session.state === "closing" ? "closing" : "connected", "connected");
    else if (modelHot > 0) setState("speaking", "speaking");
    else if (inputActive()) setState("listening", "listening");
    else setState("connected", "connected");
  } else if (connecting) setState("connecting", "connected");
  else if (!serverUp) setState("offline, try again later", "error");
  else if (remoteBusy) setState("busy, try again later", "busy");
  else setState("disconnected", "disconnected");
}

function warn(message) {
  ui.warnings.textContent = message;
}

function tick() {
  ui.youDot.dataset.on = String(micHot > 0);
  ui.modelDot.dataset.on = String(modelHot > 0);
  if (sessionStart !== null && isOpen()) {
    const left = Math.max(0, SESSION_CAP_S - Math.floor((performance.now() - sessionStart) / 1000));
    ui.timer.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
  } else ui.timer.textContent = "";
  refreshState();
}

async function pollStatus() {
  if (!window.DEMO_STATUS_URL) return;
  try {
    const response = await fetch(window.DEMO_STATUS_URL, { cache: "no-store" });
    const body = await response.json();
    serverUp = Boolean(body.ok);
    remoteBusy = Boolean(body.busy) && !isOpen();
  } catch {
    serverUp = false;
  }
  setButtons();
  refreshState();
}

async function ensurePlayback(rate) {
  if (playbackContext && playbackRate === rate) {
    await playbackContext.resume();
    return;
  }
  if (playbackContext) await playbackContext.close().catch(() => {});
  playbackRate = rate;
  playbackContext = new AudioContext({ sampleRate: rate, latencyHint: "interactive" });
  await playbackContext.audioWorklet.addModule("worklet.js");
  playbackNode = new AudioWorkletNode(playbackContext, "playback-processor", {
    outputChannelCount: [1],
    processorOptions: { initialSamples: Math.max(1, Math.round(playbackContext.sampleRate * JITTER_MS / 1000)) },
  });
  playbackNode.connect(playbackContext.destination);
  playbackNode.port.onmessage = ({ data }) => {
    if (data.type !== "status") return;
    modelHot = data.outputRms > MODEL_TALK_RMS ? 3 : Math.max(0, modelHot - 1);
  };
  await playbackContext.resume();
}

function pcm16ToFloat(bytes, sourceRate, targetRate) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const source = new Float32Array(bytes.byteLength >> 1);
  for (let index = 0; index < source.length; index += 1) source[index] = view.getInt16(index * 2, true) / 32768;
  if (targetRate === sourceRate || source.length < 2) return source;
  const target = new Float32Array(Math.max(1, Math.round(source.length * targetRate / sourceRate)));
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < target.length; index += 1) {
    const position = Math.min(index * ratio, source.length - 1);
    const left = Math.floor(position);
    const right = Math.min(left + 1, source.length - 1);
    const weight = position - left;
    target[index] = source[left] * (1 - weight) + source[right] * weight;
  }
  return target;
}

function sessionListeners() {
  return {
    state: (state) => {
      if (state === "closed" || state === "error") stopInput();
      setButtons();
      refreshState();
    },
    granted: async () => {
      sessionStart = performance.now();
      await ensurePlayback(session.outputRate);
      setButtons();
      refreshState();
    },
    audio: (bytes) => {
      if (!playbackNode) return;
      // After a local interrupt, drop the rest of that answer; the next
      // response.created lifts the mute.
      if (mutedResponse) return;
      const samples = pcm16ToFloat(bytes, session.outputRate, playbackContext.sampleRate);
      playbackNode.port.postMessage({ type: "push", samples }, [samples.buffer]);
    },
    response: ({ open }) => {
      if (open) mutedResponse = false;
      setButtons();
      if (playbackNode) playbackNode.port.postMessage({ type: open ? "open" : "flush" });
      // A new answer means whatever is still queued belongs to the previous one.
      if (open && playbackNode) playbackNode.port.postMessage({ type: "trim", keepSamples: Math.round(playbackContext.sampleRate * 0.5) });
      if (transcriptStarted) ui.transcript.textContent = session.transcript;
    },
    text: () => {
      if (!transcriptStarted) {
        ui.transcript.textContent = "";
        ui.transcript.classList.remove("empty");
        transcriptStarted = true;
      }
      ui.transcript.textContent = session.transcript;
    },
    unit: (unit) => {
      // The model stopped talking (a unit without audio): what is still queued was
      // generated before that decision, keep at most one unit of it.
      if (unit && unit.decision === "listen" && playbackNode) playbackNode.port.postMessage({ type: "trim", keepSamples: Math.round(playbackContext.sampleRate * 1.0) });
    },
    drained: () => {},
    warning: warn,
  };
}

async function connect() {
  if (connecting || isOpen()) return;
  if (!window.DEMO_WS_URL) throw new Error("This page is not configured with a server address.");
  connecting = true;
  await stopInput();
  transcriptStarted = false;
  lastCloseCode = null;
  sessionStart = null;
  ui.transcript.textContent = "What the model says will appear here.";
  ui.transcript.classList.add("empty");
  warn("");
  if (playbackNode) playbackNode.port.postMessage({ type: "reset" });
  setButtons();
  refreshState();
  let activeSocket = null;
  try {
    // Open playback inside the click so Chrome's autoplay policy lets it run.
    await ensurePlayback(playbackRate);
    activeSocket = new WebSocket(wsUrl());
    socket = activeSocket;
    const activeSession = new DuplexSession({
      transport: (event) => activeSocket.send(JSON.stringify(event)),
      now: () => performance.now(),
      outputModalities: ["audio"],
      instructions: window.DEMO_INSTRUCTIONS || "",
      listeners: sessionListeners(),
    });
    session = activeSession;
    eventChain = Promise.resolve();
    activeSocket.addEventListener("open", () => {
      if (socket !== activeSocket) return;
      connecting = false;
      remoteBusy = false;
      setButtons();
      refreshState();
    });
    activeSocket.addEventListener("message", (message) => {
      eventChain = eventChain.then(async () => {
        if (socket !== activeSocket) return;
        activeSession.handle(JSON.parse(message.data));
      }).catch((error) => warn(`Server event: ${error.message}`));
    });
    activeSocket.addEventListener("error", () => {
      if (socket !== activeSocket) return;
      if (!lastCloseCode) warn("Could not reach the demo server. It may be offline; please try again later.");
    });
    activeSocket.addEventListener("close", async (event) => {
      if (socket !== activeSocket) return;
      lastCloseCode = event.code;
      connecting = false;
      socket = null;
      await stopInput();
      if (CLOSE_MESSAGES[event.code]) warn(CLOSE_MESSAGES[event.code]);
      if (event.code === 4429) remoteBusy = true;
      if (playbackNode) playbackNode.port.postMessage({ type: "reset" });
      modelHot = 0;
      setButtons();
      refreshState();
      pollStatus();
    });
  } catch (error) {
    connecting = false;
    if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) activeSocket.close();
    socket = null;
    warn(error.message);
    setButtons();
    refreshState();
  }
}

function feedInput(frame, rms) {
  if (!isReady()) return;
  session.pushInput(frame);
  micHot = rms > MIC_TALK_RMS ? 4 : Math.max(0, micHot - 1);
}

async function startMic() {
  if (startingMic || inputActive() || !isReady()) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Microphone capture needs Chrome on an HTTPS page.");
  startingMic = true;
  const generation = micGeneration;
  const activeSocket = socket;
  setButtons();
  let pendingStream = null;
  let pendingContext = null;
  const stale = () => generation !== micGeneration || socket !== activeSocket || !isReady();
  try {
    pendingStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (stale()) throw new Error("the session changed while the microphone permission was pending");
    pendingContext = new AudioContext({ latencyHint: "interactive" });
    await pendingContext.audioWorklet.addModule("worklet.js");
    if (stale()) throw new Error("the session changed while the microphone was starting");
    const source = pendingContext.createMediaStreamSource(pendingStream);
    const pendingNode = new AudioWorkletNode(pendingContext, "capture-processor", {
      processorOptions: { sourceRate: pendingContext.sampleRate, targetRate: INPUT_RATE, frameSamples: PACKET_SAMPLES },
    });
    const silent = pendingContext.createGain();
    silent.gain.value = 0;
    source.connect(pendingNode).connect(silent).connect(pendingContext.destination);
    await pendingContext.resume();
    if (stale()) throw new Error("the session changed while the microphone was starting");
    captureStream = pendingStream;
    captureContext = pendingContext;
    captureNode = pendingNode;
    pendingStream = null;
    pendingContext = null;
    pendingNode.port.onmessage = ({ data }) => {
      if (data.type !== "frame" || captureNode !== pendingNode) return;
      feedInput(new Int16Array(data.frame), data.rms);
    };
  } finally {
    if (pendingStream) pendingStream.getTracks().forEach((track) => track.stop());
    if (pendingContext) await pendingContext.close().catch(() => {});
    startingMic = false;
    setButtons();
    refreshState();
  }
}

async function stopInput() {
  micGeneration += 1;
  if (captureStream) captureStream.getTracks().forEach((track) => track.stop());
  captureStream = null;
  captureNode = null;
  micHot = 0;
  if (captureContext) await captureContext.close().catch(() => {});
  captureContext = null;
  setButtons();
}

async function closeNow() {
  await stopInput();
  if (playbackNode) playbackNode.port.postMessage({ type: "clear" });
  if (session && isOpen()) session.close();
  setButtons();
}

ui.connectBtn.addEventListener("click", () => connect().catch((error) => warn(error.message)));
ui.startMicBtn.addEventListener("click", () => startMic().catch((error) => warn(`Microphone: ${error.message}`)));
ui.stopMicBtn.addEventListener("click", () => stopInput().catch((error) => warn(error.message)));
ui.interruptBtn.addEventListener("click", () => {
  mutedResponse = true;
  if (playbackNode) playbackNode.port.postMessage({ type: "clear" });
  setButtons();
});
ui.closeBtn.addEventListener("click", () => closeNow().catch((error) => warn(error.message)));
window.addEventListener("beforeunload", () => { if (session && isOpen()) session.close(); });
setInterval(tick, 100);
setInterval(pollStatus, STATUS_POLL_MS);
pollStatus();
setButtons();
refreshState();
