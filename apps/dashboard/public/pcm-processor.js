class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice()); // send a copy of the Float32Array
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
