/* vim: set expandtab tabstop=4 shiftwidth=4 softtabstop=4: */
export const VIM_VERSION = "8.2.0055";
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

function noop() {}
let debug = noop;
const STATUS_NOT_SET = 0;
const STATUS_NOTIFY_KEY = 1;
const STATUS_NOTIFY_RESIZE = 2;
const STATUS_NOTIFY_OPEN_FILE_BUF_COMPLETE = 3;
const STATUS_NOTIFY_CLIPBOARD_WRITE_COMPLETE = 4;
const STATUS_REQUEST_CMDLINE = 5;
const STATUS_REQUEST_SHARED_BUF = 6;
const STATUS_NOTIFY_ERROR_OUTPUT = 7;
const STATUS_NOTIFY_EVAL_FUNC_RET = 8;

function statusName(s) {
    switch (s) {
        case STATUS_NOT_SET:
            return "NOT_SET";
        case STATUS_NOTIFY_KEY:
            return "NOTIFY_KEY";
        case STATUS_NOTIFY_RESIZE:
            return "NOTIFY_RESIZE";
        case STATUS_NOTIFY_OPEN_FILE_BUF_COMPLETE:
            return "NOTIFY_OPEN_FILE_BUF_COMPLETE";
        case STATUS_NOTIFY_CLIPBOARD_WRITE_COMPLETE:
            return "NOTIFY_CLIPBOARD_WRITE_COMPLETE";
        case STATUS_REQUEST_CMDLINE:
            return "REQUEST_CMDLINE";
        case STATUS_REQUEST_SHARED_BUF:
            return "REQUEST_SHARED_BUF";
        case STATUS_NOTIFY_ERROR_OUTPUT:
            return "NOTIFY_ERROR_OUTPUT";
        case STATUS_NOTIFY_EVAL_FUNC_RET:
            return "STATUS_NOTIFY_EVAL_FUNC_RET";
        default:
            return `Unknown command: ${s}`
    }
}
export function checkBrowserCompatibility() {
    function notSupported(feat) {
        return `${feat} is not supported by this browser. If you're using Firefox or Safari, please enable feature flag.`
    }
    if (typeof SharedArrayBuffer === "undefined") {
        return notSupported("SharedArrayBuffer")
    }
    if (typeof Atomics === "undefined") {
        return notSupported("Atomics API")
    }
    return undefined
};
export class VimWorker {
    constructor(scriptPath, onMessage, onError) {
        // XXX We load all these fnames from Indexed when the Web Worker starts.
        var fnames = JSON.stringify(Object.keys(getfnames()));

        this.worker = new Worker(scriptPath, {name: fnames});
        this.worker.onmessage = this.recvMessage.bind(this);
        this.worker.onerror = this.recvError.bind(this);
        this.sharedBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT*128));
        this.onMessage = onMessage;
        this.onError = onError;
        this.onOneshotMessage = new Map;
        this.debug = false;
        this.pendingEvents = []
    }
    terminate() {
        this.worker.terminate();
        this.worker.onmessage = null;
        debug("Terminated worker thread. Thank you for working hard!")
    }
    sendStartMessage(msg) {
        this.worker.postMessage(msg);
        debug("Sent start message", msg)
    }
    notifyOpenFileBufComplete(filename, bufId) {
        this.enqueueEvent(STATUS_NOTIFY_OPEN_FILE_BUF_COMPLETE, bufId, filename)
    }
    notifyClipboardWriteComplete(cannotSend, bufId) {
        this.enqueueEvent(STATUS_NOTIFY_CLIPBOARD_WRITE_COMPLETE, cannotSend, bufId)
    }
    notifyKeyEvent(key, keyCode, ctrl, shift, alt, meta) {
        this.enqueueEvent(STATUS_NOTIFY_KEY, keyCode, ctrl, shift, alt, meta, key)
    }
    notifyResizeEvent(width, height) {
        this.enqueueEvent(STATUS_NOTIFY_RESIZE, width, height)
    }
    async requestSharedBuffer(byteLength) {
        this.enqueueEvent(STATUS_REQUEST_SHARED_BUF, byteLength);
        const msg = await this.waitForOneshotMessage("shared-buf:response");
        if (msg.buffer.byteLength !== byteLength) {
            throw new Error(`Size of shared buffer from worker ${msg.buffer.byteLength} bytes mismatches to requested size ${byteLength} bytes`)
        }
        return [msg.bufId, msg.buffer]
    }
    notifyClipboardError() {
        this.notifyClipboardWriteComplete(true, 0);
        debug("Reading clipboard failed. Notify it to worker")
    }
    async responseClipboardText(text) {
        const encoded = (new TextEncoder).encode(text);
        const [bufId, buffer] = await this.requestSharedBuffer(encoded.byteLength + 1);
        new Uint8Array(buffer).set(encoded);
        this.notifyClipboardWriteComplete(false, bufId);
        debug("Wrote clipboard", encoded.byteLength, "bytes text and notified to worker")
    }
    async requestCmdline(cmdline) {
        if (cmdline.length === 0) {
            throw new Error("Specified command line is empty")
        }
        this.enqueueEvent(STATUS_REQUEST_CMDLINE, cmdline);
        const msg = await this.waitForOneshotMessage("cmdline:response");
        debug("Result of command", cmdline, ":", msg.success);
        if (!msg.success) {
            throw Error(`Command '${cmdline}' was invalid and not accepted by Vim`)
        }
    }

    // // Added by yours truly. Programmerhat.
    // async requestFile() {
    //     const msg = await this.waitForOneshotMessage("cmdline:response");
    // }

    async notifyErrorOutput(message) {
        const encoded = (new TextEncoder).encode(message);
        const [bufId, buffer] = await this.requestSharedBuffer(encoded.byteLength);
        new Uint8Array(buffer).set(encoded);
        this.enqueueEvent(STATUS_NOTIFY_ERROR_OUTPUT, bufId);
        debug("Sent error message output:", message)
    }
    async notifyEvalFuncRet(ret) {
        const encoded = (new TextEncoder).encode(ret);
        const [bufId, buffer] = await this.requestSharedBuffer(encoded.byteLength);
        new Uint8Array(buffer).set(encoded);
        this.enqueueEvent(STATUS_NOTIFY_EVAL_FUNC_RET, false, bufId);
        debug("Sent return value of evaluated JS function:", ret)
    }
    async notifyEvalFuncError(msg, err, dontReply) {
        const errmsg = `${msg} for jsevalfunc(): ${err.message}: ${err.stack}`;
        if (dontReply) {
            debug("Will send error output from jsevalfunc() though the invocation was notify-only:", errmsg);
            return this.notifyErrorOutput(errmsg)
        }
        const encoded = (new TextEncoder).encode("E9999: " + errmsg);
        const [bufId, buffer] = await this.requestSharedBuffer(encoded.byteLength);
        new Uint8Array(buffer).set(encoded);
        this.enqueueEvent(STATUS_NOTIFY_EVAL_FUNC_RET, true, bufId);
        debug("Sent exception thrown by evaluated JS function:", msg, err)
    }
    onEventDone(doneStatus) {
        const done = statusName(doneStatus);
        const finished = this.pendingEvents.shift();
        if (finished === undefined) {
            throw new Error(`FATAL: Received ${done} event but event queue is empty`)
        }
        if (finished[0] !== doneStatus) {
            throw new Error(`FATAL: Received ${done} event but queue says previous event was ${statusName(finished[0])} with args ${finished[1]}`)
        }
        if (this.pendingEvents.length === 0) {
            debug("No pending event remains after event", done);
            return
        }
        debug("After", done, "event, still", this.pendingEvents.length, "events are pending");
        const [status, values] = this.pendingEvents[0];
        this.sendEvent(status, values)
    }
    enqueueEvent(status, ...values) {
        this.pendingEvents.push([status, values]);
        if (this.pendingEvents.length > 1) {
            debug("Other event is being handled by worker. Pending:", statusName(status), values);
            return
        }
        this.sendEvent(status, values)
    }
    sendEvent(status, values) {
        const event = statusName(status);
        if (this.debug) {
            const status = Atomics.load(this.sharedBuffer, 0);
            if (status !== STATUS_NOT_SET) {
                console.error("INVARIANT ERROR! Status byte must be zero cleared:", event)
            }
        }
        debug("Write event", event, "payload to buffer:", values);
        let idx = 0;
        this.sharedBuffer[idx++] = status;
        for (const value of values) {
            switch (typeof value) {
                case "string":
                    idx = this.encodeStringToBuffer(value, idx);
                    break;
                case "number":
                    this.sharedBuffer[idx++] = value;
                    break;
                case "boolean":
                    this.sharedBuffer[idx++] = +value;
                    break;
                default:
                    throw new Error(`FATAL: Invalid value for payload to worker: ${value}`)
            }
        }
        debug("Wrote", idx * 4, "bytes to buffer for event", event);
        Atomics.notify(this.sharedBuffer, 0, 1);
        debug("Notified event", event, "to worker")
    }
    async waitForOneshotMessage(kind) {
        return new Promise(resolve => {
            this.onOneshotMessage.set(kind, resolve)
        })
    }
    encodeStringToBuffer(s, startIdx) {
        let idx = startIdx;
        const len = s.length;
        this.sharedBuffer[idx++] = len;
        for (let i = 0; i < len; ++i) {
            this.sharedBuffer[idx++] = s.charCodeAt(i)
        }
        return idx
    }
    recvMessage(e, asdf) {
        const msg = e.data;
        const handler = this.onOneshotMessage.get(msg.kind);
        if (handler !== undefined) {
            this.onOneshotMessage.delete(msg.kind);
            handler(msg);
            return
        }
        this.onMessage(msg)
    }
    recvError(e) {
        debug("Received an error from worker:", e);
        const msg = `${e.message} (${e.filename}:${e.lineno}:${e.colno})`;
        this.onError(new Error(msg))
    }
};
export class ResizeHandler {
    constructor(domWidth, domHeight, canvas, worker) {
        this.canvas = canvas;
        this.worker = worker;
        this.elemHeight = domHeight;
        this.elemWidth = domWidth;
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = domWidth * dpr;
        this.canvas.height = domHeight * dpr;
        this.bounceTimerToken = null;
        this.onResize = this.onResize.bind(this)
    }
    onVimInit() {
        window.addEventListener("resize", this.onResize, {
            passive: true
        })
    }
    onVimExit() {
        window.removeEventListener("resize", this.onResize)
    }
    doResize() {
        const rect = this.canvas.getBoundingClientRect();
        debug("Resize Vim:", rect);
        this.elemWidth = rect.width;
        this.elemHeight = rect.height;
        const res = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * res;
        this.canvas.height = rect.height * res;
        this.worker.notifyResizeEvent(rect.width, rect.height)
    }
    onResize() {
        if (this.bounceTimerToken !== null) {
            window.clearTimeout(this.bounceTimerToken)
        }
        this.bounceTimerToken = window.setTimeout(() => {
            this.bounceTimerToken = null;
            this.doResize()
        }, 500)
    }
};
export class InputHandler {
    constructor(worker, input) {
        this.worker = worker;
        this.elem = input;
        this.onKeydown = this.onKeydown.bind(this);
        this.onBlur = this.onBlur.bind(this);
        this.onFocus = this.onFocus.bind(this);
        this.focus()
    }
    setFont(name, size) {
        this.elem.style.fontFamily = name;
        this.elem.style.fontSize = `${size}px`
    }
    focus() {
        this.elem.focus()
    }
    onVimInit() {
        this.elem.addEventListener("keydown", this.onKeydown, {
            capture: true
        });
        this.elem.addEventListener("blur", this.onBlur);
        this.elem.addEventListener("focus", this.onFocus)
    }
    onVimExit() {
        this.elem.removeEventListener("keydown", this.onKeydown);
        this.elem.removeEventListener("blur", this.onBlur);
        this.elem.removeEventListener("focus", this.onFocus)
    }
    onKeydown(event) {
        event.preventDefault();
        event.stopPropagation();
        debug("onKeydown():", event, event.key, event.keyCode);
        let key = event.key;
        const ctrl = event.ctrlKey;
        const shift = event.shiftKey;
        const alt = event.altKey;
        const meta = event.metaKey;
        if (key.length > 1) {
            if (key === "Unidentified" || ctrl && key === "Control" || shift && key === "Shift" || alt && key === "Alt" || meta && key === "Meta") {
                debug("Ignore key input", key);
                return
            }
        }
        if (key === "Â¥" || !shift && key === "|" && event.code === "IntlYen") {
            key = "\\"
        }
        this.worker.notifyKeyEvent(key, event.keyCode, ctrl, shift, alt, meta)
    }
    onFocus() {
        debug("onFocus()")
    }
    onBlur(event) {
        debug("onBlur():", event);
        event.preventDefault()
    }
};
export class ScreenCanvas {
    constructor(worker, canvas, input) {
        this.worker = worker;
        this.canvas = canvas;
        const ctx = this.canvas.getContext("2d", {
            alpha: false
        });
        if (ctx === null) {
            throw new Error("Cannot get 2D context for <canvas>")
        }
        this.ctx = ctx;
        const rect = this.canvas.getBoundingClientRect();
        const res = window.devicePixelRatio || 1;
        this.canvas.width = rect.width * res;
        this.canvas.height = rect.height * res;
        this.canvas.addEventListener("click", this.onClick.bind(this), {
            capture: true,
            passive: true
        });
        this.input = new InputHandler(this.worker, input);
        this.resizer = new ResizeHandler(rect.width, rect.height, canvas, worker);
        this.onAnimationFrame = this.onAnimationFrame.bind(this);
        this.queue = [];
        this.rafScheduled = false;
        this.perf = false;
        this.fgColor = "";
        this.spColor = "";
        this.fontName = ""
    }
    onVimInit() {
        this.input.onVimInit();
        this.resizer.onVimInit()
    }
    onVimExit() {
        this.input.onVimExit();
        this.resizer.onVimExit()
    }
    draw(msg) {
        if (!this.rafScheduled) {
            window.requestAnimationFrame(this.onAnimationFrame);
            this.rafScheduled = true
        }
        this.queue.push(msg)
    }
    focus() {
        this.input.focus()
    }
    getDomSize() {
        return {
            width: this.resizer.elemWidth,
            height: this.resizer.elemHeight
        }
    }
    setPerf(enabled) {
        this.perf = enabled
    }
    setColorFG(name) {
        this.fgColor = name
    }
    setColorBG(_name) {}
    setColorSP(name) {
        this.spColor = name
    }
    setFont(name, size) {
        this.fontName = name;
        this.input.setFont(name, size)
    }
    drawRect(x, y, w, h, color, filled) {
        const dpr = window.devicePixelRatio || 1;
        x = Math.floor(x * dpr);
        y = Math.floor(y * dpr);
        w = Math.floor(w * dpr);
        h = Math.floor(h * dpr);
        this.ctx.fillStyle = color;
        if (filled) {
            this.ctx.fillRect(x, y, w, h)
        } else {
            this.ctx.rect(x, y, w, h)
        }
    }
    drawText(text, ch, lh, cw, x, y, bold, underline, undercurl, strike) {
        const dpr = window.devicePixelRatio || 1;
        ch = ch * dpr;
        lh = lh * dpr;
        cw = cw * dpr;
        x = x * dpr;
        y = y * dpr;
        let font = `${Math.floor(ch)}px ${this.fontName}`;
        if (bold) {
            font = "bold " + font
        }
        this.ctx.font = font;
        this.ctx.textBaseline = "bottom";
        this.ctx.fillStyle = this.fgColor;
        const descent = (lh - ch) / 2;
        const yi = Math.floor(y + lh - descent);
        for (let i = 0; i < text.length; ++i) {
            const c = text[i];
            if (c === " ") {
                continue
            }
            this.ctx.fillText(c, Math.floor(x + cw * i), yi)
        }
        if (underline) {
            this.ctx.strokeStyle = this.fgColor;
            this.ctx.lineWidth = 1 * dpr;
            this.ctx.setLineDash([]);
            this.ctx.beginPath();
            const underlineY = Math.floor(y + lh - descent - 1 * dpr);
            this.ctx.moveTo(Math.floor(x), underlineY);
            this.ctx.lineTo(Math.floor(x + cw * text.length), underlineY);
            this.ctx.stroke()
        } else if (undercurl) {
            this.ctx.strokeStyle = this.spColor;
            this.ctx.lineWidth = 1 * dpr;
            const curlWidth = Math.floor(cw / 3);
            this.ctx.setLineDash([curlWidth, curlWidth]);
            this.ctx.beginPath();
            const undercurlY = Math.floor(y + lh - descent - 1 * dpr);
            this.ctx.moveTo(Math.floor(x), undercurlY);
            this.ctx.lineTo(Math.floor(x + cw * text.length), undercurlY);
            this.ctx.stroke()
        } else if (strike) {
            this.ctx.strokeStyle = this.fgColor;
            this.ctx.lineWidth = 1 * dpr;
            this.ctx.beginPath();
            const strikeY = Math.floor(y + lh / 2);
            this.ctx.moveTo(Math.floor(x), strikeY);
            this.ctx.lineTo(Math.floor(x + cw * text.length), strikeY);
            this.ctx.stroke()
        }
    }
    invertRect(x, y, w, h) {
        const dpr = window.devicePixelRatio || 1;
        x = Math.floor(x * dpr);
        y = Math.floor(y * dpr);
        w = Math.floor(w * dpr);
        h = Math.floor(h * dpr);
        const img = this.ctx.getImageData(x, y, w, h);
        const data = img.data;
        const len = data.length;
        for (let i = 0; i < len; ++i) {
            data[i] = 255 - data[i];
            ++i;
            data[i] = 255 - data[i];
            ++i;
            data[i] = 255 - data[i];
            ++i
        }
        this.ctx.putImageData(img, x, y)
    }
    imageScroll(x, sy, dy, w, h) {
        const dpr = window.devicePixelRatio || 1;
        x = Math.floor(x * dpr);
        sy = Math.floor(sy * dpr);
        dy = Math.floor(dy * dpr);
        w = Math.floor(w * dpr);
        h = Math.floor(h * dpr);
        this.ctx.drawImage(this.canvas, x, sy, w, h, x, dy, w, h)
    }
    onClick() {
        this.input.focus()
    }
    onAnimationFrame() {
        debug("Rendering", this.queue.length, "events on animation frame");
        this.perfMark("raf");
        for (const [method, args] of this.queue) {
            this.perfMark("draw");
            this[method].apply(this, args);
            this.perfMeasure("draw", `draw:${method}`)
        }
        this.queue.length = 0;
        this.rafScheduled = false;
        this.perfMeasure("raf")
    }
    perfMark(m) {
        if (this.perf) {
            performance.mark(m)
        }
    }
    perfMeasure(m, n) {
        if (this.perf) {
            performance.measure(n !== null && n !== void 0 ? n : m, m);
            performance.clearMarks(m)
        }
    }
};
export class VimWasm {
    constructor(opts) {
        const script = opts.workerScriptPath;
        if (!script) {
            throw new Error("'workerScriptPath' option is required")
        }
        this.handleError = this.handleError.bind(this);
        this.worker = new VimWorker(script, this.onMessage.bind(this), this.handleError);
        if ("canvas" in opts && "input" in opts) {
            this.screen = new ScreenCanvas(this.worker, opts.canvas, opts.input)
        } else if ("screen" in opts) {
            this.screen = opts.screen
        } else {
            throw new Error("Invalid options for VimWasm construction: " + JSON.stringify(opts))
        }
        this.perf = false;
        this.debug = false;
        this.perfMessages = {};
        this.running = false;
        this.end = false
        this.fs = new MyIndexedDB(); // XXX
    }
    start(opts) {
        var _a, _b, _c, _d, _e;
        if (this.running || this.end) {
            throw new Error("Cannot start Vim twice")
        }
        const o = opts !== null && opts !== void 0 ? opts : {
            clipboard: navigator.clipboard !== undefined
        };
        if (o.debug) {
            debug = console.log.bind(console, "main:");
            this.worker.debug = true
        }
        this.perf = !!o.perf;
        this.debug = !!o.debug;
        this.screen.setPerf(this.perf);
        this.running = true;
        this.perfMark("init");
        const {
            width: width,
            height: height
        } = this.screen.getDomSize();
        const msg = {
            kind: "start",
            buffer: this.worker.sharedBuffer,
            canvasDomWidth: width,
            canvasDomHeight: height,
            debug: this.debug,
            perf: this.perf,
            clipboard: !!o.clipboard,
            files: (_a = o.files, _a !== null && _a !== void 0 ? _a : {}),
            dirs: (_b = o.dirs, _b !== null && _b !== void 0 ? _b : []),
            fetchFiles: (_c = o.fetchFiles, _c !== null && _c !== void 0 ? _c : {}),
            persistent: (_d = o.persistentDirs, _d !== null && _d !== void 0 ? _d : []),
            cmdArgs: (_e = o.cmdArgs, _e !== null && _e !== void 0 ? _e : [])
        };
        this.worker.sendStartMessage(msg);
        debug("Started with drawer", this.screen)
    }
    async dropFile(name, contents) {
        if (!this.running) {
            throw new Error("Cannot open file since Vim is not running")
        }
        debug("Handling to open file", name, contents);
        const [bufId, buffer] = await this.worker.requestSharedBuffer(contents.byteLength);
        new Uint8Array(buffer).set(new Uint8Array(contents));
        this.worker.notifyOpenFileBufComplete(name, bufId);
        debug("Wrote file", name, "to", contents.byteLength, "bytes buffer and notified it to worker")
    }
    async dropFiles(files) {
        const reader = new FileReader;
        for (const file of files) {
            const [name, contents] = await this.readFile(reader, file);
            await this.dropFile(name, contents)
        }
    }
    resize(pixelWidth, pixelHeight) {
        this.worker.notifyResizeEvent(pixelWidth, pixelHeight)
    }
    sendKeydown(key, keyCode, modifiers) {
        const {
            ctrl: ctrl = false,
            shift: shift = false,
            alt: alt = false,
            meta: meta = false
        } = modifiers !== null && modifiers !== void 0 ? modifiers : {};
        if (key.length > 1) {
            if (key === "Unidentified" || ctrl && key === "Control" || shift && key === "Shift" || alt && key === "Alt" || meta && key === "Meta") {
                debug("Ignore key input", key);
                return
            }
        }
        this.worker.notifyKeyEvent(key, keyCode, ctrl, shift, alt, meta)
    }
    cmdline(cmdline) {
        return this.worker.requestCmdline(cmdline)
    }
    isRunning() {
        return this.running
    }
    focus() {
        this.screen.focus()
    }
    showError(message) {
        return this.worker.notifyErrorOutput(message)
    }
    async readFile(reader, file) {
        return new Promise((resolve, reject) => {
            reader.onload = (f => {
                debug("Read file", file.name, "from D&D:", f);
                resolve([file.name, reader.result])
            });
            reader.onerror = (() => {
                reader.abort();
                reject(new Error(`Error on loading file ${file}`))
            });
            reader.readAsArrayBuffer(file)
        })
    }
    async evalJS(path, contents) {
        debug("Evaluating JavaScript file", path, "with size", contents.byteLength, "bytes");
        const dec = new TextDecoder;
        const src = '"use strict";' + dec.decode(contents);
        try {
            Function(src)()
        } catch (err) {
            debug("Failed to evaluate", path, "with error:", err);
            await this.showError(`${err.message}\n\n${err.stack}`)
        }
    }
    async evalFunc(body, args, notifyOnly) {
        debug("Evaluating JavaScript function:", body, args);
        let f;
        try {
            f = new AsyncFunction(body)
        } catch (err) {
            return this.worker.notifyEvalFuncError("Could not construct function", err, notifyOnly)
        }
        let ret;
        try {
            ret = await f(...args)
        } catch (err) {
            return this.worker.notifyEvalFuncError("Exception was thrown while evaluating function", err, notifyOnly)
        }
        if (notifyOnly) {
            debug("Evaluated JavaScript result was discarded since the message was notify-only:", ret, body);
            return Promise.resolve()
        }
        let retJson;
        try {
            retJson = JSON.stringify(ret)
        } catch (err) {
            return this.worker.notifyEvalFuncError("Could not serialize return value as JSON from function", err, false)
        }
        return this.worker.notifyEvalFuncRet(retJson)
    }
    onMessage(msg) {
        if (this.perf && msg.timestamp !== undefined) {
            const duration = Date.now() - msg.timestamp;
            const name = msg.kind === "draw" ? `draw:${msg.event[0]}` : msg.kind;
            const timestamps = this.perfMessages[name];
            if (timestamps === undefined) {
                this.perfMessages[name] = [duration]
            } else {
                this.perfMessages[name].push(duration)
            }
        }
        switch (msg.kind) {
            case "draw":
                this.screen.draw(msg.event);
                debug("draw event", msg.event);
                break;
            case "done":
                this.worker.onEventDone(msg.status);
                break;
            case "evalfunc": {
                const args = msg.argsJson === undefined ? [] : JSON.parse(msg.argsJson);
                this.evalFunc(msg.body, args, msg.notifyOnly).catch(this.handleError);
                break
            }
            case "title":
                if (this.onTitleUpdate) {
                    debug("title was updated:", msg.title);
                    this.onTitleUpdate(msg.title)
                }
                break;
            case "read-clipboard:request":
                if (this.readClipboard) {
                    this.readClipboard().then(text => this.worker.responseClipboardText(text)).catch(err => {
                        debug("Cannot read clipboard:", err);
                        this.worker.notifyClipboardError()
                    })
                } else {
                    debug("Cannot read clipboard because VimWasm.readClipboard is not set");
                    this.worker.notifyClipboardError()
                }
                break;
            case "write-clipboard":
                debug("Handle writing text", msg.text, "to clipboard with", this.onWriteClipboard);
                if (this.onWriteClipboard) {
                    this.onWriteClipboard(msg.text)
                }
                break;
            case "export":
                if (this.onFileExport !== undefined) {
                    debug("Exporting file", msg.path, "with size in bytes", msg.contents.byteLength);
                    this.onFileExport(msg.path, msg.contents)
                }
                break;
            case "eval":
                this.evalJS(msg.path, msg.contents).catch(this.handleError);
                break;
            case "started":
                this.screen.onVimInit();
                if (this.onVimInit) {
                    this.onVimInit()
                }
                this.perfMeasure("init");
                debug("Vim started");
                break;
            case "exit":
                this.screen.onVimExit();
                this.printPerfs();
                this.worker.terminate();
                if (this.onVimExit) {
                    this.onVimExit(msg.status)
                }
                debug("Vim exited with status", msg.status);
                this.perf = false;
                this.debug = false;
                this.screen.setPerf(false);
                this.running = false;
                this.end = true;
                break;
            case "error":
                debug("Vim threw an error:", msg.message);
                this.handleError(new Error(msg.message));
                this.worker.terminate();
                break;
            case "writeFile":
                if (this.fs) { this.fs.writeFile(msg.fname, msg.file); }
                break;
            default:
                throw new Error(`Unexpected message from worker: ${JSON.stringify(msg)}`)
        }
    }
    handleError(err) {
        if (this.onError) {
            this.onError(err)
        }
    }
    printPerfs() {
        if (!this.perf) {
            return
        } {
            const measurements = new Map;
            for (const e of performance.getEntries()) {
                const ms = measurements.get(e.name);
                if (ms === undefined) {
                    measurements.set(e.name, [e])
                } else {
                    ms.push(e)
                }
            }
            const averages = {};
            const amounts = {};
            const timings = [];
            for (const [name, ms] of measurements) {
                if (ms.length === 1 && ms[0].entryType !== "measure") {
                    timings.push(ms[0]);
                    continue
                }
                console.log(`%c${name}`, "color: green; font-size: large");
                console.table(ms, ["duration", "startTime"]);
                const total = ms.reduce((a, m) => a + m.duration, 0);
                averages[name] = total / ms.length;
                amounts[name] = total
            }
            console.log("%cTimings (ms)", "color: green; font-size: large");
            console.table(timings, ["name", "entryType", "startTime", "duration"]);
            console.log("%cAmount: Perf Mark Durations (ms)", "color: green; font-size: large");
            console.table(amounts);
            console.log("%cAverage: Perf Mark Durations (ms)", "color: green; font-size: large");
            console.table(averages);
            performance.clearMarks();
            performance.clearMeasures()
        } {
            const averages = {};
            for (const name of Object.keys(this.perfMessages)) {
                const durations = this.perfMessages[name];
                const total = durations.reduce((a, d) => a + d, 0);
                averages[name] = total / durations.length
            }
            console.log("%cAverage: Inter-thread Messages Duration (ms)", "color: green; font-size: large");
            console.table(averages);
            this.perfMessages = {}
        }
    }
    perfMark(m) {
        if (this.perf) {
            performance.mark(m)
        }
    }
    perfMeasure(m) {
        if (this.perf) {
            performance.measure(m, m);
            performance.clearMarks(m)
        }
    }
};

