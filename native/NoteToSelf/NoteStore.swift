import Foundation
import SwiftUI

@MainActor
final class NoteStore: ObservableObject {
    @Published private(set) var local = LocalNotes()
    @Published var messages: [HistoryMessage] = []
    @Published var notice: String?
    @Published var busy = false
    @Published var storageReady = false
    @Published private(set) var discardConfirmationPresented = false
    let identity: IdentityModel
    let networkSession: URLSession?
    let file: URL?
    var draft: NoteDraft { local.draft }
    var connection: Connection? { local.connection }
    var canDiscardNote: Bool { draft.frozen || !draft.text.isEmpty || !draft.images.isEmpty || draft.thread != nil }
    var api: NStackAPI { NStackAPI(session:networkSession) { [identity] in try identity.sign(kind:$0,tags:$1,content:$2) } }
    init(identity: IdentityModel, stateFile: URL? = nil, session: URLSession? = nil) {
        self.identity = identity; networkSession = session
        file = stateFile ?? (try? FileManager.default.url(for:.applicationSupportDirectory,in:.userDomainMask,appropriateFor:nil,create:true).appendingPathComponent("NoteToSelf/state.json"))
        do {
            guard let file else { throw NoteError.storage }
            if FileManager.default.fileExists(atPath:file.path) { local = try JSONDecoder().decode(LocalNotes.self,from:Data(contentsOf:file)) }
            storageReady = true
        } catch { notice = "Saved notes could not be read. They have been retained; sending is disabled." }
    }
    func persist() throws {
        guard storageReady, let file else { throw NoteError.storage }
        try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
        try JSONEncoder().encode(local).write(to:file,options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication])
        var dir = file.deletingLastPathComponent(); var values = URLResourceValues(); values.isExcludedFromBackup = true; try dir.setResourceValues(values)
    }
    func edit(_ value: String) { guard !busy, !draft.frozen else { return }; local.draft.text = value; do { try persist() } catch { notice = error.localizedDescription } }
    func addImage(_ data: Data) async {
        guard !busy, !draft.frozen, storageReady else { return }
        busy = true
        defer { busy = false }
        do {
            let sanitized = try await Task.detached(priority:.userInitiated) { try NotePrivacy.image(data) }.value
            local.draft.images.append(NoteImage(bytes:sanitized)); try persist(); notice = nil
        } catch { notice = error.localizedDescription }
    }
    func removeImage(_ id: UUID) { guard !busy, !draft.frozen else { return }; local.draft.images.removeAll { $0.id == id }; do { try persist() } catch { notice = error.localizedDescription } }
    func reply(_ message: HistoryMessage) {
        guard !busy, !draft.frozen, draft.text.isEmpty, draft.images.isEmpty else { notice = "Send the current draft before replying."; return }
        guard let thread = message.thread else { notice = "Open this message in Flight Deck to start its thread, then refresh History."; return }
        local.draft.thread = thread; local.draft.parent = message.id
        do { try persist() } catch { notice = error.localizedDescription }
    }
    func cancelReply() { guard !busy, !draft.frozen else { return }; local.draft.thread = nil; local.draft.parent = nil; do { try persist() } catch { notice = error.localizedDescription } }
    func requestDiscard() { if canDiscardNote { discardConfirmationPresented = true } }
    func cancelDiscard() { discardConfirmationPresented = false }
    func confirmDiscard() {
        guard discardConfirmationPresented, canDiscardNote else { discardConfirmationPresented = false; return }
        let previous = local.draft; let wasBusy = busy
        local.draft = NoteDraft(); busy = false; discardConfirmationPresented = false
        do { try persist(); notice = "Draft discarded from this iPhone." }
        catch { local.draft = previous; busy = wasBusy; notice = error.localizedDescription }
    }
    func assertIdentity(_ destination: Connection) throws {
        guard identity.unlocked, identity.npub == destination.signer else { throw NoteError.identity }
    }
    func discover(origin: String) async throws -> [[String:Any]] {
        guard identity.unlocked else { throw NoteError.setup }
        _ = try NStackAPI.origin(origin)
        return try await api.list(origin:origin,path:"/api/v4/flightdeck-pg/workspaces",key:"workspaces")
    }
    func connect(origin: String, workspace: [String:Any]) async {
        guard !busy, !draft.frozen else { return }; busy = true; defer { busy = false }
        do {
            guard let signer = identity.npub, let descriptor = workspace["identity"] as? [String:Any], let id = descriptor["workspace_id"] as? String, UUID(uuidString:id) != nil,
                  let app = descriptor["app_npub"] as? String, NostrCodec.validNpub(app) else { throw NoteError.setup }
            let base = "/api/v4/flightdeck-pg/workspaces/" + id
            let scopes = try await api.list(origin:origin,path:base + "/scopes",app:app,key:"scopes")
            guard let scope = scopes.first(where: { $0["kind"] as? String == "dm" }), let scopeID = scope["id"] as? String else { throw NoteError.setup }
            let response = try await api.request(origin:origin,path:base + "/scopes/" + scopeID + "/channels",app:app,method:"POST",body:["name":"Note to self","kind":"dm","participant_npubs":[signer]])
            guard identity.npub == signer, let channel = response["channel"] as? [String:Any], let channelID = channel["id"] as? String,
                  UUID(uuidString:channelID) != nil, channel["participant_npubs"] as? [String] == [signer] else { throw NoteError.malformed }
            local.connection = Connection(origin:try NStackAPI.origin(origin).absoluteString,workspace:id,app:app,signer:signer,channel:channelID,label:workspace["label"] as? String ?? "Workspace")
            try persist(); messages = []; notice = "Connected to your private Note to self."
        } catch { notice = error.localizedDescription }
    }
    func history() async {
        guard !busy, let destination = connection else { return }
        do {
            try assertIdentity(destination)
            let rows = try await api.list(origin:destination.origin,path:destination.base + "/channels/" + destination.channel + "/messages",app:destination.app,key:"messages")
            try assertIdentity(destination)
            guard connection == destination else { return }
            messages = rows.compactMap(HistoryMessage.init)
        } catch { notice = error.localizedDescription }
    }
    func send() async {
        guard !busy, storageReady, !draft.text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || !draft.images.isEmpty else { return }
        let sendingID = draft.id
        busy = true; defer { busy = false }
        do {
            guard let destination = draft.destination ?? connection else { throw NoteError.setup }
            try assertIdentity(destination)
            if !draft.frozen { local.draft.text = NotePrivacy.clean(draft.text).trimmingCharacters(in:.whitespacesAndNewlines); local.draft.destination = destination; local.draft.frozen = true; try persist() }
            for i in local.draft.images.indices {
                var replaced = false
                while true {
                    try assertIdentity(destination)
                    if local.draft.images[i].object == nil {
                        guard !local.draft.images[i].preparing else { throw NoteError.uncertainPrepare }
                        local.draft.images[i].preparing = true; try persist()
                        let image = local.draft.images[i]
                        let response = try await api.request(origin:destination.origin,path:destination.base + "/storage/prepare",app:destination.app,method:"POST",body:["file_name":image.filename,"content_type":"image/png","size_bytes":image.bytes.count,"sha256_hex":NostrCodec.hash(image.bytes),"is_public":false])
                        guard local.draft.id == sendingID else { return }
                        guard let object = response["object_id"] as? String, UUID(uuidString:object) != nil, response["is_public"] as? Bool == false, let upload = response["upload_url"] as? String else { throw NoteError.malformed }
                        local.draft.images[i].object = object; local.draft.images[i].upload = upload; local.draft.images[i].preparing = false; try persist()
                    }
                    let image = local.draft.images[i]; let object = image.object!
                    let metadata: [String:Any]
                    do {
                        metadata = try await api.request(origin:destination.origin,path:"/api/v4/storage/" + object)
                        guard local.draft.id == sendingID else { return }
                    }
                    catch NStackError.response(404, _, _) where !replaced {
                        guard local.draft.id == sendingID else { return }
                        // This exact authenticated metadata read is built here, so any 404 means the object is gone or
                        // no longer readable, whatever the body shape, and it can never be attached. Keep the sanitized
                        // bytes and message ID and prepare one fresh object. Tower's message idempotency hash covers
                        // attachment IDs, so a fresh object cannot duplicate an accepted message.
                        try assertIdentity(destination)
                        local.draft.images[i].object = nil; local.draft.images[i].upload = nil; local.draft.images[i].complete = false; try persist()
                        replaced = true; continue
                    }
                    if !(metadata["completed_at"] is String) {
                        let temp = FileManager.default.temporaryDirectory.appendingPathComponent(image.filename)
                        try image.bytes.write(to:temp,options:[.atomic,.completeFileProtectionUntilFirstUserAuthentication]); defer { try? FileManager.default.removeItem(at:temp) }
                        try assertIdentity(destination)
                        try await api.putFile(temp,upload:image.upload!,origin:destination.origin,object:object,mime:"image/png",size:image.bytes.count)
                        guard local.draft.id == sendingID else { return }
                        _ = try await api.request(origin:destination.origin,path:"/api/v4/storage/" + object + "/complete",method:"POST",body:["sha256_hex":NostrCodec.hash(image.bytes),"size_bytes":image.bytes.count])
                        guard local.draft.id == sendingID else { return }
                    }
                    let completed = try await api.request(origin:destination.origin,path:"/api/v4/storage/" + object)
                    guard local.draft.id == sendingID else { return }
                    // Tower's PostgreSQL BIGINT metadata is a decimal JSON string;
                    // retain compatibility with backends that emit a JSON number.
                    let sizeMatches = (completed["size_bytes"] as? String) == String(image.bytes.count)
                        || (completed["size_bytes"] as? NSNumber) == NSNumber(value: image.bytes.count)
                    guard completed["sha256_hex"] as? String == NostrCodec.hash(image.bytes), sizeMatches, completed["is_public"] as? Bool == false, completed["completed_at"] is String else { throw NoteError.malformed }
                    local.draft.images[i].complete = true; try persist()
                    break
                }
            }
            try assertIdentity(destination)
            let text = draft.text; let hash = NostrCodec.hash(Data(text.utf8))
            var rerooted = false
            while true {
                let thread = draft.thread
                var tags = [["protocol","flightdeck_pg_message_instruction"],["body_sha256",hash],["workspace_id",destination.workspace],["channel_id",destination.channel]]
                if let thread { tags.append(["thread_id",thread]) }
                let signature = try identity.sign(kind:33358,tags:tags,content:text)
                let encoded = try JSONSerialization.jsonObject(with:JSONEncoder().encode(signature))
                var body: [String:Any] = ["body":text,"client_request_id":draft.id.uuidString,"create_thread":thread == nil,
                    "message_signature":["version":1,"signer_npub":destination.signer,"body_sha256":hash,"nostr_event":encoded],
                    "metadata":["attachments":draft.images.map { ["kind":"image","storage_object_id":$0.object!,"filename":$0.filename,"mime_type":"image/png","size_bytes":$0.bytes.count] as [String:Any] }]]
                if let thread { body["thread_id"] = thread }
                let response: [String:Any]
                do {
                    response = try await api.request(origin:destination.origin,path:destination.base + "/channels/" + destination.channel + "/messages",app:destination.app,method:"POST",body:body)
                    guard local.draft.id == sendingID else { return }
                }
                catch NStackError.response(409, let code?, _) where code == "idempotency_conflict" {
                    guard local.draft.id == sendingID else { return }
                    // Tower already accepted a different message under this request ID, such as an earlier delivery
                    // whose image or thread was later removed. Never resend under this ID; keep the content as a new draft.
                    let previous = local.draft
                    local.draft.id = UUID(); local.draft.frozen = false; local.draft.destination = nil
                    do { try persist() } catch { local.draft = previous; throw error }
                    notice = "Tower already has a note sent with this draft’s ID (idempotency_conflict), so it was not sent again. Your text and images are kept as an editable draft; send only if you want another copy."
                    return
                }
                catch NStackError.response(404, let code?, _) where code == "thread_not_found" && thread != nil && !rerooted {
                    guard local.draft.id == sendingID else { return }
                    // Tower checks the reply thread before recording a message or its idempotency key, so this request was
                    // not accepted, and a deleted thread can never accept it. Persist dropping only the stale reply target,
                    // then retry once as a new root under the same request ID: an earlier acceptance answers
                    // idempotency_conflict instead of creating a duplicate.
                    try assertIdentity(destination)
                    let previous = local.draft
                    local.draft.thread = nil; local.draft.parent = nil
                    do { try persist() } catch { local.draft = previous; throw error }
                    rerooted = true; continue
                }
                catch NStackError.response(404, let code?, _) where code == "channel_not_found" {
                    guard local.draft.id == sendingID else { return }
                    // A missing channel cannot accept this note either. Unfreeze it, keeping content and request ID,
                    // so Settings can reconnect the workspace; the next explicit send stays idempotency-checked.
                    let previous = local.draft
                    local.draft.frozen = false; local.draft.destination = nil; local.draft.thread = nil; local.draft.parent = nil
                    do { try persist() } catch { local.draft = previous; throw error }
                    notice = "Your Note to self conversation was not found (channel_not_found), so nothing was sent. Your text and images are kept; reconnect your workspace in Settings, then tap Send."
                    return
                }
                guard let message = response["message"] as? [String:Any], message["client_request_id"] as? String == draft.id.uuidString, message["channel_id"] as? String == destination.channel, message["body"] as? String == text else { throw NoteError.malformed }
                let acceptedDraft = local.draft
                local.draft = NoteDraft()
                do { try persist() } catch { local.draft = acceptedDraft; throw error }
                notice = rerooted ? "Sent to your Flight Deck Note to self as a new note, because the thread it replied to no longer exists (thread_not_found)." : "Sent to your Flight Deck Note to self."
                return
            }
        } catch { if local.draft.id == sendingID { notice = error.localizedDescription } }
    }
}
extension NStackAPI {
    func list(origin: String,path: String,app: String? = nil,key: String) async throws -> [[String:Any]] {
        var rows: [[String:Any]] = []; var cursor: String?; var seen = Set<String>()
        repeat {
            var query = URLComponents(); query.queryItems = [URLQueryItem(name:"limit",value:"200")]
            if let cursor { query.queryItems!.append(URLQueryItem(name:"cursor",value:cursor)) }
            let response = try await request(origin:origin,path:path + "?" + query.percentEncodedQuery!,app:app)
            guard let page = response[key] as? [[String:Any]] else { throw NoteError.malformed }
            rows += page; cursor = response["next_cursor"] as? String
            if let cursor { guard !cursor.isEmpty, seen.insert(cursor).inserted else { throw NoteError.malformed } }
            else if response["has_more"] as? Bool == true || (key != "messages" && page.count >= 200) { throw NStackError.discoveryLimit }
        } while cursor != nil
        return rows
    }
    func image(origin: String,object: String) async throws -> Data {
        guard UUID(uuidString:object) != nil else { throw NoteError.malformed }
        let url = try Self.url(origin,"/api/v4/storage/" + object + "/content")
        let event = try sign(27235,Self.authTags(url:url,method:"GET",bytes:nil),"")
        var request = URLRequest(url:url); request.setValue("Nostr " + (try JSONEncoder().encode(event)).base64EncodedString(),forHTTPHeaderField:"Authorization")
        let (bytes,response) = try await session.data(for:request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw NoteError.malformed }
        return bytes
    }
}
