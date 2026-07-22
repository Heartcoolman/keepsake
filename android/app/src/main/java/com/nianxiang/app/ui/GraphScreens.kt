package com.nianxiang.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.nianxiang.app.data.GraphNode
import com.nianxiang.app.data.RelationshipDto
import kotlin.math.roundToInt

@Composable
fun GraphOverlay(state: UiState, viewModel: AppViewModel, dismiss: () -> Unit) {
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { viewModel.loadGraph() }

    OverlayFrame("◈ 关系图谱", dismiss) {
        when {
            state.graphLoading -> GraphEmptyText("正在整理关系…", Modifier.weight(1f))
            state.graphNodes.isEmpty() -> GraphEmptyText("还没有人物档案,先去「人物」里添加吧。", Modifier.weight(1f))
            else -> {
                val selected = selectedId?.let { id -> state.graphNodes.find { it.id == id } }
                Column(Modifier.weight(1f).fillMaxWidth()) {
                    if (state.graphEdges.isEmpty()) {
                        Text(
                            "还没有关系记录,继续写日记,念念会慢慢认出大家的关系。",
                            color = NxColors.TextDim,
                            fontSize = 12.sp,
                            modifier = Modifier.padding(bottom = 8.dp),
                        )
                    }
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        GraphCanvas(
                            state = state,
                            viewModel = viewModel,
                            selectedId = selectedId,
                            onSelect = { selectedId = it },
                        )
                    }
                    selected?.let { node ->
                        GraphSidePanel(
                            state = state,
                            selected = node,
                            nodes = state.graphNodes,
                            edges = state.graphEdges,
                            viewModel = viewModel,
                            onClose = { selectedId = null },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun GraphEmptyText(text: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text(text, color = NxColors.TextDim, fontFamily = NxSerif, fontSize = 14.sp)
    }
}

@Composable
private fun GraphCanvas(
    state: UiState,
    viewModel: AppViewModel,
    selectedId: String?,
    onSelect: (String?) -> Unit,
) {
    val nodes = state.graphNodes
    val edges = state.graphEdges
    val nodesKey = remember(nodes) { nodes.map { it.id } }
    val edgesKey = remember(edges) { edges.map { it.id } }
    var sizePx by remember { mutableStateOf(IntSize.Zero) }
    val points = remember { mutableMapOf<String, GraphPoint>() }
    var tick by remember { mutableStateOf(0) }

    // Reheats on every data/size change: the effect key changing cancels the running loop
    // below and restarts it, re-seeding only nodes that don't already have a position.
    LaunchedEffect(nodesKey, edgesKey, sizePx) {
        if (sizePx.width == 0 || sizePx.height == 0) return@LaunchedEffect
        points.keys.retainAll(nodesKey.toSet())
        nodes.forEachIndexed { index, n ->
            points.getOrPut(n.id) {
                GraphLayout.initialPosition(index, nodes.size, n.id, sizePx.width.toFloat(), sizePx.height.toFloat())
            }
        }
        val layoutEdges = edges.mapNotNull { e ->
            if (points.containsKey(e.a) && points.containsKey(e.b)) {
                GraphLayout.LayoutEdge(e.a, e.b, hasLabel = e.label.isNotEmpty())
            } else {
                null
            }
        }
        while (true) {
            withFrameNanos { nanos ->
                GraphLayout.step(points, nodesKey, layoutEdges, sizePx.width.toFloat(), sizePx.height.toFloat(), nanos / 1_000_000f)
                tick++
            }
        }
    }

    val neighborIds = remember(selectedId, edges) {
        if (selectedId == null) {
            emptySet()
        } else {
            edges.mapNotNull { e -> if (e.a == selectedId) e.b else if (e.b == selectedId) e.a else null }.toSet()
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .onSizeChanged { sizePx = it }
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onSelect(null) },
    ) {
        // Reading `tick` subscribes this composable to every animation-loop step, so the
        // canvas + node offsets below re-read the mutated GraphPoints each frame.
        tick
        Canvas(Modifier.fillMaxSize()) {
            edges.forEach { e ->
                val pa = points[e.a]
                val pb = points[e.b]
                if (pa != null && pb != null) {
                    val dim = selectedId != null && e.a != selectedId && e.b != selectedId
                    drawLine(
                        color = if (dim) NxColors.Line.copy(alpha = 0.12f) else NxColors.LineStrong,
                        start = Offset(pa.x, pa.y),
                        end = Offset(pb.x, pb.y),
                        strokeWidth = if (e.label.isEmpty()) 1.dp.toPx() else 1.6.dp.toPx(),
                    )
                }
            }
        }
        edges.forEach { e ->
            if (e.label.isEmpty()) return@forEach
            val pa = points[e.a]
            val pb = points[e.b]
            if (pa != null && pb != null) {
                val dim = selectedId != null && e.a != selectedId && e.b != selectedId
                Text(
                    e.label,
                    color = if (dim) NxColors.TextFaint else NxColors.TextDim,
                    fontSize = 10.sp,
                    modifier = Modifier.offset {
                        IntOffset((((pa.x + pb.x) / 2f).roundToInt()) - 20, (((pa.y + pb.y) / 2f).roundToInt()) - 8)
                    },
                )
            }
        }
        nodes.forEach { node ->
            val p = points[node.id] ?: return@forEach
            val dim = selectedId != null && node.id != selectedId && !neighborIds.contains(node.id)
            GraphNodeAvatar(
                node = node,
                state = state,
                viewModel = viewModel,
                dim = dim,
                x = p.x,
                y = p.y,
                onDrag = { dx, dy -> p.fixed = true; p.x += dx; p.y += dy },
                onDragEnd = { p.fixed = false },
                onTap = { onSelect(node.id) },
            )
        }
    }
}

@Composable
private fun GraphNodeAvatar(
    node: GraphNode,
    state: UiState,
    viewModel: AppViewModel,
    dim: Boolean,
    x: Float,
    y: Float,
    onDrag: (Float, Float) -> Unit,
    onDragEnd: () -> Unit,
    onTap: () -> Unit,
) {
    Column(
        modifier = Modifier
            .offset { IntOffset(x.roundToInt() - 22, y.roundToInt() - 22) }
            .graphicsLayer { alpha = if (dim) 0.35f else 1f }
            .pointerInput(node.id) {
                detectDragGestures(
                    onDragEnd = onDragEnd,
                    onDrag = { change, amount -> change.consume(); onDrag(amount.x, amount.y) },
                )
            }
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onTap),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        GraphAvatarCircle(node, state, viewModel, size = 44.dp)
        Text(
            node.name,
            color = NxColors.TextDim,
            fontSize = 10.sp,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}

@Composable
private fun GraphAvatarCircle(node: GraphNode, state: UiState, viewModel: AppViewModel, size: Dp) {
    val face = node.enrolledFrom.firstOrNull()
    val faceKey = face?.let { "${it.entryId}:${it.faceIndex}" }
    if (face != null) LaunchedEffect(faceKey) { viewModel.loadFaceThumb(face) }
    Surface(
        modifier = Modifier.size(size),
        shape = CircleShape,
        color = if (node.isUser) NxColors.Gold.copy(alpha = 0.18f) else NxColors.ControlRaised,
        border = BorderStroke(1.dp, NxColors.Line),
    ) {
        if (faceKey != null && state.faceThumbs[faceKey] != null) {
            AsyncImage(
                state.faceThumbs[faceKey],
                node.name,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
            )
        } else {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(node.name.take(1), color = NxColors.Text, fontFamily = NxSerif, fontSize = 17.sp)
            }
        }
    }
}

@Composable
private fun GraphSidePanel(
    state: UiState,
    selected: GraphNode,
    nodes: List<GraphNode>,
    edges: List<RelationshipDto>,
    viewModel: AppViewModel,
    onClose: () -> Unit,
) {
    val neighbors = remember(selected.id, edges, nodes) {
        edges.mapNotNull { e ->
            if (e.a != selected.id && e.b != selected.id) return@mapNotNull null
            val otherId = if (e.a == selected.id) e.b else e.a
            val other = nodes.find { it.id == otherId } ?: return@mapNotNull null
            e to other
        }
    }
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 220.dp)
            .background(NxColors.Panel, RoundedCornerShape(10.dp))
            .padding(12.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(selected.name, color = NxColors.Text, fontFamily = NxSerif, fontSize = 15.sp, modifier = Modifier.weight(1f))
            NxIconButton(Icons.Default.Close, "取消选中", onClose)
        }
        if (neighbors.isEmpty()) {
            Text("暂无关系记录", color = NxColors.TextFaint, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))
        } else {
            LazyColumn(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(neighbors, key = { it.first.id }) { (edge, other) ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .background(Color(0x0AFFFFFF), RoundedCornerShape(8.dp))
                            .padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        GraphAvatarCircle(other, state, viewModel, size = 34.dp)
                        Column(Modifier.weight(1f).padding(start = 8.dp)) {
                            Text(other.name, color = NxColors.Text, fontSize = 13.sp)
                            Text(edge.label.ifEmpty { "同框" }, color = NxColors.TextFaint, fontSize = 11.sp)
                        }
                        if (!edge.virtual) {
                            NxIconButton(Icons.Default.Close, "删除关系", { viewModel.deleteGraphEdge(edge.id) })
                        }
                    }
                }
            }
        }
    }
}
