import SwiftUI
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// Relationship graph overlay, ported from Web GraphOverlay.tsx: force-directed canvas of
/// people + a side panel of the selected person's neighbors.
struct GraphOverlay: View {
    let dismiss: () -> Void
    @Environment(AppViewModel.self) private var model
    @State private var selectedId: String?

    var body: some View {
        OverlayFrame(title: "◈ 关系图谱", dismiss: dismiss) {
            if model.graphLoading {
                emptyText("正在整理关系…")
            } else if model.graphNodes.isEmpty {
                emptyText("还没有人物档案,先去「人物」里添加吧。")
            } else {
                VStack(spacing: 10) {
                    if model.graphEdges.isEmpty {
                        Text("还没有关系记录,继续写日记,念念会慢慢认出大家的关系。")
                            .font(.system(size: 12))
                            .foregroundStyle(NxColors.textFaint)
                    }
                    GraphCanvas(nodes: model.graphNodes, edges: model.graphEdges, selectedId: $selectedId)
                        .frame(minHeight: 260)
                    if let selected = model.graphNodes.first(where: { $0.id == selectedId }) {
                        GraphSidePanel(
                            selected: selected,
                            nodes: model.graphNodes,
                            edges: model.graphEdges,
                            onClose: { selectedId = nil }
                        )
                    }
                }
            }
        }
        .task { model.loadGraph() }
    }

    private func emptyText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundStyle(NxColors.textFaint)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Canvas drawing the edges (dimmed when a node is selected and not a neighbor) plus
/// natively-positioned avatar views for the nodes (drag to pin, tap to select).
struct GraphCanvas: View {
    let nodes: [GraphNode]
    let edges: [RelationshipDto]
    @Binding var selectedId: String?
    @Environment(AppViewModel.self) private var model

    @State private var points: [String: GraphLayout.Point] = [:]
    @State private var dragOrigins: [String: CGPoint] = [:]

    var body: some View {
        GeometryReader { proxy in
            TimelineView(.animation) { timeline in
                ZStack {
                    Canvas { context, _ in
                        for edge in edges {
                            guard let pa = points[edge.a], let pb = points[edge.b] else { continue }
                            let dim = selectedId != nil && edge.a != selectedId && edge.b != selectedId
                            var path = Path()
                            path.move(to: CGPoint(x: pa.x, y: pa.y))
                            path.addLine(to: CGPoint(x: pb.x, y: pb.y))
                            let color = (edge.label.isEmpty ? NxColors.textFaint : NxColors.gold)
                                .opacity(dim ? 0.15 : 0.55)
                            context.stroke(path, with: .color(color), lineWidth: edge.label.isEmpty ? 1 : 1.4)
                            if !edge.label.isEmpty {
                                let mid = CGPoint(x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2)
                                context.draw(
                                    Text(edge.label).font(.system(size: 10)).foregroundStyle(NxColors.textDim.opacity(dim ? 0.3 : 1)),
                                    at: mid
                                )
                            }
                        }
                    }
                    ForEach(nodes) { node in
                        if let p = points[node.id] {
                            nodeAvatar(node)
                                .position(x: p.x, y: p.y)
                        }
                    }
                }
                .onChange(of: timeline.date) { _, date in
                    advance(width: proxy.size.width, height: proxy.size.height, date: date)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { selectedId = nil }
            .onAppear { seed(width: proxy.size.width, height: proxy.size.height) }
            .onChange(of: proxy.size) { _, newSize in seed(width: newSize.width, height: newSize.height) }
            .onChange(of: nodes) { _, _ in seed(width: proxy.size.width, height: proxy.size.height) }
        }
    }

    private var reduceMotion: Bool {
        #if os(iOS)
        UIAccessibility.isReduceMotionEnabled
        #elseif os(macOS)
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        #else
        false
        #endif
    }

    private var neighborIds: Set<String> {
        guard let selectedId else { return [] }
        var result: Set<String> = []
        for edge in edges {
            if edge.a == selectedId { result.insert(edge.b) }
            if edge.b == selectedId { result.insert(edge.a) }
        }
        return result
    }

    @ViewBuilder
    private func nodeAvatar(_ node: GraphNode) -> some View {
        let dim = selectedId != nil && selectedId != node.id && !neighborIds.contains(node.id)
        VStack(spacing: 4) {
            ZStack {
                Circle().fill(node.isUser ? NxColors.gold.opacity(0.18) : NxColors.controlRaised)
                if let face = node.enrolledFrom.first, let data = model.faceThumbs[face.cacheKey] {
                    BytesImage(data: data).clipShape(Circle())
                } else {
                    Text(String(node.name.prefix(1))).font(.nxSerif(15)).foregroundStyle(NxColors.text)
                }
            }
            .frame(width: 44, height: 44)
            .overlay(Circle().stroke(NxColors.line, lineWidth: 1))
            .task { if let face = node.enrolledFrom.first { model.loadFaceThumb(face) } }
            Text(node.name).font(.system(size: 10)).foregroundStyle(NxColors.textDim).lineLimit(1)
        }
        .opacity(dim ? 0.35 : 1)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    let origin = dragOrigins[node.id] ?? CGPoint(x: points[node.id]?.x ?? 0, y: points[node.id]?.y ?? 0)
                    dragOrigins[node.id] = origin
                    points[node.id]?.fixed = true
                    points[node.id]?.x = origin.x + value.translation.width
                    points[node.id]?.y = origin.y + value.translation.height
                }
                .onEnded { _ in
                    points[node.id]?.fixed = false
                    dragOrigins[node.id] = nil
                }
        )
        .onTapGesture { selectedId = (selectedId == node.id) ? nil : node.id }
    }

