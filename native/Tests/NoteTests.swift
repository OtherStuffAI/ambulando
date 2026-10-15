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
final class MockProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> [String:Any])!
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let result = try Self.handler(request)
            let data = try JSONSerialization.data(withJSONObject:result)
            client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:["Content-Type":"application/json"])!,cacheStoragePolicy:.notAllowed)
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