//-----------------------------------------------------------------------------
// Interface with IndexedDB. XXX
//-----------------------------------------------------------------------------

const DB_NAME = "EM_FS_/vim.js"; // Same as emscripten FS.
const DB_STORE_NAME = "FILE_DATA"; // Same as emscripten FS.
export class MyIndexedDB {
    constructor() {
        var _this = this;
        this.request = indexedDB.open(DB_NAME, 1.0);
        var request = this.request;

        request.onblocked = function(event) {
            console.error("IndexedDB request blocked", event);
        };

        request.onerror = function (event) {
            console.error("Error creating/accessing IndexedDB database", event);
        };

        request.onupgradeneeded = function (event) {
            var db = event.target.result;
            db.createObjectStore(DB_STORE_NAME);
        };

        request.onsuccess = function (event) {
            _this.db = _this.request.result;
            _this.db.onerror = function (event) {
                console.error("Error creating/accessing IndexedDB database", event);
            };
        }

        return this;
    }

    writeFile(fname /*string*/, file /*ArrayBuffer*/) {
        var buf = new Uint8Array(file);
        var transaction = this.db.transaction([DB_STORE_NAME], "readwrite");
        var put = transaction.objectStore(DB_STORE_NAME).put(buf, fname);

        // Keep track of the files we've written to the filesystem.
        var fnames = getfnames();
        fnames[fname] = true;
        localStorage.setItem('fnames', JSON.stringify(fnames));
    }

    // This is basically debug only as well.
    // returns ArrayBuffer in `callback`.
    getFile(fname /*string*/, callback) {
        var transaction = this.db.transaction([DB_STORE_NAME], "readwrite");
        var get = transaction.objectStore(DB_STORE_NAME).get(fname);
        get.onsuccess = function(event) {
            var contents = event.target.result;
            if (callback) { callback(contents); }
        };
        get.onerror = function(event) {
            console.error('mainthread getFile', event);
        };
    }
}

// Debug only.
function stringify(file) {
  // Taken from https://stackoverflow.com/a/36949791
  var string = new TextDecoder().decode(file);
  console.log('filecontents are:', string);
}

function getfnames() {
    var fnames = JSON.parse(localStorage.getItem('fnames') || '{}');
    return fnames;
}
