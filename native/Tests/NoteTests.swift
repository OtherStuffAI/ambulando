import XCTest
import ImageIO
import UniformTypeIdentifiers
import CryptoKit
@testable import NoteCore

final class NoteTests: XCTestCase {
    func testMixedTextAndFunctionalParameters() {
        XCTAssertEqual(NotePrivacy.clean("Watch (https://youtu.be/dQw4w9WgXcQ?si=abc&t=42&list=PL123&index=2). Also https://example.com/x?utm_source=mail&q=a%20b&ref=keep#part!"),"Watch (https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42&list=PL123&index=2). Also https://example.com/x?q=a%20b&ref=keep#part!")
        for signature in ["sig=abc","X-Amz-Signature=abc","token=abc","X-Goog-Credential=abc"] {
            let raw = "https://example.com/a?utm_source=x&" + signature + "&q=a%20b"
            XCTAssertEqual(NotePrivacy.cleanURL(raw),raw)
        }
        XCTAssertEqual(NotePrivacy.cleanURL("https://youtu.be.evil.test/dQw4w9WgXcQ?si=keep"),"https://youtu.be.evil.test/dQw4w9WgXcQ?si=keep")
    }
    func testMetadataAndOrientationInEncodedOutput() throws {
        let color = CGColorSpaceCreateDeviceRGB()
        let context = CGContext(data:nil,width:20,height:30,bitsPerComponent:8,bytesPerRow:0,space:color,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red:1,green:0,blue:0,alpha:1)); context.fill(CGRect(x:0,y:0,width:20,height:30))
        let image = context.makeImage()!; let original = NSMutableData()
        let writer = CGImageDestinationCreateWithData(original,UTType.jpeg.identifier as CFString,1,nil)!
        let properties: [CFString:Any] = [kCGImagePropertyOrientation:6,kCGImagePropertyExifDictionary:[kCGImagePropertyExifUserComment:"private"],kCGImagePropertyGPSDictionary:[kCGImagePropertyGPSLatitude:51.5,kCGImagePropertyGPSLongitude:1.0],kCGImagePropertyIPTCDictionary:[kCGImagePropertyIPTCKeywords:["private"]],kCGImagePropertyTIFFDictionary:[kCGImagePropertyTIFFArtist:"private"]]
        CGImageDestinationAddImage(writer,image,properties as CFDictionary); XCTAssertTrue(CGImageDestinationFinalize(writer))
        let xmp = Data(("http://ns.adobe.com/xap/1.0/\0" + "<x:xmpmeta xmlns:x='adobe:ns:meta/'>private-xmp</x:xmpmeta>").utf8)
        var tagged = Data([0xff,0xd8,0xff,0xe1,UInt8((xmp.count + 2) >> 8),UInt8((xmp.count + 2) & 255)])
        tagged.append(xmp); tagged.append((original as Data).dropFirst(2))
        let source = CGImageSourceCreateWithData(tagged as CFData,nil)!
        let before = CGImageSourceCopyPropertiesAtIndex(source,0,nil) as! [CFString:Any]
        XCTAssertNotNil(before[kCGImagePropertyGPSDictionary]); XCTAssertNotNil(before[kCGImagePropertyExifDictionary]); XCTAssertNotNil(before[kCGImagePropertyIPTCDictionary])
        let clean = try NotePrivacy.image(tagged)
        let after = CGImageSourceCopyPropertiesAtIndex(CGImageSourceCreateWithData(clean as CFData,nil)!,0,nil) as! [CFString:Any]
        XCTAssertEqual(after[kCGImagePropertyPixelWidth] as? Int,30); XCTAssertEqual(after[kCGImagePropertyPixelHeight] as? Int,20)
        for key in [kCGImagePropertyGPSDictionary,kCGImagePropertyExifDictionary,kCGImagePropertyIPTCDictionary,kCGImagePropertyTIFFDictionary] { XCTAssertNil(after[key]) }
        XCTAssertFalse(String(decoding:clean,as:UTF8.self).contains("private")); XCTAssertFalse(String(decoding:clean,as:UTF8.self).contains("xmp"))
        XCTAssertNil(after[kCGImagePropertyOrientation])
        if let path = ProcessInfo.processInfo.environment["NOTE_FIXTURE_DIR"] {
            try tagged.write(to:URL(fileURLWithPath:path).appendingPathComponent("tagged-orientation-6.jpg"))
            try clean.write(to:URL(fileURLWithPath:path).appendingPathComponent("native-sanitized.png"))
        }
    }
    func testUnreadableImagesFailClosed() {
        XCTAssertThrowsError(try NotePrivacy.image(Data("not an image".utf8)))
    }
    func testPinnedOriginAndPayloadSignature() throws {
        for raw in ["http://example.com","https://user:pass@example.com","https://example.com/path","https://example.com/?token=x"] { XCTAssertThrowsError(try NStackAPI.origin(raw)) }
        let url = try NStackAPI.url("https://example.com","/api/v4/storage/abc")
        let bytes = Data("hello".utf8)
        XCTAssertEqual(NStackAPI.authTags(url:url,method:"POST",bytes:bytes),[["u",url.absoluteString],["method","POST"],["payload",Data(SHA256.hash(data:bytes)).hex]])
    }
    func testHistoryReadsCanonicalAttachmentsAndThread() {
        let message = HistoryMessage(["id":"message","body":"hello","thread_id":"thread","metadata":["attachments":[["kind":"image","storage_object_id":"object"]]]])!
        XCTAssertEqual(message.thread,"thread"); XCTAssertEqual(message.images,["object"])
    }
}

