package com.yepanywhere;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Rect;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.Bundle;
import android.view.Surface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Proxy;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DeviceServer runs under app_process (shell user) and serves framed screenshot/control traffic.
 *
 * Protocol:
 * - Handshake (device -> sidecar): [width u16 LE][height u16 LE]
 * - Frame request (sidecar -> device): [0x01]
 * - Frame response (device -> sidecar): [0x02][len u32 LE][jpeg bytes]
 * - Control (sidecar -> device): [0x03][len u32 LE][json bytes]
 *   - {"cmd":"capture_settings","maxWidth":360} to request on-device downscaling
 * - Stream status (device -> sidecar): [0x04][len u32 LE][json bytes]
 * - Stream NAL (device -> sidecar): [0x05][flags u8][pts u64 LE][len u32 LE][h264 bytes]
 */
public final class DeviceServer {
    private static final int PORT = 27183;
    private static final byte TYPE_FRAME_REQUEST = 0x01;
    private static final byte TYPE_FRAME_RESPONSE = 0x02;
    private static final byte TYPE_CONTROL = 0x03;
    private static final byte TYPE_STREAM_STATUS = 0x04;
    private static final byte TYPE_STREAM_NAL = 0x05;

    private static final int JPEG_QUALITY = 70;
    private static final int TAP_SLOP_PX = 24;
    private static final int MIN_SWIPE_DURATION_MS = 80;
    private static final int MAX_SWIPE_DURATION_MS = 1200;
    private static final int MAX_CAPTURE_WIDTH = 4096;
    private static final int MAX_STREAM_WIDTH = 4096;
    private static final int MAX_STREAM_HEIGHT = 4096;
    private static final Pattern DISPLAY_SIZE_PATTERN = Pattern.compile("(\\d+)\\s*x\\s*(\\d+)");
    private static volatile FrameCapturer frameCapturer = createFrameCapturer();
    private static volatile int captureMaxWidth = 0; // 0 => native width

    private DeviceServer() {}

    public static void main(String[] args) {
        log("starting on 127.0.0.1:" + PORT);

        while (true) {
            try (ServerSocket server = new ServerSocket(PORT, 1, InetAddress.getByName("127.0.0.1"))) {
                Socket client = server.accept();
                log("client connected: " + client.getRemoteSocketAddress());
                try {
                    handleClient(client);
                } finally {
                    safeClose(client);
                }
            } catch (Throwable t) {
                logError("server loop error", t);
                sleepQuiet(1000);
            }
        }
    }

    private static void handleClient(Socket client) throws IOException {
        client.setTcpNoDelay(true);
        TouchTracker touchTracker = new TouchTracker();
        final Object writeLock = new Object();

        try (DataInputStream in = new DataInputStream(new BufferedInputStream(client.getInputStream()));
             BufferedOutputStream out = new BufferedOutputStream(client.getOutputStream())) {
            MediaCodecStreamer streamer = new MediaCodecStreamer(out, writeLock);

            Frame frame = captureFrame();
            synchronized (writeLock) {
                writeHandshake(out, frame.screenWidth, frame.screenHeight);
            }

            try {
                while (true) {
                    int msgType = in.read();
                    if (msgType < 0) {
                        return;
                    }

                    if (msgType == TYPE_FRAME_REQUEST) {
                        frame = captureFrame();
                        synchronized (writeLock) {
                            writeLengthPrefixed(out, TYPE_FRAME_RESPONSE, frame.jpeg);
                        }
                        continue;
                    }

                    if (msgType == TYPE_CONTROL) {
                        int len = readLengthLE(in);
                        if (len < 0 || len > (4 * 1024 * 1024)) {
                            throw new IOException("invalid control payload length: " + len);
                        }
                        byte[] payload = new byte[len];
                        in.readFully(payload);
                        handleControl(payload, frame.screenWidth, frame.screenHeight, touchTracker, streamer);
                        continue;
                    }

                    throw new IOException(String.format(Locale.US, "unknown message type: 0x%02x", msgType));
                }
            } finally {
                streamer.stop();
            }
        }
    }

