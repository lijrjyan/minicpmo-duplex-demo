class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions || {};
    this.sourceRate = config.sourceRate || sampleRate;
    this.targetRate = config.targetRate || 16000;
    this.frameSamples = config.frameSamples || 1280;
    this.input = [];
    this.sourcePosition = 0;
    this.frame = new Int16Array(this.frameSamples);
    this.frameOffset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) this.input.push(channel[index]);
    const step = this.sourceRate / this.targetRate;
    while (this.sourcePosition <= this.input.length - 2) {
      const left = Math.floor(this.sourcePosition);
      const weight = this.sourcePosition - left;
      const sample = this.input[left] * (1 - weight) + this.input[left + 1] * weight;
      const clipped = Math.max(-1, Math.min(1, sample));
      this.frame[this.frameOffset] = clipped < 0 ? clipped * 32768 : clipped * 32767;
      this.frameOffset += 1;
      this.sourcePosition += step;
      if (this.frameOffset === this.frameSamples) {
        let energy = 0;
        for (const value of this.frame) energy += (value / 32768) ** 2;
        const frame = this.frame;
        this.port.postMessage({ type: "frame", frame, rms: Math.sqrt(energy / frame.length) }, [frame.buffer]);
        this.frame = new Int16Array(this.frameSamples);
        this.frameOffset = 0;
      }
    }
    const discard = Math.max(0, Math.floor(this.sourcePosition) - 1);
    if (discard) {
      this.input.splice(0, discard);
      this.sourcePosition -= discard;
    }
    return true;
  }
}

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions || {};
    this.initialSamples = config.initialSamples || Math.round(sampleRate * 0.3);
    this.maxSamples = config.maxSamples || Math.round(sampleRate * 2.5);
    this.keepSamples = config.keepSamples || Math.round(sampleRate * 1.5);
    this.dropped = 0;
    this.queue = [];
    this.headOffset = 0;
    this.queuedSamples = 0;
    this.started = false;
    this.lastSample = 0;
    this.fadeRemaining = 0;
    this.fadeLength = Math.max(1, Math.round(sampleRate * 0.01));
    this.playedSamples = 0;
    this.statusCountdown = 0;
    this.statusEnergy = 0;
    this.statusSamples = 0;
    // An underrun is the queue running dry while a response is still open; the
    // gap after response.done (flush) is the model going quiet, not a stall.
    this.responseOpen = false;
    this.underruns = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === "push" && data.samples) {
        this.queue.push(data.samples);
        this.queuedSamples += data.samples.length;
        // A network stall lets audio pile up while the server keeps generating in
        // real time; without a cap the backlog never shrinks and playback drifts
        // behind the transcript. Skip ahead by dropping the oldest samples.
        if (this.queuedSamples > this.maxSamples) this.trim(this.keepSamples);
      } else if (data.type === "trim") {
        this.trim(data.keepSamples || 0);
      } else if (data.type === "open") {
        this.responseOpen = true;
      } else if (data.type === "clear") {
        this.queue = [];
        this.headOffset = 0;
        this.queuedSamples = 0;
        this.started = false;
        this.fadeRemaining = this.fadeLength;
      } else if (data.type === "flush") {
        this.responseOpen = false;
        if (this.queuedSamples > 0) this.started = true;
      } else if (data.type === "reset") {
        this.responseOpen = false;
        this.underruns = 0;
        this.queue = [];
        this.headOffset = 0;
        this.queuedSamples = 0;
        this.started = false;
        this.fadeRemaining = this.fadeLength;
        this.playedSamples = 0;
      }
    };
  }

  trim(keepSamples) {
    while (this.queuedSamples > keepSamples && this.queue.length) {
      const chunk = this.queue[0];
      const remaining = chunk.length - this.headOffset;
      const excess = this.queuedSamples - keepSamples;
      if (remaining <= excess) {
        this.queue.shift();
        this.headOffset = 0;
        this.queuedSamples -= remaining;
        this.dropped += remaining;
      } else {
        this.headOffset += excess;
        this.queuedSamples -= excess;
        this.dropped += excess;
      }
    }
    this.fadeRemaining = this.fadeLength;
  }

  takeSample() {
    const chunk = this.queue[0];
    if (!chunk) return null;
    const value = chunk[this.headOffset];
    this.headOffset += 1;
    this.queuedSamples -= 1;
    this.playedSamples += 1;
    if (this.headOffset >= chunk.length) {
      this.queue.shift();
      this.headOffset = 0;
    }
    return value;
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    if (!this.started && this.queuedSamples >= this.initialSamples) this.started = true;
    for (let index = 0; index < output.length; index += 1) {
      let value = 0;
      if (this.fadeRemaining > 0) {
        value = this.lastSample * (this.fadeRemaining / this.fadeLength);
        this.fadeRemaining -= 1;
      } else if (this.started) {
        const next = this.takeSample();
        if (next === null) {
          this.started = false;
          if (this.responseOpen) this.underruns += 1;
        } else value = next;
      }
      output[index] = value;
      this.lastSample = value;
      this.statusEnergy += value * value;
      this.statusSamples += 1;
    }
    this.statusCountdown -= output.length;
    if (this.statusCountdown <= 0) {
      this.statusCountdown = Math.round(sampleRate / 10);
      this.port.postMessage({
        type: "status",
        droppedMs: Math.round((this.dropped / sampleRate) * 1000),
        queueMs: this.queuedSamples / sampleRate * 1000,
        playedMs: this.playedSamples / sampleRate * 1000,
        buffering: !this.started,
        underruns: this.underruns,
        outputRms: this.statusSamples ? Math.sqrt(this.statusEnergy / this.statusSamples) : 0,
      });
      this.statusEnergy = 0;
      this.statusSamples = 0;
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
registerProcessor("playback-processor", PlaybackProcessor);
