import Foundation
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers

struct PreparedPhoto {
    let jpeg: Data
    let thumb: Data
    let takenAt: Int64
    let dateSource: String
}

/// Turns arbitrary picked image data into upload-ready JPEG (max 2048) + thumb (max 480),
/// resolving the shot date from EXIF → filename → file date → now. Mirrors Android PhotoImporter.
enum PhotoImporter {
    static func prepare(data: Data, filename: String, fileModifiedAt: Int64) throws -> PreparedPhoto {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            throw ApiError(status: 0, code: "VALIDATION", message: "无法读取照片")
        }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
        let (takenAt, dateSource) = resolveDate(properties: properties, name: filename, modifiedAt: fileModifiedAt)

        // kCGImageSourceCreateThumbnailWithTransform bakes EXIF orientation into pixels.
        let mainOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2048,
        ]
        guard let main = CGImageSourceCreateThumbnailAtIndex(source, 0, mainOptions as CFDictionary) else {
            throw ApiError(status: 0, code: "VALIDATION", message: "无法解码照片")
        }
        let jpeg = try encodeJpeg(main, quality: 0.88)

        let thumbOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 480,
        ]
        guard let small = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions as CFDictionary) else {
            throw ApiError(status: 0, code: "VALIDATION", message: "无法生成缩略图")
        }
        let thumb = try encodeJpeg(small, quality: 0.8)

        return PreparedPhoto(jpeg: jpeg, thumb: thumb, takenAt: takenAt, dateSource: dateSource)
    }

    private static func encodeJpeg(_ image: CGImage, quality: Double) throws -> Data {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            throw ApiError(status: 0, code: "INTERNAL", message: "JPEG 编码失败")
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw ApiError(status: 0, code: "INTERNAL", message: "JPEG 编码失败")
        }
        return output as Data
    }

    // MARK: - Date resolution

    static func resolveDate(properties: [CFString: Any], name: String, modifiedAt: Int64) -> (Int64, String) {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any]
        let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any]
        let candidates: [String?] = [
            exif?[kCGImagePropertyExifDateTimeOriginal] as? String,
            exif?[kCGImagePropertyExifDateTimeDigitized] as? String,
            tiff?[kCGImagePropertyTIFFDateTime] as? String,
        ]
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.isLenient = false
        for value in candidates {
            guard let value, let date = formatter.date(from: value) else { continue }
            let time = Int64(date.timeIntervalSince1970 * 1000)
            if plausible(time, now: now) { return (time, "exif") }
        }
        if let time = dateFromFilename(name), plausible(time, now: now) { return (time, "filename") }
        if plausible(modifiedAt, now: now) { return (modifiedAt, "file") }
        return (now, "now")
    }

    /// Same two filename patterns as the Android importer: 20240102_030405 and 2024-01-02 03.04.05 styles.
    static func dateFromFilename(_ name: String) -> Int64? {
        let base = (name as NSString).deletingPathExtension
        let patterns = [
            "(?:^|[^0-9])(19[0-9]{2}|20[0-9]{2})(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])(?:[_-]?([01][0-9]|2[0-3])([0-5][0-9])([0-5][0-9])?)?",
            "(?:^|[^0-9])(19[0-9]{2}|20[0-9]{2})[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12][0-9]|3[01])(?:[ T_-]([01][0-9]|2[0-3])[:.]([0-5][0-9])(?:[:.]([0-5][0-9]))?)?",
        ]
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: base, range: NSRange(base.startIndex..., in: base)) else { continue }
            func group(_ index: Int) -> Int? {
                guard index < match.numberOfRanges,
                      let range = Range(match.range(at: index), in: base) else { return nil }
                let text = String(base[range])
                return text.isEmpty ? nil : Int(text)
            }
            var components = DateComponents()
            components.year = group(1)
            components.month = group(2)
            components.day = group(3)
            components.hour = group(4) ?? 12
            components.minute = group(5) ?? 0
            components.second = group(6) ?? 0
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = .current
            guard let date = calendar.date(from: components) else { continue }
            return Int64(date.timeIntervalSince1970 * 1000)
        }
        return nil
    }

    static func plausible(_ time: Int64, now: Int64) -> Bool {
        guard time > 0, time <= now + 24 * 60 * 60 * 1000 else { return false }
        let year = Calendar(identifier: .gregorian)
            .component(.year, from: Date(timeIntervalSince1970: Double(time) / 1000))
        return year >= 1990
    }
}