final class MemorySecret: VaultSecretStore {
    var value: Data?
    func read() throws -> Data? { value }
    func write(_ data: Data) throws { value = data }
}
/// Thrown by a mock handler to answer with a non-2xx HTTP status and JSON body.
struct MockHTTPStatus: Error { let code: Int; let body: [String:Any]; var raw: Data? = nil }
final class MockProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> [String:Any])!
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            var status = 200; var result: [String:Any]; var raw: Data?
            do { result = try Self.handler(request) } catch let failure as MockHTTPStatus { status = failure.code; result = failure.body; raw = failure.raw }
            let data = try raw ?? JSONSerialization.data(withJSONObject:result)
            client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:["Content-Type":"application/json"])!,cacheStoragePolicy:.notAllowed)
            client?.urlProtocol(self,didLoad:data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self,didFailWithError:error) }
    }
    override func stopLoading() {}
}
private func syntheticNsec() -> String {
    let alphabet = Array("qpzry9x8gf2tvdw0s3jn54khce6mua7l")
    var accumulator: UInt32 = 0, bits: UInt32 = 0; var words: [UInt32] = []
    for byte in [UInt8](repeating:42,count:32) { accumulator = ((accumulator << 8) | UInt32(byte)) & 0xffff; bits += 8
        while bits >= 5 { bits -= 5; words.append((accumulator >> bits) & 31) }
    }
    if bits > 0 { words.append((accumulator << (5 - bits)) & 31) }
    let hrp = Array("nsec".utf8); var checksum: UInt32 = 1
    for value in hrp.map({UInt32($0 >> 5)}) + [0] + hrp.map({UInt32($0 & 31)}) + words + [UInt32](repeating:0,count:6) {
        let top = checksum >> 25; checksum = ((checksum & 0x1ffffff) << 5) ^ value
        for (i,g) in [UInt32(0x3b6a57b2),0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3].enumerated() where ((top >> i) & 1) != 0 { checksum ^= g }
    }
    checksum ^= 1
    let tail: [UInt32] = (0..<6).map { (checksum >> (5 * (5 - $0))) & 31 }
    let encoded = (words + tail).map { String(alphabet[Int($0)]) }.joined()
    return "nsec1" + encoded
}
extension NoteTests {
    @MainActor
    func testDraftRecoverySignedSendAndIdempotentRetryThroughTransport() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let vault = IdentityVault(url:root.appendingPathComponent("vault.json"),secrets:MemorySecret())
        try vault.create(nsec:syntheticNsec(),pin:"1234")
        let identity = IdentityModel(vault:vault); identity.perform { try $0.unlock(pin:"1234") }
        let signer = identity.npub!
        let destination = Connection(origin:"https://notes.example",workspace:UUID().uuidString,app:NostrCodec.npub(Data(repeating:11,count:32)),signer:signer,channel:UUID().uuidString,label:"Synthetic workspace")
        let state = root.appendingPathComponent("state.json")
        var local = LocalNotes(); local.connection = destination; local.draft.text = "https://youtu.be/dQw4w9WgXcQ?si=tracking&t=42"
        // PostgreSQL BIGINT storage sizes arrive as decimal JSON strings.
        // A completed image must pass reconciliation before sending or retrying.
        let imageBytes = Data(repeating: 1, count: 118)
        var image = NoteImage(bytes: imageBytes)
        image.object = UUID().uuidString
        image.upload = "https://notes.example/api/v4/storage/" + image.object!
        image.complete = true
        local.draft.images = [image]
        try JSONEncoder().encode(local).write(to:state)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [MockProtocol.self]; let session = URLSession(configuration:config)
        var requests: [[String:Any]] = []
        MockProtocol.handler = { request in
            if request.url!.path == "/api/v4/storage/" + image.object! {
                return ["completed_at":"2026-10-15T03:00:00Z","sha256_hex":NostrCodec.hash(imageBytes),"size_bytes":"118","is_public":false]
            }
            if request.httpMethod == "POST" {
                var bytes = request.httpBody ?? Data()
                if let stream = request.httpBodyStream {
                    stream.open(); defer { stream.close() }; var buffer = [UInt8](repeating:0,count:4096)
                    while stream.hasBytesAvailable { let count = stream.read(&buffer,maxLength:buffer.count); if count > 0 { bytes.append(contentsOf:buffer.prefix(count)) } else { break } }
                }
                let body = try JSONSerialization.jsonObject(with:bytes) as! [String:Any]; requests.append(body)
                XCTAssertNotNil(request.value(forHTTPHeaderField:"Authorization"))
                if requests.count == 1 { throw URLError(.timedOut) }
                return ["message":["client_request_id":body["client_request_id"]!,"channel_id":destination.channel,"body":body["body"]!]]
            }
            return ["messages":[["id":"browser-message","body":"A browser note","thread_id":"thread"],["id":"phone-message","body":"A phone reply","thread_id":"thread"]],"next_cursor":NSNull()]
        }
        var notes = NoteStore(identity:identity,stateFile:state,session:session)
        XCTAssertEqual(notes.draft.text,local.draft.text)
        await notes.send()
        XCTAssertTrue(notes.draft.frozen); XCTAssertEqual(notes.draft.id,local.draft.id)
        notes.edit("Cannot change accepted uncertain content"); XCTAssertNotEqual(notes.draft.text,"Cannot change accepted uncertain content")
        notes = NoteStore(identity:identity,stateFile:state,session:session)
        await notes.send()
        guard requests.count == 2 else { XCTFail("Expected two message requests: \(notes.notice ?? "no notice")"); return }; XCTAssertEqual(requests[0]["client_request_id"] as? String,requests[1]["client_request_id"] as? String)
        XCTAssertEqual(requests[1]["body"] as? String,"https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42")
        XCTAssertNotNil(requests[1]["message_signature"])
        let attachments = (requests[1]["metadata"] as? [String:Any])?["attachments"] as? [[String:Any]]
        XCTAssertEqual(attachments?.first?["storage_object_id"] as? String, image.object)
        XCTAssertTrue(notes.draft.text.isEmpty); XCTAssertNotEqual(notes.draft.id,local.draft.id)
        await notes.history(); XCTAssertEqual(notes.messages.map(\.id),["browser-message","phone-message"])
        identity.lock(); await notes.history(); XCTAssertNotNil(notes.notice)
    }
}

