import Foundation
import SwiftUI

// The former canned animation is intentionally not compiled; this app is live-only.
#if false
// MARK: - Model

enum Role { case user, assistant, toolHeader, toolLine }

enum Verdict: Equatable {
    case keep(String)
    case drop(String)

    var isDrop: Bool {
        if case .drop = self { return true }
        return false
    }
}

/// Jev's two answers about one tool call: keep the call, keep its full result.
struct CallScore: Equatable {
    let call: Double
    let result: Double
}

struct Chunk: Identifiable, Equatable {
    let id: Int
    let role: Role
    let text: String
    /// The tool call this line belongs to (header and its result lines share it); nil for text.
    let callId: String?
    let score: CallScore?
    let recent: Bool

    var isText: Bool { role == .user || role == .assistant }

    /// keepResult ≥ 0.5 → keep call and result; else keepCall ≥ 0.5 → keep the call,
    /// the result becomes a one-line note; else the call goes with its result.
    var verdict: Verdict {
        if isText { return .keep("text") }
        if recent { return .keep("pinned") }
        guard let s = score else { return .keep("pinned") }
        if s.result >= 0.5 { return .keep(String(format: "call %.2f · result %.2f", s.call, s.result)) }
        if s.call >= 0.5 {
            return role == .toolHeader
                ? .keep(String(format: "call %.2f · result %.2f → note", s.call, s.result))
                : .drop(String(format: "result %.2f", s.result))
        }
        return .drop(String(format: "call %.2f · result %.2f", s.call, s.result))
    }

    var badgeLabel: String {
        if isText { return "text" }
        if recent { return "pinned" }
        return callId ?? ""
    }
}

let transcript: [Chunk] = {
    var id = 0
    func text(_ role: Role, _ text: String, recent: Bool = false) -> Chunk {
        id += 1
        return Chunk(id: id, role: role, text: text, callId: nil, score: nil, recent: recent)
    }
    func tool(_ callId: String, _ header: String, _ lines: [String], _ score: CallScore?, recent: Bool = false) -> [Chunk] {
        var out: [Chunk] = []
        id += 1
        out.append(Chunk(id: id, role: .toolHeader, text: header, callId: callId, score: score, recent: recent))
        for line in lines {
            id += 1
            out.append(Chunk(id: id, role: .toolLine, text: line, callId: callId, score: score, recent: recent))
        }
        return out
    }
    var t: [Chunk] = []
    t.append(text(.user, "Fix the checkout parser so parseLineItems handles quantities over 999 without truncating. Keep the public API unchanged."))
    t.append(text(.assistant, "I'll read the parser and its tests first."))
    t += tool("t1", "Read(src/checkout/parser.ts)", [
        "Read 212 lines",
        "41  const qty = Number(raw.slice(0, 3));",
        "42  if (Number.isNaN(qty)) throw new ParseError(raw);",
        "43  return { sku, qty, price };",
    ], CallScore(call: 0.18, result: 0.07))
    t += tool("t2", "Bash(npm test -- parser)", [
        "FAIL tests/parser.test.ts > parses quantities over 999",
        "expected 1200, received 120",
        "Tests: 1 failed, 23 passed",
        "Duration 1.42s",
    ], CallScore(call: 0.64, result: 0.21))
    t.append(text(.assistant, "slice(0, 3) truncates to three digits. I'll capture the full quantity with a regex instead."))
    t.append(text(.assistant, "Let me check where parseLineItems is called."))
    t += tool("t3", "Grep(parseLineItems)", [
        "src/checkout/index.ts:14",
        "src/api/orders.ts:88",
        "tests/parser.test.ts:5",
    ], CallScore(call: 0.22, result: 0.09))
    t += tool("t4", "Edit(src/checkout/parser.ts)", [
        "Updated 1 file (+3 -1)",
    ], CallScore(call: 0.71, result: 0.66))
    t.append(text(.assistant, "Still to do: make sure the raw line appears in ParseError messages."))
    t += tool("t5", "Bash(npm test)", ["Tests: 24 passed"], nil, recent: true)
    t.append(text(.assistant, "All 24 tests pass and the public API is unchanged.", recent: true))
    t.append(text(.user, "Great — now handle the ParseError message.", recent: true))
    return t
}()

