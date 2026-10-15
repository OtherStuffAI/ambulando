import Foundation

enum NoteError: LocalizedError {
    case image, storage, setup, identity, uncertainPrepare, malformed
    var errorDescription: String? {
        switch self {
        case .image: "Choose a readable still image. No original image was uploaded."
        case .storage: "Local storage could not be saved. Sending is paused to preserve your draft."
        case .setup: "Connect an unlocked identity to an authorized nStack workspace."
        case .identity: "Unlock the identity used for this draft before sending."
        case .uncertainPrepare: "Image preparation had an uncertain response. Draft retained; inspect remote storage before starting another upload."
        case .malformed: "nStack returned an unexpected record. Draft retained."
        }
    }
}
struct Connection: Codable, Equatable {
    var origin: String; var workspace: String; var app: String; var signer: String; var channel: String; var label: String
    var base: String { "/api/v4/flightdeck-pg/workspaces/" + workspace }
}
struct NoteImage: Codable, Identifiable {
    var id = UUID(); var bytes: Data; var object: String?; var upload: String?; var preparing = false; var complete = false
    var filename: String { id.uuidString + ".png" }
}
struct NoteDraft: Codable {
    var id = UUID(); var text = ""; var images: [NoteImage] = []; var thread: String?; var parent: String?
    var destination: Connection?; var frozen = false
}
struct LocalNotes: Codable {
    var connection: Connection?; var draft = NoteDraft()
}
struct HistoryMessage: Identifiable {
    var id: String; var body: String; var created: String; var thread: String?; var parent: String?; var images: [String]
    init?(_ row: [String:Any]) {
        guard let id = row["id"] as? String, let body = row["body"] as? String else { return nil }
        self.id = id; self.body = body; created = row["created_at"] as? String ?? ""; thread = row["thread_id"] as? String; parent = row["parent_message_id"] as? String
        if parent == nil, let source = row["thread_source_message_id"] as? String, source != id { parent = source }
        let metadata = row["metadata"] as? [String:Any] ?? [:]
        let attachments = row["attachments"] as? [[String:Any]] ?? metadata["attachments"] as? [[String:Any]] ?? []
        images = attachments.filter { ($0["kind"] as? String) == "image" || (($0["mime_type"] ?? $0["content_type"]) as? String ?? "").hasPrefix("image/") }.compactMap { $0["storage_object_id"] as? String }
    }
}
