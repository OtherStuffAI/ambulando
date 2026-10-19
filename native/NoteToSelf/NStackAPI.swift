// Adapted from Wingman In Dialogue Recorder native transport (2026).
import Foundation

enum NStackError: LocalizedError {
    case discoveryLimit, invalidSetup, unsafeURL, response(Int, String? = nil, String? = nil), malformed, fallbackLimit
    var errorDescription: String? {
        switch self {
        case .discoveryLimit: "nStack discovery reached a server list limit without a continuation cursor. Ask the administrator to enable complete discovery."
        case .invalidSetup: "Choose an HTTPS nStack and unlock your identity."
        case .unsafeURL: "nStack refused an unsafe URL or redirect. Use your selected HTTPS origin."
        // Name the request stage and Tower's code or error text, so a screenshot identifies which rule failed.
        case .response(let code, let detail, let stage):
            "nStack returned HTTP \(code)" + (stage.map { " during " + $0 } ?? "") + " (" + (detail.map(NStackAPI.summary) ?? "no Tower error body") + "). Check access and connection; your draft is retained."
        case .malformed: "nStack returned an unexpected response. Your draft is retained."
        case .fallbackLimit: "This backend uses JSON file upload, limited to 8 MiB. Your draft is retained."
        }
    }
}
final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
@MainActor
final class NStackAPI {
    typealias Sign = (Int, [[String]], String) throws -> NostrEvent
    let sign: Sign
    let session: URLSession
    init(session: URLSession? = nil, sign: @escaping Sign) {
        self.sign = sign
        let config = URLSessionConfiguration.ephemeral; config.timeoutIntervalForRequest = 45
        self.session = session ?? URLSession(configuration: config, delegate: RefuseRedirects(), delegateQueue: nil)
    }
    /// One display line of server error text: control characters removed, at most 80 characters.
    nonisolated static func summary(_ detail: String) -> String {
        let line = detail.components(separatedBy:.controlCharacters).joined(separator:" ").split(separator:" ").joined(separator:" ")
        return line.count > 80 ? String(line.prefix(80)) + "…" : line
    }
    /// Coarse request stage for error notices; identifiers are omitted.
    nonisolated static func stage(method: String, path: String) -> String? {
        let path = path.split(separator:"?",maxSplits:1).first.map(String.init) ?? path
        if path.hasSuffix("/messages") { return method == "POST" ? "message send" : "history" }
        if path.hasSuffix("/storage/prepare") { return "image prepare" }
        if path.hasPrefix("/api/v4/storage/") { return path.hasSuffix("/complete") ? "image complete" : method == "PUT" ? "image upload" : "image check" }
        if path.hasSuffix("/workspaces") { return "workspace discovery" }
        if path.hasSuffix("/scopes") || path.hasSuffix("/channels") { return "workspace connect" }
        return nil
    }
    nonisolated static func origin(_ value: String) throws -> URL {
        guard let u = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)), u.scheme == "https", u.host != nil,
              u.user == nil, u.password == nil, u.query == nil, u.fragment == nil, u.path.isEmpty || u.path == "/" else { throw NStackError.unsafeURL }
        return u
    }
    nonisolated static func url(_ origin: String, _ path: String) throws -> URL {
        guard path.hasPrefix("/api/v4/"), let u = URL(string: path, relativeTo: try self.origin(origin))?.absoluteURL else { throw NStackError.unsafeURL }; return u
    }
    nonisolated static func authTags(url: URL, method: String, bytes: Data?) -> [[String]] {
        var tags = [["u", url.absoluteString], ["method", method]]
        if let bytes { tags.append(["payload", NostrCodec.hash(bytes)]) }; return tags
    }
    func request(origin: String, path: String, app: String? = nil, method: String = "GET", body: [String: Any]? = nil) async throws -> [String: Any] {
        try Task.checkCancellation()
        let url = try Self.url(origin, path)
        let bytes = try body.map { try NostrCodec.json($0) }
        let event = try sign(27235, Self.authTags(url: url, method: method, bytes: bytes), "")
        var request = URLRequest(url: url); request.httpMethod = method; request.httpBody = bytes
        request.setValue("Nostr " + (try JSONEncoder().encode(event)).base64EncodedString(), forHTTPHeaderField: "Authorization")
        if let app { request.setValue(app, forHTTPHeaderField: "x-flightdeck-pg-app-npub") }
        if bytes != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw NStackError.malformed }
        guard (200..<300).contains(http.statusCode) else {
            // Typed PG errors carry a stable `code`; generic storage errors carry only `error` text.
            let failure = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw NStackError.response(http.statusCode, failure?["code"] as? String ?? failure?["error"] as? String, Self.stage(method: method, path: path))
        }
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NStackError.malformed }
        return result
    }
    func putFile(_ file: URL, upload: String, origin: String, object: String, mime: String, size: Int) async throws {
        guard let url = URL(string: upload), url.user == nil, url.password == nil, url.fragment == nil else { throw NStackError.unsafeURL }
        let local = try Self.url(origin, "/api/v4/storage/\(object)")
        // API fallback can advertise HTTP behind a proxy: use only the pinned origin and exact object path.
        if url.path == local.path && url.host == local.host && url.query == nil && ["https","http"].contains(url.scheme ?? "") {
            guard size <= 8 * 1024 * 1024 else { throw NStackError.fallbackLimit }
            _ = try await request(origin: origin, path: local.path, method: "PUT", body: ["base64_data": try Data(contentsOf: file).base64EncodedString()]); return
        }
        guard url.scheme == "https", !url.path.hasPrefix("/api/v4/") else { throw NStackError.unsafeURL }
        var request = URLRequest(url: url); request.httpMethod = "PUT"; request.setValue(mime, forHTTPHeaderField: "Content-Type")
        let (_, response) = try await session.upload(for: request, fromFile: file)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw NStackError.response((response as? HTTPURLResponse)?.statusCode ?? 0, nil, "image upload") }
    }
}