private func requestBody(_ request: URLRequest) -> Data {
    var bytes = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }; var buffer = [UInt8](repeating:0,count:4096)
        while stream.hasBytesAvailable { let count = stream.read(&buffer,maxLength:buffer.count); if count > 0 { bytes.append(contentsOf:buffer.prefix(count)) } else { break } }
    }
    return bytes
}

/// Minimal Tower model: generic storage metadata/upload/complete plus PG message
/// idempotency keyed by client_request_id with a hash that covers attachment IDs.
/// Requests arrive on URLProtocol's loading thread while the test awaits; access is sequential.
final class MockTower: @unchecked Sendable {
    let destination: Connection
    var objects: [String:(bytes: Data?, completed: Bool)] = [:]
    var messages: [String:(hash: String, body: [String:Any])] = [:]
    var prepares = 0, messagePosts = 0, storageWrites: [String] = []
    var loseNextMessageResponse = false
    var missingThreads: Set<String> = [], channelMissing = false
    init(destination: Connection) { self.destination = destination }
    static let missing = MockHTTPStatus(code:404,body:["error":"storage object not found or not readable by this npub"])
    func handle(_ request: URLRequest) throws -> [String:Any] {
        let url = request.url!; let method = request.httpMethod ?? "GET"; let bytes = requestBody(request)
        // NIP-98 must bind the exact URL, method and body of every request.
        let header = request.value(forHTTPHeaderField:"Authorization") ?? ""
        let event = try JSONSerialization.jsonObject(with:Data(base64Encoded:String(header.dropFirst("Nostr ".count)))!) as! [String:Any]
        let tags = event["tags"] as! [[String]]
        XCTAssertEqual(event["kind"] as? Int,27235)
        XCTAssertTrue(tags.contains(["u",url.absoluteString])); XCTAssertTrue(tags.contains(["method",method]))
        if !bytes.isEmpty { XCTAssertTrue(tags.contains(["payload",NostrCodec.hash(bytes)])) }
        let body = bytes.isEmpty ? [:] : try JSONSerialization.jsonObject(with:bytes) as! [String:Any]
        let path = url.path
        if path == destination.base + "/storage/prepare" {
            prepares += 1; let id = UUID().uuidString.lowercased(); objects[id] = (nil,false)
            return ["object_id":id,"is_public":false,"upload_url":"https://notes.example/api/v4/storage/" + id]
        }
        if path.hasPrefix("/api/v4/storage/") {
            let parts = path.dropFirst("/api/v4/storage/".count).split(separator:"/").map(String.init)
            guard let object = objects[parts[0]] else { throw Self.missing }
            if parts.count == 2 && parts[1] == "complete" { objects[parts[0]]!.completed = object.bytes != nil; return [:] }
            if method == "PUT" { storageWrites.append(parts[0]); objects[parts[0]]!.bytes = Data(base64Encoded:body["base64_data"] as! String); return [:] }
            guard object.completed, let stored = object.bytes else { return ["completed_at":NSNull()] }
            return ["completed_at":"2026-10-19T09:00:00Z","sha256_hex":NostrCodec.hash(stored),"size_bytes":String(stored.count),"is_public":false]
        }
        if path == destination.base + "/channels/" + destination.channel + "/messages" && method == "POST" {
            messagePosts += 1
            // Tower resolves the channel and reply thread before any idempotency or message write.
            if channelMissing { throw MockHTTPStatus(code:404,body:["error":"Flight Deck PG channel not found","code":"channel_not_found"]) }
            if let thread = body["thread_id"] as? String, missingThreads.contains(thread) { throw MockHTTPStatus(code:404,body:["error":"Flight Deck PG thread not found in this channel","code":"thread_not_found"]) }
            let ids = ((body["metadata"] as? [String:Any])?["attachments"] as? [[String:Any]] ?? []).compactMap { $0["storage_object_id"] as? String }
            let key = body["client_request_id"] as! String
            let hash = NostrCodec.hash(try NostrCodec.json(["thread":body["thread_id"] ?? NSNull(),"body":body["body"]!,"attachments":ids]))
            if let existing = messages[key], existing.hash != hash { throw MockHTTPStatus(code:409,body:["error":"client_request_id was already used for a materially different message","code":"idempotency_conflict"]) }
            if messages[key] == nil {
                for id in ids { guard objects[id]?.completed == true else { throw MockHTTPStatus(code:400,body:["code":"not_attachable"]) } }
                messages[key] = (hash,body)
            }
            if loseNextMessageResponse { loseNextMessageResponse = false; throw URLError(.timedOut) }
            return ["message":["client_request_id":key,"channel_id":destination.channel,"body":body["body"]!]]
        }
        return ["messages":[],"next_cursor":NSNull()]
    }
}

