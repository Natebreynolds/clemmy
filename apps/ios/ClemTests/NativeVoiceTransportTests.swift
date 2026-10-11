import XCTest
@testable import Clem

final class NativeVoiceTransportTests: XCTestCase {
    private func response(_ text: String, closed: Bool = true) throws -> NativeVoiceHTTPResponse? {
        try NativeVoiceHTTPParser.parse(Data(text.utf8), closed: closed)
    }
    func testBoundedContentLengthAndPartialBody() throws {
        XCTAssertNil(try response("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe", closed: false))
        XCTAssertEqual(try response("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello")?.body, Data("hello".utf8))
        XCTAssertThrowsError(try response("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhe"))
        XCTAssertThrowsError(try response("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloextra"))
    }
    func testChunkedAudioAndPartialChunks() throws {
        let start = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: audio/mpeg\r\n\r\n"
        XCTAssertNil(try response(start + "5\r\nhel", closed: false))
        XCTAssertEqual(try response(start + "5\r\nhello\r\n1\r\n!\r\n0\r\n\r\n")?.body, Data("hello!".utf8))
        for bad in ["\r\n", ";extension\r\n", "g\r\n", "0\r\nSet-Cookie: stolen\r\n\r\n", "1\r\naXX0\r\n\r\n"] {
            XCTAssertThrowsError(try response(start + bad))
        }
    }
    func testRefusesAmbiguousFramingCredentialHeadersAndCompression() throws {
        for fields in ["Content-Length: 0\r\nContent-Length: 0", "Transfer-Encoding: chunked\r\nContent-Length: 0", "Set-Cookie: a\r\nSet-Cookie: b", "x-clem-session-fp: a\r\nx-clem-session-fp: b", "Content-Encoding: gzip", " Bad: folded"] {
            XCTAssertThrowsError(try response("HTTP/1.1 200 OK\r\n" + fields + "\r\n\r\n"))
        }
    }
    func testLimitsAndClosedUnframedResponse() throws {
        XCTAssertThrowsError(try response("HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n"))
        XCTAssertThrowsError(try response(String(repeating: "x", count: NativeVoiceHTTPParser.maximumHeaders + 1), closed: false))
        XCTAssertNil(try response("HTTP/1.1 200 OK\r\n\r\nhello", closed: false))
        XCTAssertEqual(try response("HTTP/1.1 200 OK\r\n\r\nhello")?.body, Data("hello".utf8))
        XCTAssertEqual(try response("HTTP/1.1 302 Found\r\nLocation: https://unpaired.invalid\r\nContent-Length: 0\r\n\r\n")?.status, 302)
    }
}