let candidateCalls: [String] = {
    var seen: [String] = []
    for c in transcript where c.role == .toolHeader && !c.recent {
        if let id = c.callId, !seen.contains(id) { seen.append(id) }
    }
    return seen
}()

// MARK: - Palette

enum Palette {
    static let bg = Color(red: 0.07, green: 0.07, blue: 0.09)
    static let panel = Color(red: 0.10, green: 0.10, blue: 0.12)
    static let fg = Color(red: 0.90, green: 0.90, blue: 0.92)
    static let dim = Color(red: 0.52, green: 0.53, blue: 0.58)
    static let border = Color(red: 0.24, green: 0.24, blue: 0.28)
    static let orange = Color(red: 0.85, green: 0.47, blue: 0.24)
    static let green = Color(red: 0.30, green: 0.85, blue: 0.48)
    static let red = Color(red: 0.96, green: 0.30, blue: 0.33)
    static let amber = Color(red: 0.98, green: 0.72, blue: 0.24)
    static let cyan = Color(red: 0.40, green: 0.78, blue: 0.95)
}

// MARK: - State

enum Phase { case idle, typing, waiting, scanning, collapsing, done }

struct ScrollRequest: Equatable {
    let id: Int
    let anchor: UnitPoint?
    let serial: Int
}

@MainActor
final class Demo: ObservableObject {
    @Published var visible: [Chunk] = []
    @Published var typed: [Int: Int] = [:]
    @Published var revealed: Set<Int> = []
    @Published var phase: Phase = .idle
    @Published var beamY: CGFloat? = nil
    @Published var context: Double = 0.06
    @Published var status: String = ""
    @Published var summary: String? = nil
    @Published var scroll: ScrollRequest? = nil

    private var task: Task<Void, Never>?
    private var scrollSerial = 0
    var frames: [Int: CGRect] = [:]

    func scrollTo(_ id: Int, anchor: UnitPoint?) {
        scrollSerial += 1
        scroll = ScrollRequest(id: id, anchor: anchor, serial: scrollSerial)
    }

    func restart() {
        task?.cancel()
        visible = []
        typed = [:]
        revealed = []
        beamY = nil
        context = 0.06
        status = ""
        summary = nil
        phase = .idle
        task = Task { await run() }
    }

    private func sleep(_ s: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000))
    }

    private func run() async {
        do {
            try await sleep(1.2)
            phase = .typing
            let perChunk = 0.72 / Double(transcript.count)
            for chunk in transcript {
                withAnimation(.spring(duration: 0.35)) {
                    visible.append(chunk)
                    context += perChunk
                }
                scrollTo(chunk.id, anchor: .bottom)
                switch chunk.role {
                case .user, .assistant:
                    typed[chunk.id] = 0
                    let delay = chunk.role == .user ? 0.022 : 0.012
                    for i in 1...chunk.text.count {
                        typed[chunk.id] = i
                        try await sleep(delay)
                    }
                    try await sleep(0.28)
                case .toolHeader:
                    try await sleep(0.32)
                case .toolLine:
                    try await sleep(0.11)
                }
            }

            phase = .waiting
            status = "Context window at \(Int(context * 100))% — running fast-jev-compaction"
            try await sleep(1.6)

            phase = .scanning
            let candidates = candidateCalls.count
            status = "✻ Asking jev-latest \(candidates * 2) questions (\(candidates) tool calls × keep call? + keep result?) · state = whole history, tool outputs omitted · 1 request"
            try await sleep(0.9)

            for chunk in transcript {
                scrollTo(chunk.id, anchor: nil)
                try await sleep(0.02)
                if let f = frames[chunk.id] {
                    withAnimation(.linear(duration: 0.09)) { beamY = f.maxY }
                }
                try await sleep(0.05)
                withAnimation(.easeOut(duration: 0.25)) { _ = revealed.insert(chunk.id) }
                try await sleep(0.07)
            }
            try await sleep(0.4)
            withAnimation(.easeOut(duration: 0.4)) { beamY = nil }
            let dropped = transcript.filter { $0.verdict.isDrop }
            let droppedCalls = candidateCalls.filter { id in transcript.contains { $0.callId == id && $0.role == .toolHeader && $0.verdict.isDrop } }.count
            let droppedResults = candidateCalls.filter { id in transcript.contains { $0.callId == id && $0.role == .toolHeader && !$0.verdict.isDrop && $0.score.map { $0.result < 0.5 } == true } }.count
            status = "\(droppedCalls) calls dropped with their results · \(droppedResults) results replaced by a note · text kept verbatim"
            try await sleep(1.7)

            phase = .collapsing
            status = "Deleting dropped tool calls and results…"
            if let first = transcript.first { scrollTo(first.id, anchor: .top) }
            try await sleep(0.5)
            let charsBefore = transcript.reduce(0) { $0 + $1.text.count }
            let charsAfter = transcript.filter { !$0.verdict.isDrop }.reduce(0) { $0 + $1.text.count }
            for chunk in dropped {
                scrollTo(chunk.id, anchor: nil)
                try await sleep(0.05)
                withAnimation(.easeInOut(duration: 0.42)) {
                    visible.removeAll { $0.id == chunk.id }
                    context -= 0.72 / Double(transcript.count) * 1.35
                }
                try await sleep(0.24)
            }
            try await sleep(0.4)
            withAnimation(.spring(duration: 0.8)) { context = 0.31 }
            phase = .done
            status = "✓ Compacted in 148 ms"
            summary = "\(transcript.count) lines → \(transcript.count - dropped.count) kept · \(dropped.count) removed · \(charsBefore) → \(charsAfter) chars · state ~1.1k tokens · 1 request · 0 summaries · kept text is verbatim"
        } catch {}
    }
}