extension NoteTests {
    @MainActor
    private func frozenImageDraft(_ root: URL) throws -> (IdentityModel, Connection, URL, NoteDraft, URLSession) {
        let vault = IdentityVault(url:root.appendingPathComponent("vault.json"),secrets:MemorySecret())
        try vault.create(nsec:syntheticNsec(),pin:"1234")
        let identity = IdentityModel(vault:vault); identity.perform { try $0.unlock(pin:"1234") }
        let destination = Connection(origin:"https://notes.example",workspace:UUID().uuidString,app:NostrCodec.npub(Data(repeating:11,count:32)),signer:identity.npub!,channel:UUID().uuidString,label:"Synthetic workspace")
        // Mirrors a retained device draft: frozen reply whose saved object had completed before Tower lost it.
        var local = LocalNotes(); local.connection = destination
        local.draft.text = "Frozen note"; local.draft.thread = UUID().uuidString; local.draft.parent = UUID().uuidString
        local.draft.destination = destination; local.draft.frozen = true
        var image = NoteImage(bytes:Data(repeating:7,count:431))
        image.object = UUID().uuidString.lowercased()
        image.upload = "https://storage.example/v4/" + image.object! + ".png?X-Amz-Signature=expired"
        image.complete = true
        local.draft.images = [image]
        let state = root.appendingPathComponent("state.json")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        try JSONEncoder().encode(local).write(to:state)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [MockProtocol.self]
        return (identity,destination,state,local.draft,URLSession(configuration:config))
    }

