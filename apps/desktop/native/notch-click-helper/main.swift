import AppKit
import Foundation

private let protocolVersion = 1

private final class ClickPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class ClickCatcherView: NSView {
    var onActivate: (() -> Void)?
    var onHover: ((Bool) -> Void)?
    private var activeTrackingArea: NSTrackingArea?

    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {}
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        bounds.contains(point) ? self : nil
    }

    override func mouseDown(with event: NSEvent) {
        onActivate?()
    }

    override func updateTrackingAreas() {
        if let activeTrackingArea { removeTrackingArea(activeTrackingArea) }
        let tracking = NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(tracking)
        activeTrackingArea = tracking
        super.updateTrackingAreas()
    }

    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent) { onHover?(false) }
}

private final class NotchClickController {
    private let panel: ClickPanel
    private let catcher: ClickCatcherView
    private let outputLock = NSLock()
    private var localMonitor: Any?
    private var globalMonitor: Any?
    private var enabled = false
    private var sequence = 0
    private var lastActivationUptime: TimeInterval = -1
    private var hovering = false

    init() {
        panel = ClickPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        catcher = ClickCatcherView(frame: .zero)

        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isMovable = false
        panel.ignoresMouseEvents = false
        // Stay one level above Clementine's visual BrowserWindow. The helper is
        // transparent, but it must remain the authoritative top-edge hit target
        // even after Electron calls moveTop() on the visual surface.
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 4)
        panel.collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .stationary,
            .ignoresCycle,
        ]
        panel.contentView = catcher
        catcher.onActivate = { [weak self] in self?.activate(source: "view") }
        catcher.onHover = { [weak self] active in self?.setHover(active) }

        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            guard let self else { return event }
            if self.containsCurrentMouseLocation() { self.activate(source: "local") }
            return event
        }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { [weak self] _ in
            guard let self else { return }
            if self.containsCurrentMouseLocation() { self.activate(source: "global") }
        }
    }

    deinit {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
    }

    func emitReady() {
        emit(["type": "ready", "protocol": protocolVersion])
    }

    func configure(_ object: [String: Any]) {
        guard
            object.count == 5,
            object["type"] as? String == "configure",
            let nextEnabled = object["enabled"] as? Bool,
            let state = object["state"] as? String,
            state == "dormant" || state == "panel",
            let displayIdNumber = object["displayId"] as? NSNumber,
            displayIdNumber.uint64Value <= UInt64(UInt32.max),
            let frame = object["frame"] as? [String: Any],
            frame.count == 4,
            let x = number(frame["x"]),
            let y = number(frame["y"]),
            let width = number(frame["width"]),
            let height = number(frame["height"]),
            width > 0,
            height > 0
        else {
            emit(["type": "error", "code": "invalid-configure"])
            return
        }

        let displayId = displayIdNumber.uint32Value
        guard let screen = NSScreen.screens.first(where: { candidate in
            let key = NSDeviceDescriptionKey("NSScreenNumber")
            return (candidate.deviceDescription[key] as? NSNumber)?.uint32Value == displayId
        }) else {
            enabled = false
            setHover(false)
            panel.orderOut(nil)
            emit(["type": "error", "code": "display-not-found"])
            return
        }

        guard
            width <= 160,
            height <= 160,
            x >= 0,
            y >= 0,
            x + width <= screen.frame.width + 1,
            y + height <= screen.frame.height + 1
        else {
            enabled = false
            setHover(false)
            panel.orderOut(nil)
            emit(["type": "error", "code": "invalid-dormant-frame"])
            return
        }

        // Safe-area discovery is independent of whether the click catcher is
        // armed. Expanded panels and display changes still need fresh AppKit
        // notch metrics, especially when the menu bar auto-hides.
        var localAnchorX = x
        var safeTopInset: CGFloat = 0
        if #available(macOS 12.0, *) {
            safeTopInset = screen.safeAreaInsets.top
            if safeTopInset > 0, let auxiliaryLeft = screen.auxiliaryTopLeftArea {
                // Keep a two-point overlap with the camera exclusion boundary so
                // the transparent hit frame hugs the physical notch without
                // relying on a model-specific hard-coded notch width.
                let discoveredAnchorX = auxiliaryLeft.maxX - screen.frame.minX - width + 2
                if discoveredAnchorX.isFinite && discoveredAnchorX >= 0 {
                    localAnchorX = discoveredAnchorX
                }
            }
        }
        emit([
            "type": "anchor",
            "protocol": protocolVersion,
            "displayId": displayId,
            "x": localAnchorX,
            "y": 0,
            "topInset": safeTopInset,
        ])

        enabled = nextEnabled && state == "dormant"
        guard enabled else {
            setHover(false)
            panel.orderOut(nil)
            return
        }

        // Electron sends display-local top-left coordinates in logical points.
        // Resolve the owning NSScreen by CGDirectDisplayID, then reflect only the
        // local Y coordinate into AppKit's bottom-left coordinate system.
        let appKitFrame = NSRect(
            x: screen.frame.minX + x,
            y: screen.frame.maxY - y - height,
            width: width,
            height: height
        )
        guard appKitFrame.intersects(screen.frame) else {
            enabled = false
            setHover(false)
            panel.orderOut(nil)
            emit(["type": "error", "code": "frame-outside-display"])
            return
        }
        panel.setFrame(appKitFrame, display: true)
        catcher.frame = NSRect(origin: .zero, size: appKitFrame.size)
        panel.orderFrontRegardless()
    }

    func shutdown() {
        enabled = false
        setHover(false)
        panel.orderOut(nil)
        NSApp.terminate(nil)
    }

    private func containsCurrentMouseLocation() -> Bool {
        enabled && panel.isVisible && panel.frame.contains(NSEvent.mouseLocation)
    }

    private func activate(source: String) {
        let now = ProcessInfo.processInfo.systemUptime
        guard lastActivationUptime < 0 || now - lastActivationUptime >= 0.15 else { return }
        lastActivationUptime = now
        // Latch immediately. The main process will re-arm us only if the
        // renderer fails to leave dormant state; this prevents a rapid second
        // top-edge event from racing the expansion animation.
        enabled = false
        setHover(false)
        panel.orderOut(nil)
        sequence += 1
        emit([
            "type": "activate",
            "protocol": protocolVersion,
            "seq": sequence,
            "source": source,
        ])
    }

    private func setHover(_ active: Bool) {
        let next = enabled && active
        guard hovering != next else { return }
        hovering = next
        emit([
            "type": "hover",
            "protocol": protocolVersion,
            "active": next,
        ])
    }

    private func emit(_ object: [String: Any]) {
        guard
            JSONSerialization.isValidJSONObject(object),
            let data = try? JSONSerialization.data(withJSONObject: object, options: [])
        else { return }
        outputLock.lock()
        defer { outputLock.unlock() }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }

    private func number(_ value: Any?) -> CGFloat? {
        guard let value = value as? NSNumber else { return nil }
        let result = CGFloat(value.doubleValue)
        return result.isFinite ? result : nil
    }
}

if CommandLine.arguments.dropFirst() == ["--probe"] {
    let payload = try JSONSerialization.data(withJSONObject: [
        "type": "probe",
        "protocol": protocolVersion,
    ])
    FileHandle.standardOutput.write(payload)
    FileHandle.standardOutput.write(Data([0x0A]))
    exit(0)
}

private let application = NSApplication.shared
application.setActivationPolicy(.accessory)
private let controller = NotchClickController()

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        guard line.utf8.count <= 4096, let data = line.data(using: .utf8) else { continue }
        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let message = object as? [String: Any],
            let type = message["type"] as? String
        else { continue }

        DispatchQueue.main.async {
            switch type {
            case "configure": controller.configure(message)
            case "shutdown": controller.shutdown()
            default: break
            }
        }
    }
    DispatchQueue.main.async { controller.shutdown() }
}

controller.emitReady()
application.run()