// MARK: - Views

struct FrameKey: PreferenceKey {
    static var defaultValue: [Int: CGRect] = [:]
    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { $1 })
    }
}

let mono = Font.system(size: 15, design: .monospaced)
let monoSmall = Font.system(size: 12.5, design: .monospaced)

struct ChunkView: View {
    let chunk: Chunk
    let typedCount: Int?
    let revealed: Bool

    var shownText: String {
        if let n = typedCount { return String(chunk.text.prefix(n)) }
        return chunk.text
    }

    var tint: Color? {
        guard revealed else { return nil }
        return chunk.verdict.isDrop ? Palette.red : Palette.green
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            content
            Spacer(minLength: 12)
            if revealed {
                badge
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 10)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill((tint ?? .clear).opacity(chunk.verdict.isDrop ? 0.16 : 0.10))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(tint ?? (chunk.role == .user ? Palette.border : .clear), lineWidth: 1.2)
        )
        .shadow(color: (tint ?? .clear).opacity(0.45), radius: revealed ? 10 : 0)
    }

    @ViewBuilder var content: some View {
        switch chunk.role {
        case .user:
            HStack(alignment: .top, spacing: 8) {
                Text(">").foregroundStyle(Palette.dim)
                Text(shownText).foregroundStyle(Palette.fg)
            }
        case .assistant:
            HStack(alignment: .top, spacing: 8) {
                Text("●").foregroundStyle(Palette.orange)
                Text(shownText).foregroundStyle(Palette.fg)
            }
        case .toolHeader:
            HStack(alignment: .top, spacing: 8) {
                Text("●").foregroundStyle(Palette.green)
                toolTitle
            }
        case .toolLine:
            HStack(alignment: .top, spacing: 8) {
                Text("  ⎿").foregroundStyle(Palette.dim)
                Text(chunk.text).foregroundStyle(Palette.dim)
            }
        }
    }

    var toolTitle: some View {
        let name = chunk.text.prefix { $0 != "(" }
        let rest = chunk.text.dropFirst(name.count)
        return (Text(String(name)).bold().foregroundStyle(Palette.fg)
            + Text(String(rest)).foregroundStyle(Palette.dim))
    }

    var badge: some View {
        let color = tint ?? Palette.dim
        let label: String
        switch chunk.verdict {
        case .keep(let r): label = r
        case .drop(let r): label = r
        }
        return HStack(spacing: 6) {
            Text(chunk.badgeLabel)
                .foregroundStyle(color.opacity(0.85))
            Text(chunk.verdict.isDrop ? "DROP" : "KEEP")
                .bold()
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 3).fill(color.opacity(0.22)))
                .foregroundStyle(color)
            if !chunk.recent && !chunk.isText {
                Text(label).foregroundStyle(color.opacity(0.7))
            }
        }
        .font(monoSmall)
        .fixedSize()
    }
}

