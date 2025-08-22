// INA229_worker.js

let serialPort, serialReader, serialWriter;
let usbDevice, stopUsbLoop = false;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

let queue = [];
let state = 'idle';
let ackd = true;

function createLineReader(reader) {
  // Buffer to store partial lines
  let buffer = '';

  /**
   * The returned async function that reads one line.
   * @returns {Promise<string | null>} A promise for the next line or null.
   */
  return async function readLine() {
    // Loop indefinitely until a line is found or the stream ends.
    while (true) {
      // Check if the buffer already contains a newline character.
      const newlineIndex = buffer.indexOf('\r\n');
      if (newlineIndex !== -1) {
        // A line is present in the buffer.
        // Extract the line (up to the newline character).
        const line = buffer.slice(0, newlineIndex);
        // Remove the extracted line (and the newline char) from the buffer.
        buffer = buffer.slice(newlineIndex + 2);
        // Return the complete line.
        return line;
      }

      // If no newline is in the buffer, read the next chunk from the stream.
      const {
        value,
        done
      } = await reader.read();

      if (done) {
        // The stream has ended.
        if (buffer.length > 0) {
          // If there's any remaining data in the buffer, it's the last line.
          const lastLine = buffer;
          buffer = ''; // Clear the buffer.
          return lastLine;
        }
        // No more data in the buffer or the stream.
        return null;
      }

      // A new chunk of text has been received. Append it to the buffer.
      // The loop will then repeat, checking again for a newline.
      buffer += value;
    }
  };
}

self.onmessage = async (event) => {
    const { type, command } = event.data;

    switch (type) {
        case 'connect':
            await handleConnect();
            break;
        case 'disconnect':
            await handleDisconnect();
            break;
        case 'write':
            await writeCommand(command);
            break;
        case 'start-stream':
            await writeCommand(command);
            readUsbLoop();
            break;
        case 'stop-stream':
            stopUsbLoop = true;
            await writeCommand('stop 1');
            break;
    }
};

async function handleConnect() {
    try {
        const serialPorts = await navigator.serial.getPorts();
        if (serialPorts.length === 0) throw new Error("No serial port granted.");
        serialPort = serialPorts[0];
        await serialPort.open({ baudRate: 115200 });
        serialWriter = serialPort.writable.getWriter();
        serialReader = createLineReader(serialPort.readable.pipeThrough(new TextDecoderStream()).getReader())
        
        const usbDevices = await navigator.usb.getDevices();
        if (usbDevices.length === 0) throw new Error("No USB device granted.");
        usbDevice = usbDevices[0];
        await usbDevice.open();
        await usbDevice.selectConfiguration(1);
        await usbDevice.claimInterface(0);

        self.postMessage({ type: 'status', payload: 'Connected' });
        readSerialLoop();
    } catch (error) {
        self.postMessage({ type: 'log', payload: { message: `Worker connect error: ${error.message}`, direction: 'system' } });
        self.postMessage({ type: 'status', payload: `Error: ${error.message}` });
    }
}

async function handleDisconnect() {
    stopUsbLoop = true;
    if (serialReader) { await serialReader.cancel(); serialReader.releaseLock(); serialReader = null; }
    if (serialWriter) { serialWriter.releaseLock(); serialWriter = null; }
    if (serialPort && serialPort.readable) { await serialPort.close(); serialPort = null; }
    if (usbDevice && usbDevice.opened) { await usbDevice.close(); usbDevice = null; }
    self.postMessage({ type: 'status', payload: 'Disconnected' });
}

async function writeCommand(command) {
    queue.push(command);
    handleQueue();
}

async function handleQueue() {
    if (!serialWriter) return;
    if ((state == 'idle' || state == 'collecting') && ackd) {
        if (queue.length > 0) {
            let cmd = queue.shift();
            self.postMessage({ type: 'log', payload: { message: cmd, direction: 'out' } });
            ackd = false;
            console.debug(`OUT> ${cmd}`);
            await serialWriter.write(textEncoder.encode(cmd + "\n"));
        }
    } else {
        console.debug(`Deferred. ${queue.length} pending.`)
    }
}

async function readSerialLoop() {
    while (true) {
        try {
            let line = await serialReader()
            if (line === null) {
                break;
            }
            // for some reason they issue malformed json with \n character in the output
            // JSON frames are delimited by \r\n.
            line = line.replace("\n", '') 
            self.postMessage({ type: 'log', payload: { message: line, direction: 'in' } });
            console.debug(`IN> ${line}`);
            try {
                const data = JSON.parse(line);
                if (data.acknowledge) {
                    ackd = true;
                }
                if (data.evm_state) {
                    state = data.evm_state;
                }
                if (data.register) {
                    self.postMessage({ type: 'processed-register-data', payload: { address: data.register.address, rawValue: data.register.value } });
                }
            } catch (e) { /* Ignore non-JSON lines */ }
            handleQueue();
        } catch (error) {
            self.postMessage({ type: 'log', payload: { message: `Worker serial read error: ${error.message}`, direction: 'system' } });
            break;
        }
    }
}

async function readUsbLoop() {
    stopUsbLoop = false;
    while (!stopUsbLoop) {
        try {
            const result = await usbDevice.transferIn(1, 64); // Endpoint 1 IN, 64 bytes
            if (result.status === 'ok') {
                const dataView = result.data;
                const updates = [];
                let offset = 0;
                while(offset < dataView.byteLength) {
                    const frameID = dataView.getUint8(offset);
                    if (frameID !== 0) {
                        offset++; continue;
                    }
                    if (offset + 4 > dataView.byteLength) break;

                    const address = dataView.getUint8(offset + 2);
                    const registerSize = dataView.getUint8(offset + 3);

                    if (offset + 4 + registerSize > dataView.byteLength) break;
                    
                    let rawValue = 0;
                    if (registerSize > 4) {
                        rawValue = 0n;
                        for (let i = 0; i < registerSize; i++) rawValue = (rawValue << 8n) | BigInt(dataView.getUint8(offset + 4 + i));
                        rawValue = Number(rawValue);
                    } else {
                        for (let i = 0; i < registerSize; i++) rawValue = (rawValue << 8) | dataView.getUint8(offset + 4 + i);
                    }
                    
                    updates.push({ address, rawValue: rawValue });
                    offset += 4 + registerSize;
                }
                if (updates.length > 0) {
                    self.postMessage({ type: 'processed-bulk-data', payload: updates });
                }
            }
        } catch (error) {
            if (!stopUsbLoop) {
                self.postMessage({ type: 'log', payload: { message: `Worker USB read error: ${error.message}`, direction: 'system' } });
            }
            break;
        }
    }
}

