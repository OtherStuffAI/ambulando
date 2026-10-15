import Foundation
import ImageIO
import UniformTypeIdentifiers

enum NotePrivacy {
    static func cleanURL(_ raw: String) -> String {
        guard let c = URLComponents(string: raw), ["https", "http"].contains(c.scheme?.lowercased() ?? ""), c.user == nil, c.password == nil else { return raw }
        let host = c.host?.lowercased() ?? ""
        let youtube = ["youtube.com","www.youtube.com","m.youtube.com","youtu.be","www.youtu.be"].contains(host)
        let parts = (c.percentEncodedQuery ?? "").split(separator: "&").map(String.init)
        let keys = parts.map { String($0.split(separator: "=", maxSplits: 1).first ?? "").removingPercentEncoding?.lowercased() ?? "" }
        if keys.contains(where: { $0.hasPrefix("x-amz-") || $0.hasPrefix("x-goog-") || ["signature","sig","token","policy","key-pair-id","hmac"].contains($0) }) { return raw }
        let kept = zip(parts,keys).filter { _,k in !k.hasPrefix("utm_") && !["fbclid","gclid","dclid","msclkid","mc_cid","mc_eid","igshid"].contains(k) && !(youtube && ["si","feature"].contains(k)) }.map(\.0)
        let fragment = c.percentEncodedFragment.map { "#" + $0 } ?? ""
        let id = String(c.path.dropFirst())
        if ["youtu.be","www.youtu.be"].contains(host), c.port == nil, id.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil, !keys.contains("v") {
            return "https://www.youtube.com/watch?v=" + id + (kept.isEmpty ? "" : "&" + kept.joined(separator:"&")) + fragment
        }
        return String(raw.prefix(while: { $0 != "?" && $0 != "#" })) + (kept.isEmpty ? "" : "?" + kept.joined(separator:"&")) + fragment
    }
    static func clean(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "https?://[^\\s<>\"\\x00-\\x1f]+") else { return text }
        var result = text
        for match in regex.matches(in:text,range:NSRange(text.startIndex...,in:text)).reversed() {
            guard let range = Range(match.range,in:result) else { continue }
            var raw = String(result[range]); var suffix = ""
            while let last = raw.last, ".,!;:".contains(last) || (last == ")" && raw.filter({$0 == ")"}).count > raw.filter({$0 == "("}).count) { suffix = String(raw.removeLast()) + suffix }
            result.replaceSubrange(range,with:cleanURL(raw) + suffix)
        }
        return result
    }
    static func image(_ data: Data) throws -> Data {
        guard let source = CGImageSourceCreateWithData(data as CFData,nil), CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0,
              let image = CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,kCGImageSourceThumbnailMaxPixelSize:max(width,height)] as CFDictionary) else { throw NoteError.image }
        let output = NSMutableData()
        guard let target = CGImageDestinationCreateWithData(output,UTType.png.identifier as CFString,1,nil) else { throw NoteError.image }
        // Only rendered, orientation-correct pixels enter a fresh PNG container.
        CGImageDestinationAddImage(target,image,[:] as CFDictionary)
        guard CGImageDestinationFinalize(target) else { throw NoteError.image }
        // ImageIO can synthesize an eXIf block with dimensions/colorspace.
        // Keep only pixel and color-rendering PNG chunks, never metadata chunks.
        let encoded = output as Data
        var clean = Data(encoded.prefix(8)); var offset = 8
        let allowed = Set(["IHDR","PLTE","IDAT","IEND","tRNS","iCCP","sRGB","gAMA","cHRM"])
        while offset + 12 <= encoded.count {
            let length = encoded[offset..<offset+4].reduce(0) { ($0 << 8) | Int($1) }
            guard length <= encoded.count - offset - 12 else { throw NoteError.image }
            let type = String(decoding:encoded[offset+4..<offset+8],as:UTF8.self)
            if allowed.contains(type) { clean.append(encoded[offset..<offset+length+12]) }
            offset += length + 12
        }
        guard offset == encoded.count else { throw NoteError.image }
        return clean
    }
}