struct ContextMeter: View {
    let value: Double
    let phase: Phase

    var color: Color {
        if phase == .done { return Palette.green }
        return value > 0.6 ? Palette.amber : Palette.dim
    }

    var body: some View {
        HStack(spacing: 8) {
            Text("Context")
                .foregroundStyle(Palette.dim)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3).fill(Palette.border).frame(width: 160, height: 8)
                RoundedRectangle(cornerRadius: 3).fill(color).frame(width: max(4, 160 * value), height: 8)
            }
            Text("\(Int(value * 100))%")
                .foregroundStyle(color)
                .frame(width: 44, alignment: .trailing)
                .contentTransition(.numericText())
        }
        .font(monoSmall)
    }
}

struct TerminalView: View {
    @ObservedObject var demo: Demo

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            banner
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 8)

            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(alignment: .leading, spacing: 3) {
                        ForEach(demo.visible) { chunk in
                            ChunkView(
                                chunk: chunk,
                                typedCount: demo.typed[chunk.id],
                                revealed: demo.revealed.contains(chunk.id)
                            )
                            .id(chunk.id)
                            .background(GeometryReader { g in
                                Color.clear.preference(
                                    key: FrameKey.self,
                                    value: [chunk.id: g.frame(in: .named("transcript"))]
                                )
                            })
                            .transition(.asymmetric(
                                insertion: .move(edge: .bottom).combined(with: .opacity),
                                removal: .scale(scale: 0.85, anchor: .leading)
                                    .combined(with: .move(edge: .trailing))
                                    .combined(with: .opacity)
                            ))
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 6)
                }
                .coordinateSpace(name: "transcript")
                .onPreferenceChange(FrameKey.self) { frames in
                    demo.frames.merge(frames, uniquingKeysWith: { $1 })
                }
                .overlay(alignment: .top) {
                    if let y = demo.beamY {
                        beam.offset(y: y - 14)
                    }
                }
                .onChange(of: demo.scroll) { _, request in
                    if let request {
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(request.id, anchor: request.anchor) }
                    }
                }
                .onChange(of: demo.typed) { _, _ in
                    if let request = demo.scroll, demo.phase == .typing {
                        proxy.scrollTo(request.id, anchor: .bottom)
                    }
                }
            }
            .font(mono)
            .clipped()

            footer
                .padding(.horizontal, 20)
                .padding(.bottom, 14)
                .padding(.top, 8)
        }
        .background(Palette.bg)
    }

    var beam: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [.clear, Palette.cyan.opacity(0.18)], startPoint: .top, endPoint: .bottom)
                .frame(height: 26)
            Rectangle().fill(Palette.cyan).frame(height: 2)
                .shadow(color: Palette.cyan, radius: 8)
        }
        .allowsHitTesting(false)
    }

    var banner: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text("✻").foregroundStyle(Palette.orange)
                Text("Welcome to Claude Code!").bold().foregroundStyle(Palette.fg)
            }
            Text("  /help for help, /status for your current setup").foregroundStyle(Palette.dim)
            Text("  cwd: ~/work/checkout-service").foregroundStyle(Palette.dim)
            HStack(spacing: 0) {
                Text("  compaction: ").foregroundStyle(Palette.dim)
                Text("fast-jev-compaction").foregroundStyle(Palette.cyan)
                Text(" · jev-latest · verbatim, no summaries").foregroundStyle(Palette.dim)
            }
        }
        .font(mono)
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.orange.opacity(0.7), lineWidth: 1))
    }

    var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            statusLine
            HStack(spacing: 8) {
                Text(">").foregroundStyle(Palette.dim)
                Text(demo.phase == .done ? "" : " ")
                Rectangle().fill(Palette.fg).frame(width: 9, height: 18).opacity(cursorOn ? 1 : 0)
                Spacer()
            }
            .font(mono)
            .padding(.vertical, 8)
            .padding(.horizontal, 12)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.border, lineWidth: 1))
            HStack {
                Text("? for shortcuts").foregroundStyle(Palette.dim).font(monoSmall)
                Spacer()
                ContextMeter(value: demo.context, phase: demo.phase)
            }
        }
    }

    @State private var cursorOn = true

    @ViewBuilder var statusLine: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if demo.phase == .scanning || demo.phase == .collapsing {
                    Spinner()
                }
                Text(demo.status)
                    .foregroundStyle(statusColor)
                    .contentTransition(.opacity)
            }
            if let summary = demo.summary {
                Text(summary)
                    .foregroundStyle(Palette.dim)
                    .transition(.opacity)
            }
        }
        .font(monoSmall)
        .frame(minHeight: 36, alignment: .leading)
        .animation(.easeInOut(duration: 0.3), value: demo.status)
        .animation(.easeInOut(duration: 0.3), value: demo.summary)
    }

    var statusColor: Color {
        switch demo.phase {
        case .waiting: return Palette.amber
        case .scanning, .collapsing: return Palette.cyan
        case .done: return Palette.green
        default: return Palette.dim
        }
    }
}

