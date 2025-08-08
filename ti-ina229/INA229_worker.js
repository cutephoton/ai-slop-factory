// INA229_worker.js

let serialPort, serialReader, serialWriter;
let usbDevice, stopUsbLoop = false;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

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
            await writeCommand('stop');
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
        serialReader = serialPort.readable.getReader();
        
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
    if (!serialWriter) return;
    self.postMessage({ type: 'log', payload: { message: command, direction: 'out' } });
    await serialWriter.write(textEncoder.encode(command + '\n'));
}

let serialReadBuffer = new Uint8Array();
async function readSerialLoop() {
    while (true) {
        try {
            const { value, done } = await serialReader.read();
            if (done) break;
            
            const newBuffer = new Uint8Array(serialReadBuffer.length + value.length);
            newBuffer.set(serialReadBuffer);
            newBuffer.set(value, serialReadBuffer.length);
            serialReadBuffer = newBuffer;
            processTextBuffer();
        } catch (error) {
            self.postMessage({ type: 'log', payload: { message: `Worker serial read error: ${error.message}`, direction: 'system' } });
            break;
        }
    }
}

function processTextBuffer() {
    try {
        const text = textDecoder.decode(serialReadBuffer);
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline === -1) return;

        const linesToProcess = text.substring(0, lastNewline);
        linesToProcess.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed) {
                self.postMessage({ type: 'log', payload: { message: trimmed, direction: 'in' } });
                try {
                    const data = JSON.parse(trimmed);
                    if (data.register) {
                        self.postMessage({ type: 'processed-register-data', payload: { address: data.register.address, rawValue: data.register.value } });
                    }
                } catch (e) { /* Ignore non-JSON lines */ }
            }
        });
        
        const bytesToProcess = textEncoder.encode(text.substring(0, lastNewline + 1)).length;
        serialReadBuffer = serialReadBuffer.slice(bytesToProcess);
    } catch(e) { /* Ignore decode errors on partial data */ }
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