    @MainActor
    func testFrozenDraftRecoversConfirmedMissingObjectAcrossProcessRecoveryWithoutDuplicate() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let (identity,destination,state,original,session) = try frozenImageDraft(root)
        let tower = MockTower(destination:destination)
        MockProtocol.handler = { request in try tower.handle(request) }
        // Tower accepts the message but the response is lost: delivery is uncertain.
        tower.loseNextMessageResponse = true
        var notes = NoteStore(identity:identity,stateFile:state,session:session)
        await notes.send()
        XCTAssertEqual(tower.prepares,1); XCTAssertEqual(tower.messages.count,1)
        XCTAssertTrue(notes.draft.frozen); XCTAssertEqual(notes.draft.id,original.id); XCTAssertEqual(notes.draft.text,original.text)
        let fresh = try XCTUnwrap(notes.draft.images.first?.object)
        XCTAssertNotEqual(fresh,original.images[0].object); XCTAssertEqual(notes.draft.images[0].bytes,original.images[0].bytes)
        XCTAssertEqual(tower.storageWrites,[fresh])
        // Process recovery reloads the persisted fresh object and replays the same request ID.
        notes = NoteStore(identity:identity,stateFile:state,session:session)
        XCTAssertEqual(notes.draft.images.first?.object,fresh); XCTAssertTrue(notes.draft.images[0].complete)
        await notes.send()
        XCTAssertEqual(notes.notice,"Sent to your Flight Deck Note to self.")
        XCTAssertEqual(tower.prepares,1); XCTAssertEqual(tower.messagePosts,2); XCTAssertEqual(tower.messages.count,1)
        let accepted = try XCTUnwrap(tower.messages[original.id.uuidString]?.body)
        XCTAssertEqual(accepted["body"] as? String,"Frozen note"); XCTAssertEqual(accepted["thread_id"] as? String,original.thread)
        XCTAssertEqual(((accepted["metadata"] as? [String:Any])?["attachments"] as? [[String:Any]])?.first?["storage_object_id"] as? String,fresh)
        XCTAssertFalse(notes.draft.frozen); XCTAssertTrue(notes.draft.images.isEmpty); XCTAssertNotEqual(notes.draft.id,original.id)
    }

    @MainActor
    func testRecoveredDraftAlreadyAcceptedUnderItsIDIsNeverResent() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let (identity,destination,state,original,session) = try frozenImageDraft(root)
        let tower = MockTower(destination:destination)
        // An earlier delivery used the old object, which Tower no longer exposes (e.g. the message was deleted).
        let earlier = NostrCodec.hash(try NostrCodec.json(["thread":original.thread!,"body":original.text,"attachments":[original.images[0].object!]]))
        tower.messages[original.id.uuidString] = (earlier,["body":original.text])
        MockProtocol.handler = { request in try tower.handle(request) }
        let notes = NoteStore(identity:identity,stateFile:state,session:session)
        await notes.send()
        XCTAssertEqual(tower.messages.count,1); XCTAssertEqual(tower.messages[original.id.uuidString]?.hash,earlier)
        XCTAssertTrue(notes.notice?.contains("not sent again") == true)
        // Content is preserved as an editable draft that will only send under a new ID by explicit user action.
        XCTAssertFalse(notes.draft.frozen); XCTAssertNil(notes.draft.destination); XCTAssertNotEqual(notes.draft.id,original.id)
        XCTAssertEqual(notes.draft.text,original.text); XCTAssertEqual(notes.draft.thread,original.thread)
        XCTAssertEqual(notes.draft.images.map(\.bytes),original.images.map(\.bytes))
        let reloaded = NoteStore(identity:identity,stateFile:state,session:session)
        XCTAssertEqual(reloaded.draft.id,notes.draft.id); XCTAssertFalse(reloaded.draft.frozen)
    }

    @MainActor
    func testRepeatedStorage404OfAnyShapeKeepsDraftFrozenAfterOneFreshObject() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let (identity,destination,state,original,session) = try frozenImageDraft(root)
        let tower = MockTower(destination:destination)
        // Every storage read answers a non-JSON 404, so the body detail is unavailable. One fresh object is
        // prepared for the unusable saved object; when that is also missing, it is not replaced again in the same attempt.
        MockProtocol.handler = { request in
            if request.url!.path.hasPrefix("/api/v4/storage/") { throw MockHTTPStatus(code:404,body:[:],raw:Data("<html>Not Found</html>".utf8)) }
            return try tower.handle(request)
        }
        var notes = NoteStore(identity:identity,stateFile:state,session:session)
        await notes.send()
        XCTAssertEqual(tower.prepares,1); XCTAssertEqual(tower.messagePosts,0)
        XCTAssertEqual(notes.notice,NStackError.response(404,nil,"image check").localizedDescription)
        XCTAssertTrue(notes.draft.frozen); XCTAssertEqual(notes.draft.id,original.id); XCTAssertEqual(notes.draft.images[0].bytes,original.images[0].bytes)
        XCTAssertNotEqual(notes.draft.images[0].object,original.images[0].object)
        // An uncertain prepare during recovery still fails closed instead of allocating another object.
        MockProtocol.handler = { request in
            if request.url!.path.hasPrefix("/api/v4/storage/") { throw MockTower.missing }
            if request.url!.path.hasSuffix("/storage/prepare") { throw URLError(.timedOut) }
            return try tower.handle(request)
        }
        notes = NoteStore(identity:identity,stateFile:state,session:session)
        await notes.send(); await notes.send()
        XCTAssertEqual(notes.notice,NoteError.uncertainPrepare.localizedDescription)
        XCTAssertTrue(notes.draft.frozen); XCTAssertTrue(notes.draft.images[0].preparing); XCTAssertEqual(tower.messagePosts,0)
    }
}