struct Spinner: View {
    @State private var index = 0
    private let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

    var body: some View {
        Text(frames[index])
            .foregroundStyle(Palette.cyan)
            .onReceive(Timer.publish(every: 0.08, on: .main, in: .common).autoconnect()) { _ in
                index = (index + 1) % frames.count
            }
    }
}

#endif

// MARK: - Live trace viewer

enum Palette {
    static let bg = Color(red: 0.07, green: 0.07, blue: 0.09)
    static let panel = Color(red: 0.10, green: 0.10, blue: 0.12)
    static let fg = Color(red: 0.90, green: 0.90, blue: 0.92)
    static let dim = Color(red: 0.52, green: 0.53, blue: 0.58)
    static let border = Color(red: 0.24, green: 0.24, blue: 0.28)
    static let orange = Color(red: 0.85, green: 0.47, blue: 0.24)
    static let green = Color(red: 0.30, green: 0.85, blue: 0.48)
    static let red = Color(red: 0.96, green: 0.30, blue: 0.33)
    static let amber = Color(red: 0.98, green: 0.72, blue: 0.24)
    static let cyan = Color(red: 0.40, green: 0.78, blue: 0.95)
}

let mono = Font.system(size: 15, design: .monospaced)
let monoSmall = Font.system(size: 12.5, design: .monospaced)

struct TraceAction: Identifiable, Decodable {
    let id: String
    let callId: String
    let tool: String
    let action: String
    let reason: String
    let keepCall: Double
    let keepResult: Double
    let inputPreview: String
    let resultPreview: String?
    let resultOmittedChars: Int?
}

struct TraceEvent: Identifiable, Decodable {
    let id: String
    let timestamp: String
    let event: String
    let sessionId: String?
    let trigger: String?
    let source: String?
    let transcriptPath: String?
    let lineCount: Int?
    let activeItemCount: Int?
    let calls: Int?
    let requests: Int?
    let model: String?
    let callCount: Int?
    let questionCount: Int?
    let answerCount: Int?
    let stateChars: Int?
    let durationMs: Int?
    let reductionRatio: Double?
    let summary: String?
    let reason: String?
    let error: String?
    let noteChars: Int?
    let actions: [TraceAction]?

