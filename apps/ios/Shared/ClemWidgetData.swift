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