extension NoteTests {
    func testHTTPErrorNamesStageAndTowerCodeOrDetail() {
        XCTAssertTrue(NStackError.response(404,"thread_not_found","message send").localizedDescription.hasPrefix("nStack returned HTTP 404 during message send (thread_not_found)."))
        XCTAssertTrue(NStackError.response(404,"storage object not found\nor not readable",NStackAPI.stage(method:"GET",path:"/api/v4/storage/x")).localizedDescription.hasPrefix("nStack returned HTTP 404 during image check (storage object not found or not readable)."))
        XCTAssertTrue(NStackError.response(404).localizedDescription.hasPrefix("nStack returned HTTP 404 (no Tower error body)."))
        XCTAssertEqual(NStackAPI.summary(String(repeating:"x",count:100)).count,81)
        XCTAssertEqual(NStackAPI.stage(method:"GET",path:"/api/v4/flightdeck-pg/workspaces/w/channels/c/messages?limit=200"),"history")
        XCTAssertEqual(NStackAPI.stage(method:"POST",path:"/api/v4/storage/x/complete"),"image complete")
    }

    @MainActor
    func testSavedObject404WithoutUsableBodyRecoversThroughOneFreshObjectAndSends() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let (identity,destination,state,original,session) = try frozenImageDraft(root)
        let tower = MockTower(destination:destination)
        let saved = "/api/v4/storage/" + original.images[0].object!
        MockProtocol.handler = { request in
            if request.url!.path == saved { throw MockHTTPStatus(code:404,body:[:],raw:Data()) }
            return try tower.handle(request)
        }
        let notes = NoteStore(identity:identity,stateFile:state,session:session)
        await notes.send()
        XCTAssertEqual(notes.notice,"Sent to your Flight Deck Note to self.")
        XCTAssertEqual(tower.prepares,1); XCTAssertEqual(tower.messages.count,1)
        let accepted = try XCTUnwrap(tower.messages[original.id.uuidString]?.body)
        XCTAssertEqual(accepted["thread_id"] as? String,original.thread)
        XCTAssertEqual(((accepted["metadata"] as? [String:Any])?["attachments"] as? [[String:Any]])?.first?["storage_object_id"] as? String,tower.storageWrites.first)
    }

    /// The observed live failure: the saved image still reads and reconciles, but the reply's thread is gone,
    /// so Tower answers the message POST with 404 thread_not_found on every retry.
    @MainActor
    func testFrozenReplyToDeletedThreadRetriesOnceAsRootUnderSameRequestID() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let (identity,destination,state,original,session) = try frozenImageDraft(root)
        let tower = MockTower(destination:destination)
        let saved = original.images[0].object!
        tower.objects[saved] = (original.images[0].bytes,true)
        tower.missingThreads = [original.thread!]
        var posted: [[String:Any]] = []
        MockProtocol.handler = { request in
            if request.httpMethod == "POST", request.url!.path.hasSuffix("/messages") { posted.append(try JSONSerialization.jsonObject(with:requestBody(request)) as! [String:Any]) }
            return try tower.handle(request)
        }
        let notes = NoteStore(identity:identity,stateFile:state,session:session)
        await notes.send()
        XCTAssertEqual(notes.notice,"Sent to your Flight Deck Note to self as a new note, because the thread it replied to no longer exists (thread_not_found).")
        // Exactly one reply attempt and one root retry, both under the original request ID, reusing the verified object.
        XCTAssertEqual(tower.messages.count,1); XCTAssertEqual(tower.prepares,0); XCTAssertTrue(tower.storageWrites.isEmpty)
        guard posted.count == 2 else { XCTFail("Expected one reply attempt and one root retry, got \(posted.count) posts"); return }
        XCTAssertEqual(posted[0]["thread_id"] as? String,original.thread); XCTAssertEqual(posted[0]["create_thread"] as? Bool,false)
        XCTAssertNil(posted[1]["thread_id"]); XCTAssertEqual(posted[1]["create_thread"] as? Bool,true)
        XCTAssertEqual(posted.map { $0["client_request_id"] as? String },[original.id.uuidString,original.id.uuidString])
        // The root retry is re-signed without the stale thread tag.
        let event = ((posted[1]["message_signature"] as? [String:Any])?["nostr_event"] as? [String:Any])?["tags"] as? [[String]]
        XCTAssertFalse(event?.contains { $0.first == "thread_id" } ?? true)
        let accepted = try XCTUnwrap(tower.messages[original.id.uuidString]?.body)
        XCTAssertEqual(accepted["body"] as? String,original.text)
        XCTAssertEqual(((accepted["metadata"] as? [String:Any])?["attachments"] as? [[String:Any]])?.first?["storage_object_id"] as? String,saved)
        let reloaded = NoteStore(identity:identity,stateFile:state,session:session)
        XCTAssertFalse(reloaded.draft.frozen); XCTAssertTrue(reloaded.draft.images.isEmpty); XCTAssertNotEqual(reloaded.draft.id,original.id)
    }

    @MainActor
    func testRootRetryWithLostResponsePersistsClearedThreadAndReplaysWithoutDuplicate() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let (identity,destination,state,original,session) = try frozenImageDraft(root)
        let tower = MockTower(destination:destination)
        let saved = original.images[0].object!
        tower.objects[saved] = (original.images[0].bytes,true)
        tower.missingThreads = [original.thread!]
        tower.loseNextMessageResponse = true
        MockProtocol.handler = { request in try tower.handle(request) }
        var notes = NoteStore(identity:identity,stateFile:state,session:session)
        await notes.send()
        // Tower accepted the root retry but the response was lost: the persisted draft is still frozen, now as a root.
        XCTAssertEqual(tower.messages.count,1); XCTAssertEqual(tower.messagePosts,2)
        notes = NoteStore(identity:identity,stateFile:state,session:session)
        XCTAssertTrue(notes.draft.frozen); XCTAssertNil(notes.draft.thread); XCTAssertNil(notes.draft.parent)
        XCTAssertEqual(notes.draft.id,original.id); XCTAssertEqual(notes.draft.text,original.text); XCTAssertEqual(notes.draft.destination,destination)
        XCTAssertEqual(notes.draft.images.first?.object,saved); XCTAssertEqual(notes.draft.images.map(\.bytes),original.images.map(\.bytes))
        await notes.send()
        XCTAssertEqual(notes.notice,"Sent to your Flight Deck Note to self."); XCTAssertEqual(tower.messages.count,1); XCTAssertEqual(tower.messagePosts,3)
        XCTAssertFalse(notes.draft.frozen); XCTAssertNotEqual(notes.draft.id,original.id)
    }

    @MainActor
    func testReplyAlreadyAcceptedBeforeThreadDeletionIsNeverResentAsRoot() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let (identity,destination,state,original,session) = try frozenImageDraft(root)
        let tower = MockTower(destination:destination)
        let saved = original.images[0].object!
        tower.objects[saved] = (original.images[0].bytes,true)
        // Tower accepted this reply earlier, then the thread was deleted; the idempotency row remains.
        let earlier = NostrCodec.hash(try NostrCodec.json(["thread":original.thread!,"body":original.text,"attachments":[saved]]))
        tower.messages[original.id.uuidString] = (earlier,["body":original.text])
        tower.missingThreads = [original.thread!]
        MockProtocol.handler = { request in try tower.handle(request) }
        let notes = NoteStore(identity:identity,stateFile:state,session:session)
        await notes.send()
        XCTAssertEqual(tower.messagePosts,2); XCTAssertEqual(tower.messages.count,1); XCTAssertEqual(tower.messages[original.id.uuidString]?.hash,earlier)
        XCTAssertTrue(notes.notice?.contains("idempotency_conflict") == true)
        let reloaded = NoteStore(identity:identity,stateFile:state,session:session)
        XCTAssertFalse(reloaded.draft.frozen); XCTAssertNotEqual(reloaded.draft.id,original.id); XCTAssertEqual(reloaded.draft.text,original.text)
        XCTAssertNil(reloaded.draft.thread); XCTAssertEqual(reloaded.draft.images.map(\.bytes),original.images.map(\.bytes))
    }

    @MainActor
    func testMissingChannelReleasesDraftForReconnectAndOtherMessage404StaysFrozen() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let (identity,destination,state,original,session) = try frozenImageDraft(root)
        let tower = MockTower(destination:destination)
        tower.objects[original.images[0].object!] = (original.images[0].bytes,true)
        // A message 404 without a destination code (e.g. a proxy page) is not proof the target is gone.
        MockProtocol.handler = { request in
            if request.httpMethod == "POST" && request.url!.path.hasSuffix("/messages") { throw MockHTTPStatus(code:404,body:[:],raw:Data("Not Found".utf8)) }
            return try tower.handle(request)
        }
        var notes = NoteStore(identity:identity,stateFile:state,session:session)
        await notes.send()
        XCTAssertTrue(notes.draft.frozen); XCTAssertEqual(notes.draft.thread,original.thread); XCTAssertEqual(notes.draft.destination,destination)
        XCTAssertEqual(notes.notice,"nStack returned HTTP 404 during message send (no Tower error body). Check access and connection; your draft is retained.")
        tower.channelMissing = true
        MockProtocol.handler = { request in try tower.handle(request) }
        notes = NoteStore(identity:identity,stateFile:state,session:session)
        await notes.send()
        XCTAssertTrue(notes.notice?.contains("channel_not_found") == true); XCTAssertTrue(tower.messages.isEmpty)
        XCTAssertFalse(notes.draft.frozen); XCTAssertNil(notes.draft.destination); XCTAssertNil(notes.draft.thread)
        XCTAssertEqual(notes.draft.id,original.id); XCTAssertEqual(notes.draft.text,original.text); XCTAssertEqual(notes.draft.images.map(\.bytes),original.images.map(\.bytes))
    }
}