    private enum CodingKeys: String, CodingKey {
        case id, timestamp, event, sessionId, trigger, source, transcriptPath
        case lineCount, activeItemCount, calls, requests, model, callCount, questionCount, answerCount, stateChars
        case durationMs, reductionRatio, summary, reason, error, noteChars, actions
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        timestamp = try values.decodeIfPresent(String.self, forKey: .timestamp) ?? ""
        event = try values.decodeIfPresent(String.self, forKey: .event) ?? "unknown"
        id = try values.decodeIfPresent(String.self, forKey: .id)
            ?? "\(timestamp)-\(event)-\(UUID().uuidString)"
        sessionId = try values.decodeIfPresent(String.self, forKey: .sessionId)
        trigger = try values.decodeIfPresent(String.self, forKey: .trigger)
        source = try values.decodeIfPresent(String.self, forKey: .source)
        transcriptPath = try values.decodeIfPresent(String.self, forKey: .transcriptPath)
        lineCount = try values.decodeIfPresent(Int.self, forKey: .lineCount)
        activeItemCount = try values.decodeIfPresent(Int.self, forKey: .activeItemCount)
        calls = try values.decodeIfPresent(Int.self, forKey: .calls)
        requests = try values.decodeIfPresent(Int.self, forKey: .requests)
        model = try values.decodeIfPresent(String.self, forKey: .model)
        callCount = try values.decodeIfPresent(Int.self, forKey: .callCount)
        questionCount = try values.decodeIfPresent(Int.self, forKey: .questionCount)
        answerCount = try values.decodeIfPresent(Int.self, forKey: .answerCount)
        stateChars = try values.decodeIfPresent(Int.self, forKey: .stateChars)
        durationMs = try values.decodeIfPresent(Int.self, forKey: .durationMs)
        reductionRatio = try values.decodeIfPresent(Double.self, forKey: .reductionRatio)
        summary = try values.decodeIfPresent(String.self, forKey: .summary)
        reason = try values.decodeIfPresent(String.self, forKey: .reason)
        error = try values.decodeIfPresent(String.self, forKey: .error)
        noteChars = try values.decodeIfPresent(Int.self, forKey: .noteChars)
        actions = try values.decodeIfPresent([TraceAction].self, forKey: .actions)
    }
}

@MainActor
final class LiveTraceStore: ObservableObject {
    @Published private(set) var events: [TraceEvent] = []
    let path: String

    init() {
        let environment = ProcessInfo.processInfo.environment
        if let configured = environment["FAST_JEV_TRACE_FILE"], !configured.isEmpty {
            path = NSString(string: configured).expandingTildeInPath
        } else {
            path = (NSHomeDirectory() as NSString).appendingPathComponent(
                ".config/fast-jev-compaction/events.jsonl"
            )
        }
        reload()
    }

    var displayPath: String {
        path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
    }

    func reload() {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let text = String(data: data, encoding: .utf8) else {
            if !events.isEmpty { events = [] }
            return
        }

        let decoder = JSONDecoder()
        let parsed = text.split(whereSeparator: \.isNewline).compactMap { line -> TraceEvent? in
            guard let data = String(line).data(using: .utf8) else { return nil }
            return try? decoder.decode(TraceEvent.self, from: data)
        }
        events = Array(parsed.suffix(500))
    }

    func clear() {
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? Data().write(to: url, options: .atomic)
        events = []
    }
}

func traceLabel(_ event: String) -> String {
    switch event {
    case "precompact_started": return "PreCompact started"
    case "rollout_parsed": return "Codex history parsed"
    case "jev_request_started": return "TypeSafe request started"
    case "jev_response_received": return "Jev response received"
    case "jev_request_failed": return "TypeSafe request failed"
    case "plan_ready": return "Jev plan ready"
    case "recovery_note_ready": return "Recovery note prepared"
    case "session_start_received": return "SessionStart received"
    case "recovery_note_loaded": return "Recovery note loaded"
    case "recovery_note_missing": return "Recovery note unavailable"
    case "fallback": return "Native fallback"
    default: return event.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

func traceColor(_ event: String) -> Color {
    switch event {
    case "jev_request_failed", "fallback", "recovery_note_missing": return Palette.red
    case "jev_response_received", "plan_ready", "recovery_note_ready", "recovery_note_loaded": return Palette.green
    case "jev_request_started", "precompact_started", "rollout_parsed": return Palette.cyan
    default: return Palette.dim
    }
}

func shortTimestamp(_ timestamp: String) -> String {
    if timestamp.count >= 19 {
        return String(timestamp.dropFirst(11).prefix(8))
    }
    return timestamp
}

struct LiveEventRow: View {
    let event: TraceEvent
    let selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(traceColor(event.event))
                .frame(width: 7, height: 7)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(traceLabel(event.event))
                        .bold()
                        .foregroundStyle(Palette.fg)
                    Spacer()
                    Text(shortTimestamp(event.timestamp))
                        .foregroundStyle(Palette.dim)
                }
                Text(event.summary ?? event.reason ?? event.error ?? event.event)
                    .foregroundStyle(Palette.dim)
                    .lineLimit(2)
            }
        }
        .font(monoSmall)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: 5)
                .fill(selected ? Palette.cyan.opacity(0.12) : Palette.panel.opacity(0.45))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 5)
                .stroke(selected ? Palette.cyan.opacity(0.65) : Palette.border.opacity(0.45), lineWidth: 1)
        )
    }
}

