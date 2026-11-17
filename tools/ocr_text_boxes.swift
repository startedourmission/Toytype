// 스크린샷의 글자 줄과 위치를 픽셀 좌표(왼쪽 위 원점) JSON으로 출력한다. macOS Vision 사용.
// AI 도해(스크린샷 강조)가 강조 박스를 글자에 정확히 맞추도록 브리지가 프롬프트에 넣는다.
// usage: swift tools/ocr_text_boxes.swift <image>
import AppKit
import Vision

guard CommandLine.arguments.count > 1,
      let img = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot open image\n".data(using: .utf8)!)
  exit(1)
}
let W = Double(cg.width), H = Double(cg.height)
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["ko-KR", "en-US"]
req.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: cg).perform([req])

// 단어 위치: Vision의 부분 범위 박스는 한글에서 20px 가까이 어긋나므로,
// 줄 박스를 시스템 글꼴로 잰 글자 폭 비율대로 나눠 계산한다.
let font = NSFont.systemFont(ofSize: 100)
func width(_ s: Substring) -> Double { Double(NSAttributedString(string: String(s), attributes: [.font: font]).size().width) }

var lines: [[String: Any]] = []
for obs in req.results ?? [] {
  guard let c = obs.topCandidates(1).first else { continue }
  let b = obs.boundingBox
  let x = b.minX * W, y = (1 - b.maxY) * H, w = b.width * W, h = b.height * H
  var line: [String: Any] = ["text": c.string, "box": [Int(x), Int(y), Int(w.rounded()), Int(h.rounded())]]
  let full = width(c.string[...])
  let parts = c.string.split(separator: " ")
  if parts.count > 1 && full > 0 {
    line["words"] = parts.map { part -> [String: Any] in
      let x0 = x + w * width(c.string[..<part.startIndex]) / full
      let x1 = x + w * width(c.string[..<part.endIndex]) / full
      return ["text": String(part), "box": [Int(x0), Int(y), Int((x1 - x0).rounded()), Int(h.rounded())]]
    }
  }
  lines.append(line)
}
let out = try JSONSerialization.data(withJSONObject: ["width": Int(W), "height": Int(H), "lines": lines])
FileHandle.standardOutput.write(out)
