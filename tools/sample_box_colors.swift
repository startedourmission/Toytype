// 도해 이미지에서 상자마다 채우기색·테두리색·글자색을 픽셀로 잰다. macOS CoreGraphics 사용.
// AI 도해(이미지 → 그리기 다시 그리기)가 AI 눈짐작 대신 실제 색을 쓰도록 브리지가 부른다.
// usage: swift tools/sample_box_colors.swift <image> '<[[x,y,w,h], ...] px JSON>'
// 출력: [{"fill":"#RRGGBB"|null,"line":"#RRGGBB"|null,"text":"#RRGGBB"|null,"background":"#RRGGBB"}, ...]
//   fill  안쪽에서 가장 많은 색. 바깥 배경과 같으면 null(채우기 없음)
//   line  가장자리 ±3px 띠에서 채우기·배경과 다른 색이 충분히 많을 때만
//   text  안쪽에서 채우기와 다른 색(글자) 중 가장 많은 색
import AppKit

guard CommandLine.arguments.count > 2,
      let img = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let rectsData = CommandLine.arguments[2].data(using: .utf8),
      let rects = (try? JSONSerialization.jsonObject(with: rectsData)) as? [[Double]] else {
  FileHandle.standardError.write("usage: sample_box_colors <image> <rects json>\n".data(using: .utf8)!)
  exit(1)
}

let W = cg.width, H = cg.height
var px = [UInt8](repeating: 255, count: W * H * 4)
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: &px, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4,
                    space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: W, height: H)) // 투명 배경은 흰색으로 본다
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: W, height: H))

typealias RGB = (Double, Double, Double)
func at(_ x: Int, _ y: Int) -> RGB? {
  guard x >= 0, y >= 0, x < W, y < H else { return nil }
  let i = (y * W + x) * 4 // 비트맵 첫 줄이 이미지 맨 위
  return (Double(px[i]), Double(px[i + 1]), Double(px[i + 2]))
}
func dist(_ a: RGB, _ b: RGB) -> Double {
  let dr = a.0 - b.0, dg = a.1 - b.1, db = a.2 - b.2
  return (dr * dr + dg * dg + db * db).squareRoot()
}
func hex(_ c: RGB) -> String {
  String(format: "#%02X%02X%02X", Int(c.0.rounded()), Int(c.1.rounded()), Int(c.2.rounded()))
}

// 4비트씩 묶은 색 칸에서 가장 많은 칸의 평균색과 비율
struct Mode { let color: RGB; let share: Double; let count: Int }
func mode(_ colors: [RGB], excluding: [RGB] = [], within: Double = 0) -> Mode? {
  var buckets: [Int: (Int, Double, Double, Double)] = [:]
  var total = 0
  for c in colors {
    total += 1
    if excluding.contains(where: { dist($0, c) < within }) { continue }
    let key = (Int(c.0) >> 4) << 8 | (Int(c.1) >> 4) << 4 | (Int(c.2) >> 4)
    let b = buckets[key] ?? (0, 0, 0, 0)
    buckets[key] = (b.0 + 1, b.1 + c.0, b.2 + c.1, b.3 + c.2)
  }
  guard total > 0, let best = buckets.values.max(by: { $0.0 < $1.0 }) else { return nil }
  let n = Double(best.0)
  return Mode(color: (best.1 / n, best.2 / n, best.3 / n), share: n / Double(total), count: best.0)
}

func ring(_ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int, from d0: Int, to d1: Int) -> [RGB] {
  // 상자 가장자리에서 d0..d1 px 떨어진 띠 (음수는 안쪽)
  var out: [RGB] = []
  for d in d0...d1 {
    for x in (x0 - d)...(x1 + d) {
      if let c = at(x, y0 - d) { out.append(c) }
      if let c = at(x, y1 + d) { out.append(c) }
    }
    if y1 + d - 1 >= y0 - d + 1 {
      for y in (y0 - d + 1)...(y1 + d - 1) {
        if let c = at(x0 - d, y) { out.append(c) }
        if let c = at(x1 + d, y) { out.append(c) }
      }
    }
  }
  return out
}

var results: [[String: Any]] = []
for r in rects {
  guard r.count == 4, r[2] >= 4, r[3] >= 4 else { results.append([:]); continue }
  let x0 = Int(r[0].rounded()), y0 = Int(r[1].rounded())
  let x1 = Int((r[0] + r[2]).rounded()) - 1, y1 = Int((r[1] + r[3]).rounded()) - 1
  let bg = mode(ring(x0, y0, x1, y1, from: 6, to: 9))?.color ?? (255, 255, 255)

  let inset = max(4, Int(min(r[2], r[3]) * 0.15))
  var inner: [RGB] = []
  if x1 - inset > x0 + inset && y1 - inset > y0 + inset {
    for y in (y0 + inset)...(y1 - inset) { for x in (x0 + inset)...(x1 - inset) { if let c = at(x, y) { inner.append(c) } } }
  }
  let fillMode = mode(inner)
  let fill = fillMode?.color ?? bg
  var out: [String: Any] = ["background": hex(bg)]
  out["fill"] = dist(fill, bg) < 10 ? NSNull() : hex(fill) as Any

  // 테두리: AI 좌표가 몇 px 어긋나도 잡히게 가장자리 안팎 3px 띠를 본다
  let band = ring(x0, y0, x1, y1, from: -3, to: 3)
  if let lm = mode(band, excluding: [fill, bg], within: 40), lm.share >= 0.08 {
    out["line"] = hex(lm.color)
  } else {
    out["line"] = NSNull()
  }
  if let tm = mode(inner, excluding: [fill], within: 60), Double(tm.count) >= max(6, Double(inner.count) * 0.004) {
    out["text"] = hex(tm.color)
  } else {
    out["text"] = NSNull()
  }
  results.append(out)
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: results))