struct LiveActionView: View {
    let action: TraceAction

    var color: Color {
        switch action.action {
        case "drop_call": return Palette.red
        case "drop_result": return Palette.amber
        default: return Palette.green
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(action.tool).bold().foregroundStyle(Palette.fg)
                Text(action.callId).foregroundStyle(Palette.dim)
                Spacer()
                Text(action.action.uppercased())
                    .bold()
                    .foregroundStyle(color)
            }
            Text("call \(String(format: "%.2f", action.keepCall)) · result \(String(format: "%.2f", action.keepResult)) · \(action.reason)")
                .foregroundStyle(color.opacity(0.85))
            Text("input: \(action.inputPreview)")
                .foregroundStyle(Palette.dim)
                .lineLimit(4)
            if let result = action.resultPreview {
                Text("result: \(result)")
                    .foregroundStyle(Palette.dim)
                    .lineLimit(6)
            }
        }
        .font(monoSmall)
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 5).fill(color.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 5).stroke(color.opacity(0.35), lineWidth: 1))
    }
}

struct LiveEventDetail: View {
    let event: TraceEvent

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(traceLabel(event.event))
                        .font(.system(size: 20, weight: .semibold, design: .monospaced))
                        .foregroundStyle(traceColor(event.event))
                    Spacer()
                    Text(shortTimestamp(event.timestamp))
                        .font(monoSmall)
                        .foregroundStyle(Palette.dim)
                }

                metadata

                if let summary = event.summary {
                    detailBlock(title: "Summary", text: summary)
                }
                if let reason = event.reason {
                    detailBlock(title: "Reason", text: reason)
                }
                if let error = event.error {
                    detailBlock(title: "Error", text: error)
                }
                if let actions = event.actions, !actions.isEmpty {
                    Text("Jev decisions (\(actions.count))")
                        .font(mono)
                        .foregroundStyle(Palette.fg)
                    ForEach(actions) { action in
                        LiveActionView(action: action)
                    }
                }
            }
            .padding(22)
        }
    }

    var metadata: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let sessionId = event.sessionId { metadataLine("session", sessionId) }
            if let trigger = event.trigger { metadataLine("trigger", trigger) }
            if let source = event.source { metadataLine("source", source) }
            if let transcriptPath = event.transcriptPath { metadataLine("rollout", transcriptPath) }
            if let lineCount = event.lineCount { metadataLine("rollout lines", "\(lineCount)") }
            if let activeItemCount = event.activeItemCount { metadataLine("active items", "\(activeItemCount)") }
            if let calls = event.calls { metadataLine("paired calls", "\(calls)") }
            if let requests = event.requests { metadataLine("requests", "\(requests)") }
            if let model = event.model { metadataLine("model", model) }
            if let callCount = event.callCount { metadataLine("tool calls", "\(callCount)") }
            if let questionCount = event.questionCount { metadataLine("Jev questions", "\(questionCount)") }
            if let answerCount = event.answerCount { metadataLine("Jev answers", "\(answerCount)") }
            if let stateChars = event.stateChars { metadataLine("state", "\(stateChars) chars") }
            if let durationMs = event.durationMs { metadataLine("duration", "\(durationMs) ms") }
            if let reductionRatio = event.reductionRatio {
                metadataLine("reduction", "\(Int(reductionRatio * 100))%")
            }
            if let noteChars = event.noteChars { metadataLine("note", "\(noteChars) chars") }
        }
        .font(monoSmall)
    }

    func metadataLine(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label).foregroundStyle(Palette.dim).frame(width: 112, alignment: .leading)
            Text(value).foregroundStyle(Palette.fg).textSelection(.enabled)
        }
    }

    func detailBlock(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).foregroundStyle(Palette.fg)
            Text(text)
                .foregroundStyle(Palette.dim)
                .textSelection(.enabled)
        }
        .font(monoSmall)
    }
}