extension NoteTests {
    @MainActor
    func testDiscardIsAvailableForPendingOrFrozenDraftAndCancelPreservesEverything() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let (identity,destination,state,original,session) = try frozenImageDraft(root)
        let before = try Data(contentsOf:state)
        let notes = NoteStore(identity:identity,stateFile:state,session:session)

        notes.busy = true
        XCTAssertTrue(notes.canDiscardNote, "A frozen draft must stay discardable while normal controls are disabled")
        notes.requestDiscard()
        XCTAssertTrue(notes.discardConfirmationPresented)
        notes.cancelDiscard()

        XCTAssertFalse(notes.discardConfirmationPresented)
        XCTAssertEqual(notes.draft.id,original.id); XCTAssertEqual(notes.draft.text,original.text)
        XCTAssertEqual(notes.draft.images.first?.bytes,original.images.first?.bytes)
        XCTAssertEqual(notes.draft.images.first?.object,original.images.first?.object)
        XCTAssertEqual(notes.connection,destination); XCTAssertTrue(identity.unlocked)
        XCTAssertEqual(try Data(contentsOf:state),before)
    }

    @MainActor
    func testConfirmedDiscardClearsOnlyLocalDraftWithoutNetworkAndAllowsFreshCompose() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:root) }
        let (identity,destination,state,original,session) = try frozenImageDraft(root)
        let signer = identity.npub
        let savedObject = try XCTUnwrap(original.images.first?.object)
        let savedUpload = try XCTUnwrap(original.images.first?.upload)
        var networkRequests = 0
        MockProtocol.handler = { _ in networkRequests += 1; return [:] }
        let notes = NoteStore(identity:identity,stateFile:state,session:session)
        notes.busy = true

        notes.requestDiscard()
        notes.confirmDiscard()

        XCTAssertEqual(networkRequests,0)
        XCTAssertFalse(notes.busy); XCTAssertFalse(notes.canDiscardNote); XCTAssertFalse(notes.discardConfirmationPresented)
        XCTAssertNotEqual(notes.draft.id,original.id); XCTAssertEqual(notes.draft.text,""); XCTAssertTrue(notes.draft.images.isEmpty)
        XCTAssertNil(notes.draft.thread); XCTAssertNil(notes.draft.parent); XCTAssertNil(notes.draft.destination); XCTAssertFalse(notes.draft.frozen)
        XCTAssertEqual(notes.connection,destination, "Workspace settings are not part of the discarded draft")
        XCTAssertTrue(identity.unlocked); XCTAssertEqual(identity.npub,signer)
        XCTAssertTrue(FileManager.default.fileExists(atPath:root.appendingPathComponent("vault.json").path))
        let saved = try Data(contentsOf:state)
        XCTAssertFalse(saved.range(of:Data(savedObject.utf8)) != nil)
        XCTAssertFalse(saved.range(of:Data(savedUpload.utf8)) != nil)
        XCTAssertFalse(saved.range(of:original.images[0].bytes.base64EncodedData()) != nil)

        notes.edit("Fresh note")
        XCTAssertEqual(notes.draft.text,"Fresh note"); XCTAssertTrue(notes.canDiscardNote)
        XCTAssertEqual(notes.connection,destination); XCTAssertEqual(networkRequests,0)
    }
}