    private func seed(width: CGFloat, height: CGFloat) {
        guard width > 0, height > 0 else { return }
        let ids = Set(nodes.map(\.id))
        for key in points.keys where !ids.contains(key) { points.removeValue(forKey: key) }
        for (index, node) in nodes.enumerated() where points[node.id] == nil {
            points[node.id] = GraphLayout.initialPoint(
                id: node.id, index: index, count: nodes.count,
                width: Double(width), height: Double(height)
            )
        }
    }

    private func advance(width: CGFloat, height: CGFloat, date: Date) {
        guard width > 0, height > 0 else { return }
        let ids = nodes.map(\.id)
        let simEdges = edges.map { GraphLayout.Edge(a: $0.a, b: $0.b, hasLabel: !$0.label.isEmpty) }
        GraphLayout.step(
            points: &points, ids: ids, edges: simEdges,
            width: Double(width), height: Double(height),
            t: date.timeIntervalSinceReferenceDate * 1000,
            wanderEnabled: !reduceMotion
        )
    }
}

/// Lists the selected node's relationship edges; delete (✕) only on non-virtual ones —
/// virtual edges are synthesized from Person.relation and aren't independently deletable.
struct GraphSidePanel: View {
    let selected: GraphNode
    let nodes: [GraphNode]
    let edges: [RelationshipDto]
    let onClose: () -> Void
    @Environment(AppViewModel.self) private var model

    private var neighbors: [(edge: RelationshipDto, other: GraphNode)] {
        edges
            .filter { $0.a == selected.id || $0.b == selected.id }
            .compactMap { edge in
                let otherId = edge.a == selected.id ? edge.b : edge.a
                guard let other = nodes.first(where: { $0.id == otherId }) else { return nil }
                return (edge, other)
            }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(selected.name).font(.nxSerif(15)).foregroundStyle(NxColors.text)
                Spacer()
                NxIconButton(systemName: "xmark", label: "取消选中", action: onClose)
            }
            if neighbors.isEmpty {
                Text("暂无关系记录").font(.system(size: 12)).foregroundStyle(NxColors.textFaint)
            } else {
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(neighbors, id: \.edge.id) { pair in
                            HStack {
                                ZStack {
                                    Circle().fill(NxColors.controlRaised)
                                    if let face = pair.other.enrolledFrom.first, let data = model.faceThumbs[face.cacheKey] {
                                        BytesImage(data: data).clipShape(Circle())
                                    } else {
                                        Text(String(pair.other.name.prefix(1))).font(.nxSerif(13)).foregroundStyle(NxColors.text)
                                    }
                                }
                                .frame(width: 32, height: 32)
                                .overlay(Circle().stroke(NxColors.line, lineWidth: 1))
                                .task { if let face = pair.other.enrolledFrom.first { model.loadFaceThumb(face) } }
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(pair.other.name).font(.system(size: 13)).foregroundStyle(NxColors.text)
                                    Text(pair.edge.label.isEmpty ? "同框" : pair.edge.label)
                                        .font(.system(size: 10))
                                        .foregroundStyle(NxColors.textFaint)
                                }
                                Spacer()
                                if !pair.edge.virtual {
                                    SmallAction(
                                        systemName: "xmark", label: "删除关系",
                                        action: { model.deleteGraphEdge(pair.edge.id) },
                                        tint: NxColors.errorColor
                                    )
                                }
                            }
                            .padding(8)
                            .background(Color(argb: 0x0AFFFFFF), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                .frame(maxHeight: 160)
            }
        }
        .padding(10)
        .background(NxColors.panelSolid.opacity(0.9), in: RoundedRectangle(cornerRadius: 10))
    }
}