    private static void writeHandshake(OutputStream out, int width, int height) throws IOException {
        ByteBuffer b = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN);
        b.putShort((short) Math.max(0, Math.min(0xFFFF, width)));
        b.putShort((short) Math.max(0, Math.min(0xFFFF, height)));
        out.write(b.array());
        out.flush();
    }

    private static void writeLengthPrefixed(OutputStream out, byte type, byte[] payload) throws IOException {
        ByteBuffer header = ByteBuffer.allocate(5).order(ByteOrder.LITTLE_ENDIAN);
        header.put(type);
        header.putInt(payload.length);
        out.write(header.array());
        out.write(payload);
        out.flush();
    }

    private static void writeStreamStatus(
        OutputStream out,
        Object writeLock,
        String cmd,
        boolean ok,
        String error,
        int width,
        int height,
        int bitrate,
        int fps
    ) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("cmd", cmd);
            payload.put("ok", ok);
            if (error != null && !error.isEmpty()) {
                payload.put("error", error);
            }
            if (width > 0) {
                payload.put("width", width);
            }
            if (height > 0) {
                payload.put("height", height);
            }
            if (bitrate > 0) {
                payload.put("bitrate", bitrate);
            }
            if (fps > 0) {
                payload.put("fps", fps);
            }

            byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
            synchronized (writeLock) {
                writeLengthPrefixed(out, TYPE_STREAM_STATUS, bytes);
            }
        } catch (Throwable t) {
            logError("write stream status failed", t);
        }
    }

    private static void writeStreamNal(
        OutputStream out,
        Object writeLock,
        byte flags,
        long ptsUs,
        byte[] payload
    ) throws IOException {
        ByteBuffer header = ByteBuffer.allocate(14).order(ByteOrder.LITTLE_ENDIAN);
        header.put(TYPE_STREAM_NAL);
        header.put(flags);
        header.putLong(ptsUs);
        header.putInt(payload.length);
        synchronized (writeLock) {
            out.write(header.array());
            out.write(payload);
            out.flush();
        }
    }

    private static int readLengthLE(DataInputStream in) throws IOException {
        byte[] lenBytes = new byte[4];
        in.readFully(lenBytes);
        return ByteBuffer.wrap(lenBytes).order(ByteOrder.LITTLE_ENDIAN).getInt();
    }

    private static void handleControl(
        byte[] payload,
        int width,
        int height,
        TouchTracker touchTracker,
        MediaCodecStreamer streamer
    ) {
        String raw = new String(payload, StandardCharsets.UTF_8);
        try {
            JSONObject obj = new JSONObject(raw);
            String cmd = obj.optString("cmd", "");
            switch (cmd) {
                case "touch":
                    handleTouch(obj, width, height, touchTracker);
                    break;
                case "key":
                    handleKey(obj);
                    break;
                case "capture_settings":
                    handleCaptureSettings(obj);
                    break;
                case "stream_start":
                    streamer.start(obj, width, height);
                    break;
                case "stream_stop":
                    streamer.stop();
                    break;
                case "stream_bitrate":
                    streamer.setBitrate(obj.optInt("bps", 0));
                    break;
                case "stream_keyframe":
                    streamer.requestKeyframe();
                    break;
                default:
                    log("unknown control cmd: " + cmd);
            }
        } catch (JSONException e) {
            logError("invalid control json", e);
        }
    }

    private static void handleTouch(JSONObject obj, int width, int height, TouchTracker touchTracker) {
        JSONArray touches = obj.optJSONArray("touches");
        if (touches == null || touches.length() == 0) {
            return;
        }

        JSONObject t = touches.optJSONObject(0);
        if (t == null) {
            return;
        }

        int touchId = t.optInt("id", 0);
        double pressure = t.optDouble("pressure", 0.0);
        double nx = t.optDouble("x", 0.0);
        double ny = t.optDouble("y", 0.0);
        long nowMs = System.currentTimeMillis();
        int x = clamp((int) Math.round(nx * width), 0, Math.max(0, width - 1));
        int y = clamp((int) Math.round(ny * height), 0, Math.max(0, height - 1));

        // Touch release packet: synthesize tap (short/stationary) or swipe.
        if (pressure <= 0.0) {
            TouchState state = touchTracker.activeTouches.remove(touchId);
            touchTracker.activeIds.remove(touchId);
            if (state == null) {
                return;
            }

            int endX = x;
            int endY = y;
            int dx = endX - state.startX;
            int dy = endY - state.startY;
            int distSq = (dx * dx) + (dy * dy);
            int slopSq = TAP_SLOP_PX * TAP_SLOP_PX;

            try {
                if (distSq <= slopSq) {
                    runCommand(new String[]{"input", "tap", String.valueOf(state.startX), String.valueOf(state.startY)});
                } else {
                    int durationMs = clamp((int) (nowMs - state.startTimeMs), MIN_SWIPE_DURATION_MS, MAX_SWIPE_DURATION_MS);
                    runCommand(new String[]{
                        "input",
                        "swipe",
                        String.valueOf(state.startX),
                        String.valueOf(state.startY),
                        String.valueOf(endX),
                        String.valueOf(endY),
                        String.valueOf(durationMs),
                    });
                }
            } catch (IOException e) {
                logError("touch command failed", e);
            }
            return;
        }

        TouchState existing = touchTracker.activeTouches.get(touchId);
        if (existing != null) {
            existing.lastX = x;
            existing.lastY = y;
            existing.lastTimeMs = nowMs;
            return;
        }

        // Track touch-down until release, where we classify tap vs swipe.
        touchTracker.activeIds.add(touchId);
        touchTracker.activeTouches.put(touchId, new TouchState(x, y, nowMs));
    }

    private static void handleKey(JSONObject obj) {
        String key = obj.optString("key", "");
        if (key.isEmpty()) {
            return;
        }

        try {
            // `input text` is unreliable for a standalone space on some devices.
            // Send KEYCODE_SPACE directly for literal space input.
            if (" ".equals(key)) {
                runCommand(new String[]{"input", "keyevent", "KEYCODE_SPACE"});
                return;
            }

            String textArg = mapPrintableKeyToInputTextArg(key);
            if (textArg != null) {
                runCommand(new String[]{"input", "text", textArg});
                return;
            }

            String keyCode = mapKeyCode(key);
            runCommand(new String[]{"input", "keyevent", keyCode});
        } catch (IOException e) {
            logError("key command failed", e);
        }
    }

    private static String mapPrintableKeyToInputTextArg(String key) {
        if (key.length() != 1) {
            return null;
        }

        char ch = key.charAt(0);
        // Keep to printable ASCII; this is what emulator keyboard translation
        // already documents as reliably supported.
        if (ch < 32 || ch >= 127) {
            return null;
        }

        // `%` must be escaped for `input text`.
        if (ch == '%') {
            return "%%";
        }
        return String.valueOf(ch);
    }

    private static void handleCaptureSettings(JSONObject obj) {
        int requested = obj.optInt("maxWidth", 0);
        if (requested <= 0) {
            captureMaxWidth = 0;
            return;
        }
        captureMaxWidth = Math.max(64, Math.min(MAX_CAPTURE_WIDTH, requested));
    }

    private static String mapKeyCode(String key) {
        String normalized = key.trim().toLowerCase(Locale.US);
        switch (normalized) {
            case "back":
            case "goback":
                return "KEYCODE_BACK";
            case "home":
            case "gohome":
                return "KEYCODE_HOME";
            case "appswitch":
            case "app_switch":
            case "recents":
            case "overview":
                return "KEYCODE_APP_SWITCH";
            case "menu":
                return "KEYCODE_MENU";
            case "power":
                return "KEYCODE_POWER";
            case "volume_up":
                return "KEYCODE_VOLUME_UP";
            case "volume_down":
                return "KEYCODE_VOLUME_DOWN";
            case "enter":
                return "KEYCODE_ENTER";
            case "escape":
                return "KEYCODE_ESCAPE";
            case "tab":
                return "KEYCODE_TAB";
            case "space":
                return "KEYCODE_SPACE";
            case "left":
                return "KEYCODE_DPAD_LEFT";
            case "right":
                return "KEYCODE_DPAD_RIGHT";
            case "up":
                return "KEYCODE_DPAD_UP";
            case "down":
                return "KEYCODE_DPAD_DOWN";
            default:
                if (normalized.startsWith("keycode_")) {
                    return normalized.toUpperCase(Locale.US);
                }
                if (normalized.length() == 1) {
                    return ("KEYCODE_" + normalized).toUpperCase(Locale.US);
                }
                return "KEYCODE_" + normalized.toUpperCase(Locale.US);
        }
    }

    private static Frame captureFrame() throws IOException {
        Bitmap captured = null;
        Bitmap toEncode = null;

        FrameCapturer current = frameCapturer;
        try {
            captured = current.captureBitmap();
        } catch (Throwable firstErr) {
            if (!(current instanceof ScreencapFrameCapturer)) {
                logError("capture backend failed, falling back to screencap", firstErr);
                FrameCapturer fallback = new ScreencapFrameCapturer();
                frameCapturer = fallback;
                current = fallback;
                try {
                    captured = current.captureBitmap();
                } catch (Throwable fallbackErr) {
                    throw new IOException("capture failed via fallback screencap backend", fallbackErr);
                }
            } else {
                throw new IOException("capture failed via screencap backend", firstErr);
            }
        }

        if (captured == null) {
            throw new IOException("capture backend returned null bitmap");
        }

        int sourceWidth = captured.getWidth();
        int sourceHeight = captured.getHeight();
        try {
            Bitmap software = ensureSoftwareBitmap(captured);
            toEncode = downscaleForCaptureSetting(software);

            ByteArrayOutputStream jpegOut = new ByteArrayOutputStream(256 * 1024);
            if (!toEncode.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, jpegOut)) {
                throw new IOException("failed to encode JPEG");
            }

            return new Frame(
                jpegOut.toByteArray(),
                toEncode.getWidth(),
                toEncode.getHeight(),
                sourceWidth,
                sourceHeight
            );
        } finally {
            if (toEncode != null && toEncode != captured) {
                toEncode.recycle();
            }
            if (captured != null) {
                captured.recycle();
            }
        }
    }

    private static Bitmap ensureSoftwareBitmap(Bitmap bitmap) throws IOException {
        if (bitmap.getConfig() == Bitmap.Config.HARDWARE) {
            Bitmap copy = bitmap.copy(Bitmap.Config.ARGB_8888, false);
            if (copy == null) {
                throw new IOException("failed to copy hardware bitmap");
            }
            return copy;
        }
        return bitmap;
    }

    private static Bitmap downscaleForCaptureSetting(Bitmap bitmap) {
        int requestedMaxWidth = captureMaxWidth;
        if (requestedMaxWidth <= 0) {
            return bitmap;
        }
        int srcW = bitmap.getWidth();
        int srcH = bitmap.getHeight();
        if (srcW <= requestedMaxWidth) {
            return bitmap;
        }
        int dstW = requestedMaxWidth;
        int dstH = Math.max(1, Math.round((srcH * (float) dstW) / (float) srcW));
        Bitmap scaled = Bitmap.createScaledBitmap(bitmap, dstW, dstH, true);
        if (scaled == null) {
            return bitmap;
        }
        return scaled;
    }

    private static FrameCapturer createFrameCapturer() {
        try {
            FrameCapturer c = AsyncScreenCaptureCapturer.create();
            log("using capture backend: " + c.name());
            return c;
        } catch (Throwable t) {
            log("screen-capture backend unavailable: " + t.getClass().getSimpleName() + " " + t.getMessage());
        }

        try {
            FrameCapturer c = ReflectiveDisplayCaptureCapturer.forBackend(
                "surface-control-capture",
                "android.view.SurfaceControl"
            );
            log("using capture backend: " + c.name());
            return c;
        } catch (Throwable t) {
            log("surface-control-capture backend unavailable: " + t.getClass().getSimpleName() + " " + t.getMessage());
        }

        FrameCapturer c = new ScreencapFrameCapturer();
        log("using capture backend: " + c.name());
        return c;
    }

    private static Method findMethodRequired(Class<?> owner, String name, Class<?>... args) throws NoSuchMethodException {
        try {
            Method m = owner.getMethod(name, args);
            m.setAccessible(true);
            return m;
        } catch (NoSuchMethodException e) {
            Method m = owner.getDeclaredMethod(name, args);
            m.setAccessible(true);
            return m;
        }
    }

    private static Method findMethodOptional(Class<?> owner, String name, Class<?>... args) {
        try {
            return findMethodRequired(owner, name, args);
        } catch (NoSuchMethodException ignored) {
            return null;
        }
    }

    private static Method findMethodOptionalByArity(Class<?> owner, String name, int arity) {
        for (Method m : allMethods(owner)) {
            if (!m.getName().equals(name)) {
                continue;
            }
            if (m.getParameterTypes().length != arity) {
                continue;
            }
            m.setAccessible(true);
            return m;
        }
        return null;
    }

    private static Object getPhysicalDisplayToken() throws Exception {
        // Android 14+ moved physical-display helpers to DisplayControl.
        try {
            Class<?> displayControlClass = Class.forName("android.view.DisplayControl");
            Method getIds = findMethodOptional(displayControlClass, "getPhysicalDisplayIds");
            Method getToken = findMethodOptional(displayControlClass, "getPhysicalDisplayToken", long.class);
            if (getIds != null && getToken != null) {
                Object idsObj = getIds.invoke(null);
                if (idsObj instanceof long[]) {
                    long[] ids = (long[]) idsObj;
                    if (ids.length > 0) {
                        Object token = getToken.invoke(null, ids[0]);
                        if (token != null) {
                            return token;
                        }
                    }
                }
            }
        } catch (Throwable ignored) {
            // Fall through to older SurfaceControl methods.
        }

        Class<?> surfaceControlClass = Class.forName("android.view.SurfaceControl");
        Method getInternalToken = findMethodOptional(surfaceControlClass, "getInternalDisplayToken");
        if (getInternalToken != null) {
            Object token = getInternalToken.invoke(null);
            if (token != null) {
                return token;
            }
        }

        Method getBuiltInDisplay = findMethodOptional(surfaceControlClass, "getBuiltInDisplay", int.class);
        if (getBuiltInDisplay != null) {
            Object token = getBuiltInDisplay.invoke(null, 0);
            if (token != null) {
                return token;
            }
        }

        throw new IOException("physical display token unavailable");
    }

    private static Constructor<?> findDisplayTokenConstructorRequired(Class<?> owner) throws NoSuchMethodException {
        Constructor<?> best = null;
        for (Constructor<?> c : owner.getDeclaredConstructors()) {
            Class<?>[] params = c.getParameterTypes();
            if (params.length < 1) {
                continue;
            }
            if (params[0].isPrimitive()) {
                continue;
            }
            if (best == null || params.length < best.getParameterTypes().length) {
                best = c;
                if (params.length == 1) {
                    break;
                }
            }
        }
        if (best != null) {
            best.setAccessible(true);
            return best;
        }
        throw new NoSuchMethodException("no display-token constructor for " + owner.getName());
    }

    private static Method[] allMethods(Class<?> owner) {
        Method[] declared = owner.getDeclaredMethods();
        Method[] publicMethods = owner.getMethods();
        Method[] all = new Method[declared.length + publicMethods.length];
        System.arraycopy(declared, 0, all, 0, declared.length);
        System.arraycopy(publicMethods, 0, all, declared.length, publicMethods.length);
        return all;
    }

    private static Object defaultValue(Class<?> type) {
        if (!type.isPrimitive()) {
            return null;
        }
        if (type == boolean.class) {
            return false;
        }
        if (type == byte.class) {
            return (byte) 0;
        }
        if (type == short.class) {
            return (short) 0;
        }
        if (type == int.class) {
            return 0;
        }
        if (type == long.class) {
            return 0L;
        }
        if (type == float.class) {
            return 0f;
        }
        if (type == double.class) {
            return 0d;
        }
        if (type == char.class) {
            return '\0';
        }
        return null;
    }

    private static Bitmap screenshotObjectToBitmap(Object screenshot) throws Exception {
        if (screenshot == null) {
            throw new IOException("capture returned null screenshot object");
        }
        if (screenshot instanceof Bitmap) {
            return (Bitmap) screenshot;
        }

        Bitmap direct = tryExtractBitmapLikeObject(screenshot);
        if (direct != null) {
            return direct;
        }

        // Some Android versions return a wrapper (e.g. ScreenCaptureResult) which
        // exposes the actual image object via a getter. Probe no-arg getters once.
        for (Method m : allMethods(screenshot.getClass())) {
            if (m.getParameterTypes().length != 0) {
                continue;
            }
            if (!m.getName().startsWith("get")) {
                continue;
            }
            if (m.getReturnType().isPrimitive()) {
                continue;
            }
            if (m.getDeclaringClass() == Object.class) {
                continue;
            }
            try {
                m.setAccessible(true);
                Object nested = m.invoke(screenshot);
                Bitmap b = tryExtractBitmapLikeObject(nested);
                if (b != null) {
                    return b;
                }
            } catch (Throwable ignored) {
                // Keep probing other getters.
            }
        }

        throw new IOException("could not convert screenshot object to Bitmap: " + screenshot.getClass().getName());
    }

    private static Bitmap tryExtractBitmapLikeObject(Object source) throws Exception {
        if (source == null) {
            return null;
        }
        if (source instanceof Bitmap) {
            return (Bitmap) source;
        }

        Method asBitmap = findMethodOptional(source.getClass(), "asBitmap");
        if (asBitmap != null) {
            Object out = asBitmap.invoke(source);
            if (out instanceof Bitmap) {
                return (Bitmap) out;
            }
        }

        Method getHardwareBuffer = findMethodOptional(source.getClass(), "getHardwareBuffer");
        Method getColorSpace = findMethodOptional(source.getClass(), "getColorSpace");
        if (getHardwareBuffer != null) {
            Object hardwareBuffer = getHardwareBuffer.invoke(source);
            if (hardwareBuffer != null) {
                Method wrap = findBitmapWrapHardwareBufferMethod();
                if (wrap != null) {
                    Object colorSpace = getColorSpace != null ? getColorSpace.invoke(source) : null;
                    Object out = wrap.invoke(null, hardwareBuffer, colorSpace);
                    if (out instanceof Bitmap) {
                        return (Bitmap) out;
                    }
                }
            }
        }
        return null;
    }

    private interface FrameCapturer {
        String name();
        Bitmap captureBitmap() throws Exception;
    }

    private static final class ScreencapFrameCapturer implements FrameCapturer {
        @Override
        public String name() {
            return "screencap";
        }

        @Override
        public Bitmap captureBitmap() throws Exception {
            byte[] png = runCommand(new String[]{"screencap", "-p"});
            Bitmap bitmap = BitmapFactory.decodeByteArray(png, 0, png.length);
            if (bitmap == null) {
                throw new IOException("failed to decode screencap PNG");
            }
            return bitmap;
        }
    }

    private static final class AsyncScreenCaptureCapturer implements FrameCapturer {
        private static final long CAPTURE_TIMEOUT_MS = 1500;

        private final Method captureMethod;
        private final Constructor<?> paramsCtor;
        private final Class<?> outcomeReceiverClass;
        private final Executor directExecutor = Runnable::run;

        private AsyncScreenCaptureCapturer(
            Method captureMethod,
            Constructor<?> paramsCtor,
            Class<?> outcomeReceiverClass
        ) {
            this.captureMethod = captureMethod;
            this.paramsCtor = paramsCtor;
            this.outcomeReceiverClass = outcomeReceiverClass;
        }

        static AsyncScreenCaptureCapturer create() throws Exception {
            Class<?> screenCaptureClass = Class.forName("android.window.ScreenCapture");

            Method captureMethod = null;
            for (Method m : allMethods(screenCaptureClass)) {
                if (!m.getName().equals("capture")) {
                    continue;
                }
                if (!Modifier.isStatic(m.getModifiers())) {
                    continue;
                }
                Class<?>[] params = m.getParameterTypes();
                if (params.length != 3) {
                    continue;
                }
                if (!params[0].getName().contains("ScreenCaptureParams")) {
                    continue;
                }
                if (!Executor.class.isAssignableFrom(params[1])) {
                    continue;
                }
                m.setAccessible(true);
                captureMethod = m;
                break;
            }
            if (captureMethod == null) {
                throw new NoSuchMethodException("no capture(ScreenCaptureParams, Executor, OutcomeReceiver) method");
            }

            Class<?> paramsClass = captureMethod.getParameterTypes()[0];
            Class<?> outcomeReceiverClass = captureMethod.getParameterTypes()[2];
            Constructor<?> paramsCtor = findScreenCaptureParamsConstructorRequired(paramsClass);
            if (paramsCtor == null) {
                throw new NoSuchMethodException("no suitable ScreenCaptureParams constructor");
            }

            return new AsyncScreenCaptureCapturer(
                captureMethod,
                paramsCtor,
                outcomeReceiverClass
            );
        }

        @Override
        public String name() {
            return "screen-capture-async";
        }

        @Override
        public Bitmap captureBitmap() throws Exception {
            Object captureParams = newScreenCaptureParams();

            CountDownLatch done = new CountDownLatch(1);
            AtomicReference<Object> result = new AtomicReference<>();
            AtomicReference<Throwable> error = new AtomicReference<>();

            InvocationHandler handler = (proxy, method, args) -> {
                String n = method.getName();
                if ("onResult".equals(n) && args != null && args.length >= 1) {
                    result.set(args[0]);
                    done.countDown();
                    return null;
                }
                if ("onError".equals(n) && args != null && args.length >= 1) {
                    Object arg = args[0];
                    if (arg instanceof Throwable) {
                        error.set((Throwable) arg);
                    } else {
                        error.set(new RuntimeException(String.valueOf(arg)));
                    }
                    done.countDown();
                    return null;
                }
                return null;
            };
            Object receiver = Proxy.newProxyInstance(
                outcomeReceiverClass.getClassLoader(),
                new Class<?>[]{outcomeReceiverClass},
                handler
            );

            captureMethod.invoke(null, captureParams, directExecutor, receiver);
            if (!done.await(CAPTURE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                throw new IOException("screen capture timed out");
            }

            Throwable captureErr = error.get();
            if (captureErr != null) {
                throw new IOException("screen capture error", captureErr);
            }
            return screenshotObjectToBitmap(result.get());
        }

        private static Constructor<?> findScreenCaptureParamsConstructorRequired(Class<?> paramsClass) {
            Constructor<?> best = null;
            for (Constructor<?> ctor : paramsClass.getDeclaredConstructors()) {
                Class<?>[] params = ctor.getParameterTypes();
                if (params.length < 1) {
                    continue;
                }
                if (params[0] != int.class) {
                    continue;
                }
                boolean allSupported = true;
                for (Class<?> p : params) {
                    if (p.isPrimitive()) {
                        continue;
                    }
                    if (p == String.class) {
                        continue;
                    }
                    allSupported = false;
                    break;
                }
                if (!allSupported) {
                    continue;
                }
                if (best == null || params.length < best.getParameterTypes().length) {
                    best = ctor;
                }
            }
            if (best != null) {
                best.setAccessible(true);
            }
            return best;
        }

        private Object newScreenCaptureParams() throws Exception {
            Class<?>[] types = paramsCtor.getParameterTypes();
            Object[] args = new Object[types.length];
            for (int i = 0; i < types.length; i++) {
                if (types[i] == int.class) {
                    args[i] = 0;
                } else if (types[i] == boolean.class) {
                    args[i] = false;
                } else {
                    args[i] = defaultValue(types[i]);
                }
            }
            // displayId defaults to primary display (0)
            args[0] = 0;
            return paramsCtor.newInstance(args);
        }
    }

    private static final class ReflectiveDisplayCaptureCapturer implements FrameCapturer {
        private final String backendName;
        private final Method captureDisplayMethod;
        private final Constructor<?> argsBuilderCtor;
        private final Method argsBuilderBuildMethod;
        private final Class<?> captureArgsClass;
        private final Method getInternalDisplayTokenMethod;
        private final Method getBuiltInDisplayMethod;
        private volatile Object cachedDisplayToken;

        private ReflectiveDisplayCaptureCapturer(
            String backendName,
            Method captureDisplayMethod,
            Constructor<?> argsBuilderCtor,
            Method argsBuilderBuildMethod,
            Class<?> captureArgsClass,
            Method getInternalDisplayTokenMethod,
            Method getBuiltInDisplayMethod
        ) {
            this.backendName = backendName;
            this.captureDisplayMethod = captureDisplayMethod;
            this.argsBuilderCtor = argsBuilderCtor;
            this.argsBuilderBuildMethod = argsBuilderBuildMethod;
            this.captureArgsClass = captureArgsClass;
            this.getInternalDisplayTokenMethod = getInternalDisplayTokenMethod;
            this.getBuiltInDisplayMethod = getBuiltInDisplayMethod;
        }

        static ReflectiveDisplayCaptureCapturer forBackend(
            String backendName,
            String captureOwnerClassName
        ) throws Exception {
            Class<?> captureOwner = Class.forName(captureOwnerClassName);
            Class<?> surfaceControlClass = Class.forName("android.view.SurfaceControl");

            Method captureDisplay = null;
            for (Method method : allMethods(captureOwner)) {
                if (!method.getName().equals("captureDisplay")) {
                    continue;
                }
                if (!Modifier.isStatic(method.getModifiers())) {
                    continue;
                }
                Class<?>[] params = method.getParameterTypes();
                if (params.length < 1) {
                    continue;
                }
                if (!params[0].getName().contains("DisplayCaptureArgs")) {
                    continue;
                }
                method.setAccessible(true);
                if (captureDisplay == null || params.length == 1) {
                    captureDisplay = method;
                    if (params.length == 1) {
                        break;
                    }
                }
            }
            if (captureDisplay == null) {
                throw new NoSuchMethodException("no captureDisplay(DisplayCaptureArgs, ...) method on " + captureOwnerClassName);
            }

            Class<?> captureArgsClass = captureDisplay.getParameterTypes()[0];
            Class<?> builderClass = Class.forName(captureArgsClass.getName() + "$Builder");
            Constructor<?> builderCtor = findDisplayTokenConstructorRequired(builderClass);
            Method buildMethod = findMethodRequired(builderClass, "build");
            Method getInternalToken = findMethodOptional(surfaceControlClass, "getInternalDisplayToken");
            Method getBuiltInDisplay = findMethodOptional(surfaceControlClass, "getBuiltInDisplay", int.class);

            if (getInternalToken == null && getBuiltInDisplay == null) {
                throw new NoSuchMethodException("no display token method on android.view.SurfaceControl");
            }

            return new ReflectiveDisplayCaptureCapturer(
                backendName,
                captureDisplay,
                builderCtor,
                buildMethod,
                captureArgsClass,
                getInternalToken,
                getBuiltInDisplay
            );
        }

        @Override
        public String name() {
            return backendName;
        }

        @Override
        public Bitmap captureBitmap() throws Exception {
            Object token = getDisplayToken();
            if (token == null) {
                throw new IOException("display token unavailable");
            }

            Class<?>[] ctorParams = argsBuilderCtor.getParameterTypes();
            Object[] ctorArgs = new Object[ctorParams.length];
            ctorArgs[0] = token;
            for (int i = 1; i < ctorParams.length; i++) {
                ctorArgs[i] = defaultValue(ctorParams[i]);
            }
            Object builder = argsBuilderCtor.newInstance(ctorArgs);
            Object captureArgs = argsBuilderBuildMethod.invoke(builder);
            if (!captureArgsClass.isInstance(captureArgs)) {
                throw new IOException("unexpected capture args type: " + captureArgs.getClass().getName());
            }

            Class<?>[] params = captureDisplayMethod.getParameterTypes();
            Object[] invokeArgs = new Object[params.length];
            invokeArgs[0] = captureArgs;
            for (int i = 1; i < params.length; i++) {
                invokeArgs[i] = defaultValue(params[i]);
            }
            Object screenshot = captureDisplayMethod.invoke(null, invokeArgs);
            return screenshotToBitmap(screenshot);
        }

        private Object getDisplayToken() throws Exception {
            Object token = cachedDisplayToken;
            if (token != null) {
                return token;
            }
            synchronized (this) {
                token = cachedDisplayToken;
                if (token != null) {
                    return token;
                }
                if (getInternalDisplayTokenMethod != null) {
                    token = getInternalDisplayTokenMethod.invoke(null);
                }
                if (token == null && getBuiltInDisplayMethod != null) {
                    token = getBuiltInDisplayMethod.invoke(null, 0);
                }
                cachedDisplayToken = token;
                return token;
            }
        }

        private Bitmap screenshotToBitmap(Object screenshot) throws Exception {
            if (screenshot == null) {
                throw new IOException("captureDisplay returned null screenshot object");
            }
            if (screenshot instanceof Bitmap) {
                return (Bitmap) screenshot;
            }

            Method asBitmap = findMethodOptional(screenshot.getClass(), "asBitmap");
            if (asBitmap != null) {
                Object out = asBitmap.invoke(screenshot);
                if (out instanceof Bitmap) {
                    return (Bitmap) out;
                }
            }

            Method getHardwareBuffer = findMethodOptional(screenshot.getClass(), "getHardwareBuffer");
            Method getColorSpace = findMethodOptional(screenshot.getClass(), "getColorSpace");
            if (getHardwareBuffer != null) {
                Object hardwareBuffer = getHardwareBuffer.invoke(screenshot);
                if (hardwareBuffer != null) {
                    Method wrap = findBitmapWrapHardwareBufferMethod();
                    if (wrap != null) {
                        Object colorSpace = getColorSpace != null ? getColorSpace.invoke(screenshot) : null;
                        Object out = wrap.invoke(null, hardwareBuffer, colorSpace);
                        if (out instanceof Bitmap) {
                            return (Bitmap) out;
                        }
                    }
                }
            }

            throw new IOException("could not convert screenshot object to Bitmap: " + screenshot.getClass().getName());
        }
    }

    private static final class MediaCodecStreamer {
        private static final int MAX_START_ATTEMPTS = 4; // initial + up to 3 downgrade retries
        private static final long DISPLAY_POLL_INTERVAL_MS = 1000;
        private static final int[] FALLBACK_MAX_SIDES = new int[]{2560, 1920, 1600, 1280, 1024, 800, 640, 540, 480};

        private final OutputStream out;
        private final Object writeLock;
        private final Object stateLock = new Object();

        private volatile boolean running;
        private Thread outputThread;
        private MediaCodec codec;
        private Surface inputSurface;
        private Object virtualDisplayToken;
        private Method destroyDisplayMethod;
        private Object virtualDisplayObject;
        private Method releaseVirtualDisplayMethod;
        private int streamWidth;
        private int streamHeight;
        private int streamBitrate;
        private int streamFps;
        private int requestedWidth;
        private int requestedHeight;
        private int sourceScreenWidth;
        private int sourceScreenHeight;

        MediaCodecStreamer(OutputStream out, Object writeLock) {
            this.out = out;
            this.writeLock = writeLock;
        }

        void start(JSONObject obj, int fallbackScreenWidth, int fallbackScreenHeight) {
            int width = clamp(obj.optInt("width", fallbackScreenWidth), 64, MAX_STREAM_WIDTH);
            int height = clamp(obj.optInt("height", fallbackScreenHeight), 64, MAX_STREAM_HEIGHT);
            int bitrate = clamp(obj.optInt("bitrate", 2_000_000), 128_000, 50_000_000);
            int fps = clamp(obj.optInt("fps", 30), 1, 120);

            synchronized (stateLock) {
                stopLocked();
                try {
                    requestedWidth = width;
                    requestedHeight = height;
                    int[] displaySize = readDisplaySizeOrFallback(fallbackScreenWidth, fallbackScreenHeight);
                    startPipelineWithRetriesLocked(displaySize[0], displaySize[1], bitrate, fps);
                    running = true;
                    outputThread = new Thread(this::runOutputLoop, "yep-stream-encoder");
                    outputThread.setDaemon(true);
                    outputThread.start();

                    writeStreamStatus(
                        out,
                        writeLock,
                        "stream_start",
                        true,
                        null,
                        streamWidth,
                        streamHeight,
                        streamBitrate,
                        streamFps
                    );
                } catch (Throwable t) {
                    stopLocked();
                    String err = t.getClass().getSimpleName() + ": " + t.getMessage();
                    writeStreamStatus(out, writeLock, "stream_start", false, err, 0, 0, 0, 0);
                    logError("stream_start failed", t);
                }
            }
        }

        void stop() {
            synchronized (stateLock) {
                stopLocked();
            }
        }

        void setBitrate(int bps) {
            if (bps <= 0) {
                return;
            }
            synchronized (stateLock) {
                if (codec == null) {
                    writeStreamStatus(out, writeLock, "stream_bitrate", false, "stream not running", 0, 0, 0, 0);
                    return;
                }
                try {
                    Bundle params = new Bundle();
                    params.putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bps);
                    codec.setParameters(params);
                    streamBitrate = bps;
                    writeStreamStatus(
                        out,
                        writeLock,
                        "stream_bitrate",
                        true,
                        null,
                        streamWidth,
                        streamHeight,
                        streamBitrate,
                        streamFps
                    );
                } catch (Throwable t) {
                    writeStreamStatus(out, writeLock, "stream_bitrate", false, t.getMessage(), 0, 0, 0, 0);
                    logError("stream_bitrate failed", t);
                }
            }
        }

        void requestKeyframe() {
            synchronized (stateLock) {
                if (codec == null) {
                    return;
                }
                try {
                    Bundle params = new Bundle();
                    params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
                    codec.setParameters(params);
                } catch (Throwable t) {
                    logError("stream_keyframe failed", t);
                }
            }
        }

        private void runOutputLoop() {
            for (;;) {
                MediaCodec localCodec;
                int localScreenW;
                int localScreenH;
                synchronized (stateLock) {
                    if (!running || codec == null) {
                        return;
                    }
                    localCodec = codec;
                    localScreenW = sourceScreenWidth;
                    localScreenH = sourceScreenHeight;
                }

                MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
                long nextDisplayPollAt = System.currentTimeMillis() + DISPLAY_POLL_INTERVAL_MS;

                for (;;) {
                    synchronized (stateLock) {
                        if (!running) {
                            return;
                        }
                        if (codec != localCodec) {
                            // Stream was restarted.
                            break;
                        }
                    }

                    int index;
                    try {
                        index = localCodec.dequeueOutputBuffer(info, 100_000);
                    } catch (Throwable t) {
                        logError("encoder dequeue failed", t);
                        return;
                    }

                    if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
                        // no-op
                    } else if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        try {
                            MediaFormat outputFormat = localCodec.getOutputFormat();
                            ByteBuffer csd0 = outputFormat.getByteBuffer("csd-0");
                            ByteBuffer csd1 = outputFormat.getByteBuffer("csd-1");
                            int csd0Len = csd0 != null ? csd0.remaining() : 0;
                            int csd1Len = csd1 != null ? csd1.remaining() : 0;
                            String csd0Prefix = csd0 != null ? hexPrefix(csd0, 24) : "";
                            String csd1Prefix = csd1 != null ? hexPrefix(csd1, 24) : "";
                            log("encoder output format changed: " + outputFormat +
                                " csd0=" + csd0Len + " csd1=" + csd1Len +
                                " csd0Prefix=" + csd0Prefix +
                                " csd1Prefix=" + csd1Prefix);
                        } catch (Throwable t) {
                            logError("failed to inspect output format", t);
                        }
                    } else if (index >= 0) {
                        try {
                            ByteBuffer buf = localCodec.getOutputBuffer(index);
                            if (buf != null && info.size > 0) {
                                ByteBuffer dup = buf.duplicate();
                                dup.position(info.offset);
                                dup.limit(info.offset + info.size);
                                byte[] payload = new byte[info.size];
                                dup.get(payload);

                                byte flags = 0;
                                if ((info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0) {
                                    flags |= 0x01;
                                }
                                if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                                    flags |= 0x02;
                                }
                                writeStreamNal(out, writeLock, flags, info.presentationTimeUs, payload);
                            }
                        } catch (Throwable t) {
                            logError("write stream NAL failed", t);
                            return;
                        } finally {
                            try {
                                localCodec.releaseOutputBuffer(index, false);
                            } catch (Throwable ignored) {
                            }
                        }
                    }

                    long now = System.currentTimeMillis();
                    if (now >= nextDisplayPollAt) {
                        nextDisplayPollAt = now + DISPLAY_POLL_INTERVAL_MS;
                        int[] size = readDisplaySizeOrFallback(localScreenW, localScreenH);
                        if (size[0] != localScreenW || size[1] != localScreenH) {
                            if (!restartForDisplayChange(size[0], size[1])) {
                                return;
                            }
                            break;
                        }
                    }
                }
            }
        }

        private boolean restartForDisplayChange(int newScreenW, int newScreenH) {
            synchronized (stateLock) {
                if (!running) {
                    return false;
                }
                log("display size changed " + sourceScreenWidth + "x" + sourceScreenHeight +
                    " -> " + newScreenW + "x" + newScreenH + ", restarting encoder");
                try {
                    releasePipelineLocked();
                    startPipelineWithRetriesLocked(newScreenW, newScreenH, streamBitrate, streamFps);
                    return true;
                } catch (Throwable t) {
                    running = false;
                    logError("stream restart failed", t);
                    return false;
                }
            }
        }

        private void startPipelineWithRetriesLocked(int screenWidth, int screenHeight, int bitrate, int fps) throws Exception {
            List<int[]> candidates = buildResolutionCandidates(screenWidth, screenHeight, requestedWidth, requestedHeight);
            Throwable lastErr = null;
            int attempts = 0;
            for (int[] size : candidates) {
                if (attempts >= MAX_START_ATTEMPTS) {
                    break;
                }
                attempts++;
                int width = size[0];
                int height = size[1];
                try {
                    configureEncoder(width, height, bitrate, fps);
                    attachVirtualDisplay(screenWidth, screenHeight, width, height);
                    sourceScreenWidth = screenWidth;
                    sourceScreenHeight = screenHeight;
                    return;
                } catch (Throwable t) {
                    lastErr = t;
                    log("stream init attempt " + attempts + " failed at " + width + "x" + height +
                        ": " + t.getClass().getSimpleName() + " " + t.getMessage());
                    releasePipelineLocked();
                }
            }
            if (lastErr instanceof Exception) {
                throw (Exception) lastErr;
            }
            throw new IOException("stream init failed after retries");
        }

        private List<int[]> buildResolutionCandidates(int screenWidth, int screenHeight, int reqWidth, int reqHeight) {
            int srcW = Math.max(1, screenWidth);
            int srcH = Math.max(1, screenHeight);
            int requestedLong = Math.max(reqWidth, reqHeight);
            int requestedShort = Math.min(reqWidth, reqHeight);

            int boundsW = srcW >= srcH ? requestedLong : requestedShort;
            int boundsH = srcW >= srcH ? requestedShort : requestedLong;
            int[] initial = fitInsideBounds(srcW, srcH, boundsW, boundsH);
            int initialMaxSide = Math.max(initial[0], initial[1]);

            List<int[]> out = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            addCandidate(out, seen, initial[0], initial[1]);

            for (int side : FALLBACK_MAX_SIDES) {
                if (side >= initialMaxSide) {
                    continue;
                }
                double scale = side / (double) initialMaxSide;
                int w = normalizeDimension((int) Math.floor(initial[0] * scale), MAX_STREAM_WIDTH);
                int h = normalizeDimension((int) Math.floor(initial[1] * scale), MAX_STREAM_HEIGHT);
                addCandidate(out, seen, w, h);
            }
            return out;
        }

        private void addCandidate(List<int[]> out, Set<String> seen, int width, int height) {
            int w = normalizeDimension(width, MAX_STREAM_WIDTH);
            int h = normalizeDimension(height, MAX_STREAM_HEIGHT);
            String key = w + "x" + h;
            if (seen.add(key)) {
                out.add(new int[]{w, h});
            }
        }

        private int[] fitInsideBounds(int srcW, int srcH, int maxW, int maxH) {
            int safeMaxW = Math.max(64, Math.min(MAX_STREAM_WIDTH, maxW));
            int safeMaxH = Math.max(64, Math.min(MAX_STREAM_HEIGHT, maxH));
            double scaleW = safeMaxW / (double) Math.max(1, srcW);
            double scaleH = safeMaxH / (double) Math.max(1, srcH);
            double scale = Math.min(1.0, Math.min(scaleW, scaleH));
            int outW = normalizeDimension((int) Math.floor(srcW * scale), MAX_STREAM_WIDTH);
            int outH = normalizeDimension((int) Math.floor(srcH * scale), MAX_STREAM_HEIGHT);
            return new int[]{outW, outH};
        }

        private int normalizeDimension(int value, int max) {
            int clamped = clamp(value, 64, max);
            if ((clamped & 1) == 1) {
                clamped = Math.max(64, clamped - 1);
            }
            return clamped;
        }

        private void configureEncoder(int width, int height, int bitrate, int fps) throws IOException {
            MediaFormat format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
            format.setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
            );
            format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
            format.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
            format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
            // Browser decoders are most reliable with baseline-constrained streams.
            try {
                format.setInteger(
                    MediaFormat.KEY_PROFILE,
                    MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline
                );
            } catch (Throwable ignored) {
            }
            // Improves decoder recovery after packet drops and for late subscribers.
            try {
                format.setInteger(MediaFormat.KEY_PREPEND_HEADER_TO_SYNC_FRAMES, 1);
            } catch (Throwable ignored) {
                try {
                    // Vendor key seen on some Android builds.
                    format.setInteger("prepend-sps-pps-to-idr-frames", 1);
                } catch (Throwable ignoredAgain) {
                }
            }
            try {
                format.setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000);
            } catch (Throwable ignored) {
            }

            MediaCodec localCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
            localCodec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            Surface surface = localCodec.createInputSurface();
            localCodec.start();

            codec = localCodec;
            inputSurface = surface;
            streamWidth = width;
            streamHeight = height;
            streamBitrate = bitrate;
            streamFps = fps;
        }

        private void attachVirtualDisplay(int screenWidth, int screenHeight, int width, int height) throws Exception {
            Throwable displayManagerError = null;
            try {
                attachVirtualDisplayViaDisplayManager(width, height);
                return;
            } catch (Throwable t) {
                displayManagerError = t;
                log("DisplayManager createVirtualDisplay unavailable, falling back to SurfaceControl: " +
                    t.getClass().getSimpleName() + " " + t.getMessage());
            }

            try {
                attachVirtualDisplayViaSurfaceControl(screenWidth, screenHeight, width, height);
            } catch (Throwable t) {
                if (displayManagerError != null) {
                    throw new IOException(
                        "virtual display setup failed (DisplayManager + SurfaceControl): " +
                            displayManagerError.getClass().getSimpleName() + " / " + t.getClass().getSimpleName(),
                        t
                    );
                }
                throw t;
            }
        }

        private void attachVirtualDisplayViaDisplayManager(int width, int height) throws Exception {
            Class<?> displayManagerClass = Class.forName("android.hardware.display.DisplayManager");
            Method createVirtualDisplay = findMethodOptional(
                displayManagerClass,
                "createVirtualDisplay",
                String.class,
                int.class,
                int.class,
                int.class,
                Surface.class
            );
            if (createVirtualDisplay == null || !Modifier.isStatic(createVirtualDisplay.getModifiers())) {
                throw new NoSuchMethodException("DisplayManager.createVirtualDisplay(name,w,h,displayId,surface)");
            }
            Object vd = createVirtualDisplay.invoke(null, "yep-stream", width, height, 0, inputSurface);
            if (vd == null) {
                throw new IOException("DisplayManager.createVirtualDisplay returned null");
            }
            Method release = findMethodOptionalByArity(vd.getClass(), "release", 0);
            if (release == null) {
                throw new NoSuchMethodException("VirtualDisplay.release()");
            }

            virtualDisplayObject = vd;
            releaseVirtualDisplayMethod = release;
            virtualDisplayToken = null;
            destroyDisplayMethod = null;
        }

        private void attachVirtualDisplayViaSurfaceControl(int screenWidth, int screenHeight, int width, int height) throws Exception {
            Class<?> surfaceControlClass = Class.forName("android.view.SurfaceControl");
            Method createDisplay = findMethodOptional(surfaceControlClass, "createDisplay", String.class, boolean.class);
            Method openTransaction = findMethodOptionalByArity(surfaceControlClass, "openTransaction", 0);
            Method closeTransaction = findMethodOptionalByArity(surfaceControlClass, "closeTransaction", 0);
            Method setDisplaySurface = findMethodOptionalByArity(surfaceControlClass, "setDisplaySurface", 2);
            Method setDisplayProjection = findMethodOptionalByArity(surfaceControlClass, "setDisplayProjection", 4);
            Method setDisplayLayerStack = findMethodOptionalByArity(surfaceControlClass, "setDisplayLayerStack", 2);
            Method destroyDisplay = findMethodOptionalByArity(surfaceControlClass, "destroyDisplay", 1);

            if (createDisplay == null ||
                openTransaction == null ||
                closeTransaction == null ||
                setDisplaySurface == null ||
                setDisplayProjection == null ||
                setDisplayLayerStack == null) {
                throw new NoSuchMethodException("missing SurfaceControl display methods");
            }

            Object token = createDisplay.invoke(null, "yep-stream", false);
            if (token == null) {
                throw new IOException("SurfaceControl.createDisplay returned null");
            }

            int srcW = Math.max(1, screenWidth);
            int srcH = Math.max(1, screenHeight);
            Rect sourceRect = new Rect(0, 0, srcW, srcH);
            Rect displayRect = new Rect(0, 0, Math.max(1, width), Math.max(1, height));

            openTransaction.invoke(null);
            try {
                setDisplaySurface.invoke(null, token, inputSurface);
                setDisplayProjection.invoke(null, token, 0, sourceRect, displayRect);
                setDisplayLayerStack.invoke(null, token, 0);
            } finally {
                closeTransaction.invoke(null);
            }

            virtualDisplayToken = token;
            destroyDisplayMethod = destroyDisplay;
            virtualDisplayObject = null;
            releaseVirtualDisplayMethod = null;

            // Best effort: touch physical-display token so failures surface early on new Android versions.
            try {
                getPhysicalDisplayToken();
            } catch (Throwable ignored) {
            }
        }

        private void stopLocked() {
            running = false;

            Thread t = outputThread;
            outputThread = null;
            if (t != null && t != Thread.currentThread()) {
                try {
                    t.join(500);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }

            outputThread = null;
            releasePipelineLocked();
        }

        private void releasePipelineLocked() {
            if (codec != null) {
                try {
                    codec.signalEndOfInputStream();
                } catch (Throwable ignored) {
                }
                try {
                    codec.stop();
                } catch (Throwable ignored) {
                }
                try {
                    codec.release();
                } catch (Throwable ignored) {
                }
                codec = null;
            }

            if (inputSurface != null) {
                try {
                    inputSurface.release();
                } catch (Throwable ignored) {
                }
                inputSurface = null;
            }

            if (virtualDisplayObject != null && releaseVirtualDisplayMethod != null) {
                try {
                    releaseVirtualDisplayMethod.invoke(virtualDisplayObject);
                } catch (Throwable ignored) {
                }
            }
            virtualDisplayObject = null;
            releaseVirtualDisplayMethod = null;

            if (virtualDisplayToken != null && destroyDisplayMethod != null) {
                try {
                    destroyDisplayMethod.invoke(null, virtualDisplayToken);
                } catch (Throwable ignored) {
                }
            }
            virtualDisplayToken = null;
            destroyDisplayMethod = null;
        }
    }

    private static Method findBitmapWrapHardwareBufferMethod() {
        for (Method m : Bitmap.class.getMethods()) {
            if (!m.getName().equals("wrapHardwareBuffer")) {
                continue;
            }
            Class<?>[] params = m.getParameterTypes();
            if (params.length == 2) {
                return m;
            }
        }
        return null;
    }

    private static byte[] runCommand(String[] cmd) throws IOException {
        Process process = null;
        try {
            List<String> args = new ArrayList<>();
            for (String s : cmd) {
                args.add(s);
            }
            process = new ProcessBuilder(args).redirectErrorStream(true).start();
            byte[] output = readAll(process.getInputStream());
            int code = process.waitFor();
            if (code != 0) {
                throw new IOException("command failed (" + code + "): " + String.join(" ", cmd));
            }
            return output;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("command interrupted: " + String.join(" ", cmd), e);
        } finally {
            if (process != null) {
                safeClose(process.getInputStream());
                safeClose(process.getOutputStream());
                safeClose(process.getErrorStream());
                process.destroy();
            }
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        while (true) {
            int n = in.read(buf);
            if (n < 0) {
                return out.toByteArray();
            }
            out.write(buf, 0, n);
        }
    }

    private static int[] readDisplaySizeOrFallback(int fallbackWidth, int fallbackHeight) {
        int width = Math.max(1, fallbackWidth);
        int height = Math.max(1, fallbackHeight);
        try {
            byte[] output = runCommand(new String[]{"wm", "size"});
            String raw = new String(output, StandardCharsets.UTF_8);
            Matcher matcher = DISPLAY_SIZE_PATTERN.matcher(raw);
            if (matcher.find()) {
                int parsedW = Integer.parseInt(matcher.group(1));
                int parsedH = Integer.parseInt(matcher.group(2));
                if (parsedW > 0 && parsedH > 0) {
                    return new int[]{parsedW, parsedH};
                }
            }
        } catch (Throwable ignored) {
        }
        return new int[]{width, height};
    }

    private static int clamp(int value, int min, int max) {
        if (value < min) {
            return min;
        }
        if (value > max) {
            return max;
        }
        return value;
    }

    private static void safeClose(AutoCloseable c) {
        if (c == null) {
            return;
        }
        try {
            c.close();
        } catch (Exception ignored) {
        }
    }

    private static void sleepQuiet(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private static String hexPrefix(ByteBuffer src, int maxBytes) {
        if (src == null || maxBytes <= 0) {
            return "";
        }
        ByteBuffer dup = src.duplicate();
        int n = Math.min(maxBytes, dup.remaining());
        if (n <= 0) {
            return "";
        }
        byte[] out = new byte[n];
        dup.get(out);
        StringBuilder sb = new StringBuilder(n * 2);
        for (byte b : out) {
            sb.append(String.format(Locale.US, "%02x", b));
        }
        return sb.toString();
    }

    private static void log(String msg) {
        System.err.println("[DeviceServer] " + msg);
    }

    private static void logError(String msg, Throwable t) {
        System.err.println("[DeviceServer] " + msg + ": " + t);
    }

    private static final class Frame {
        final byte[] jpeg;
        final int width;
        final int height;
        final int screenWidth;
        final int screenHeight;

        Frame(byte[] jpeg, int width, int height, int screenWidth, int screenHeight) {
            this.jpeg = jpeg;
            this.width = width;
            this.height = height;
            this.screenWidth = screenWidth;
            this.screenHeight = screenHeight;
        }
    }

    private static final class TouchTracker {
        final Set<Integer> activeIds = new HashSet<>();
        final Map<Integer, TouchState> activeTouches = new HashMap<>();
    }

    private static final class TouchState {
        final int startX;
        final int startY;
        final long startTimeMs;
        int lastX;
        int lastY;
        long lastTimeMs;

        TouchState(int startX, int startY, long startTimeMs) {
            this.startX = startX;
            this.startY = startY;
            this.startTimeMs = startTimeMs;
            this.lastX = startX;
            this.lastY = startY;
            this.lastTimeMs = startTimeMs;
        }
    }
}
