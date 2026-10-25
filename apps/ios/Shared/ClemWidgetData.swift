import Foundation

/// Only explicit, bounded Space presentation data crosses into the extension.
/// The widget has no session, network client, pairing token, or microphone.
struct ClemWidgetSpace: Codable, Equatable {
    let slug: String
    let name: String
    let summary: String
    let updatedAt: Date
    let savedAt: Date

    static func validSlug(_ slug: String) -> Bool {
        slug.range(of: "^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$", options: .regularExpression) != nil
    }

    static func parse(_ body: [String: Any], now: Date = Date()) -> ClemWidgetSpace? {
        guard Set(body.keys) == Set(["requestId", "slug", "name", "summary", "updatedAt"]),
              let requestID = body["requestId"] as? String, UUID(uuidString: requestID) != nil,
              let slug = body["slug"] as? String, validSlug(slug),
              let name = body["name"] as? String, validText(name, maximumBytes: 160), !name.isEmpty,
              let summary = body["summary"] as? String, validText(summary, maximumBytes: 600),
              let rawDate = body["updatedAt"] as? String, rawDate.utf8.count <= 40,
              let updatedAt = parseDate(rawDate), updatedAt <= now.addingTimeInterval(300) else { return nil }
        return ClemWidgetSpace(slug: slug, name: name, summary: summary, updatedAt: updatedAt, savedAt: now)
    }

    private static func validText(_ value: String, maximumBytes: Int) -> Bool {
        value == value.trimmingCharacters(in: .whitespacesAndNewlines)
            && value.utf8.count <= maximumBytes
            && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }

    private static func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    var url: URL {
        var components = URLComponents()
        components.scheme = "clem"
        components.host = "space"
        components.queryItems = [URLQueryItem(name: "id", value: slug)]
        return components.url!
    }
}

final class ClemWidgetSpaceStore {
    static let appGroup = "group.ai.breakthroughcoaching.clem"
    static let shared = ClemWidgetSpaceStore(defaults: UserDefaults(suiteName: appGroup))
    private let defaults: UserDefaults?
    private let key = "clem.widget.selected-space.v1"

    init(defaults: UserDefaults?) { self.defaults = defaults }

    func load() -> ClemWidgetSpace? {
        guard let data = defaults?.data(forKey: key), data.count <= 2_048,
              let space = try? JSONDecoder().decode(ClemWidgetSpace.self, from: data),
              ClemWidgetSpace.validSlug(space.slug) else { return nil }
        return space
    }

    @discardableResult
    func save(_ space: ClemWidgetSpace) -> Bool {
        guard let defaults, let data = try? JSONEncoder().encode(space), data.count <= 2_048 else { return false }
        defaults.set(data, forKey: key)
        return defaults.data(forKey: key) == data
    }

    func clear() { defaults?.removeObject(forKey: key) }
}

/// A pin contains presentation data only. Inputs and execution authority stay
/// in the foreground app and its normal workflow runner.
struct ClemWidgetWorkflow: Codable, Equatable {
    let slug: String
    let name: String
    let summary: String
    let updatedAt: Date
    let savedAt: Date

    static func validSlug(_ slug: String) -> Bool {
        slug.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$", options: .regularExpression) != nil
    }

    static func parse(_ body: [String: Any], now: Date = Date()) -> ClemWidgetWorkflow? {
        guard Set(body.keys) == Set(["requestId", "slug", "name", "summary", "updatedAt"]),
              let requestID = body["requestId"] as? String, UUID(uuidString: requestID) != nil,
              let slug = body["slug"] as? String, let name = body["name"] as? String,
              let summary = body["summary"] as? String,
              let rawDate = body["updatedAt"] as? String, rawDate.utf8.count <= 40 else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: rawDate) ?? ISO8601DateFormatter().date(from: rawDate) else { return nil }
        let value = ClemWidgetWorkflow(slug: slug, name: name, summary: summary, updatedAt: date, savedAt: now)
        return value.isValid(now: now) ? value : nil
    }

    func isValid(now: Date = Date()) -> Bool {
        Self.validSlug(slug) && !name.isEmpty && Self.validText(name, maximumBytes: 160)
            && Self.validText(summary, maximumBytes: 600)
            && updatedAt.timeIntervalSince1970.isFinite && savedAt.timeIntervalSince1970.isFinite
            && updatedAt <= now.addingTimeInterval(300) && savedAt <= now.addingTimeInterval(300)
    }

    private static func validText(_ value: String, maximumBytes: Int) -> Bool {
        value == value.trimmingCharacters(in: .whitespacesAndNewlines)
            && value.utf8.count <= maximumBytes
            && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    }

    var url: URL {
        var components = URLComponents()
        components.scheme = "clem"
        components.host = "workflow"
        components.queryItems = [URLQueryItem(name: "id", value: slug)]
        return components.url!
    }
}

final class ClemWidgetWorkflowStore {
    static let shared = ClemWidgetWorkflowStore(defaults: UserDefaults(suiteName: ClemWidgetSpaceStore.appGroup))
    private let defaults: UserDefaults?
    private let key = "clem.widget.workflows.v1"
    private let lock = NSRecursiveLock()

    init(defaults: UserDefaults?) { self.defaults = defaults }

    func load() -> [ClemWidgetWorkflow] {
        lock.lock(); defer { lock.unlock() }
        guard let data = defaults?.data(forKey: key), data.count <= 6_144,
              let pins = try? JSONDecoder().decode([ClemWidgetWorkflow].self, from: data),
              pins.count <= 3, Set(pins.map(\.slug)).count == pins.count,
              pins.allSatisfy({ $0.isValid() }) else { return [] }
        return pins
    }

    @discardableResult
    func save(_ workflow: ClemWidgetWorkflow) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard workflow.isValid() else { return false }
        var pins = load()
        if let index = pins.firstIndex(where: { $0.slug == workflow.slug }) {
            pins[index] = workflow
        } else {
            guard pins.count < 3 else { return false }
            pins.append(workflow)
        }
        return persist(pins)
    }

    @discardableResult
    func remove(slug: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard ClemWidgetWorkflow.validSlug(slug) else { return false }
        return persist(load().filter { $0.slug != slug })
    }

    func clear() {
        lock.lock(); defer { lock.unlock() }
        defaults?.removeObject(forKey: key)
    }

    private func persist(_ pins: [ClemWidgetWorkflow]) -> Bool {
        guard let defaults, let data = try? JSONEncoder().encode(pins), data.count <= 6_144 else { return false }
        defaults.set(data, forKey: key)
        return defaults.data(forKey: key) == data
    }
}