struct LiveRootView: View {
    @StateObject private var store = LiveTraceStore()
    @State private var selectedID: String?
    private let poller = Timer.publish(every: 0.25, on: .main, in: .common).autoconnect()

    var selectedEvent: TraceEvent? {
        guard let selectedID else { return store.events.last }
        return store.events.first { $0.id == selectedID } ?? store.events.last
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Palette.border)
            HStack(spacing: 0) {
                eventStream
                    .frame(width: 470)
                Divider().overlay(Palette.border)
                detail
            }
        }
        .frame(minWidth: 1240, minHeight: 780)
        .background(Palette.bg)
        .onAppear { selectedID = store.events.last?.id }
        .onReceive(poller) { _ in
            store.reload()
            if selectedID == nil || !store.events.contains(where: { $0.id == selectedID }) {
                selectedID = store.events.last?.id
            }
        }
    }

    var header: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Circle().fill(Palette.green).frame(width: 8, height: 8)
                    Text("fast-jev-codex").bold().foregroundStyle(Palette.fg)
                    Text("LIVE TRACE").foregroundStyle(Palette.cyan)
                }
                Text("Watching real Codex PreCompact and SessionStart hooks")
                    .foregroundStyle(Palette.dim)
            }
            Spacer()
            Text("\(store.events.count) events")
                .foregroundStyle(Palette.dim)
                .font(monoSmall)
            Button {
                store.clear()
                selectedID = nil
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(Palette.dim)
            .help("Clear the local trace before a new test")
        }
        .font(monoSmall)
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .background(Palette.panel)
    }

    var eventStream: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("EVENT STREAM").foregroundStyle(Palette.fg)
                Spacer()
                Text("polling").foregroundStyle(Palette.dim)
            }
            .font(monoSmall)
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            Divider().overlay(Palette.border)

            if store.events.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Spacer()
                    Text("Waiting for a real Codex hook…")
                        .foregroundStyle(Palette.amber)
                    Text("Start a new Codex session, then trigger native compaction.")
                        .foregroundStyle(Palette.dim)
                    Text(store.displayPath)
                        .foregroundStyle(Palette.dim)
                        .lineLimit(2)
                    Spacer()
                }
                .font(monoSmall)
                .padding(18)
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.vertical, showsIndicators: false) {
                        LazyVStack(alignment: .leading, spacing: 6) {
                            ForEach(store.events) { event in
                                Button {
                                    selectedID = event.id
                                } label: {
                                    LiveEventRow(event: event, selected: selectedID == event.id)
                                }
                                .buttonStyle(.plain)
                                .id(event.id)
                            }
                        }
                        .padding(10)
                    }
                    .onChange(of: store.events.count) { _, _ in
                        if let id = store.events.last?.id {
                            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .bottom) }
                        }
                    }
                }
            }
        }
        .background(Palette.bg)
    }

    var detail: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let event = selectedEvent {
                LiveEventDetail(event: event)
            } else {
                Spacer()
                HStack {
                    Spacer()
                    Text("Select a real hook event")
                        .foregroundStyle(Palette.dim)
                    Spacer()
                }
                Spacer()
            }
            Divider().overlay(Palette.border)
            HStack {
                Text("trace file").foregroundStyle(Palette.dim)
                Text(store.displayPath).foregroundStyle(Palette.fg).textSelection(.enabled)
                Spacer()
            }
            .font(monoSmall)
            .padding(.horizontal, 18)
            .padding(.vertical, 9)
            .background(Palette.panel)
        }
    }
}

#if false
struct RootView: View {
    @StateObject private var demo = Demo()

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Text("claude — checkout-service — 132×44")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Palette.dim)
                Spacer()
            }
            .frame(height: 30)
            .background(Palette.panel)
            TerminalView(demo: demo)
        }
        .frame(minWidth: 1180, minHeight: 900)
        .background(Palette.bg)
        .onAppear {
            demo.restart()
            NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                if event.keyCode == 49 { // space
                    demo.restart()
                    return nil
                }
                return event
            }
        }
    }
}
#endif

@main
struct JevDemoApp: App {
    var body: some Scene {
        WindowGroup {
            LiveRootView()
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
    }
}
