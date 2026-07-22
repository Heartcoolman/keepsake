import XCTest
@testable import Nianxiang

final class GraphLayoutTests: XCTestCase {
    func testOverlappingNodesSeparateAfterOneStep() {
        var points: [String: GraphLayout.Point] = [
            "a": GraphLayout.Point(x: 99, y: 100),
            "b": GraphLayout.Point(x: 101, y: 100),
        ]
        GraphLayout.step(
            points: &points, ids: ["a", "b"], edges: [],
            width: 200, height: 200, t: 0, wanderEnabled: false
        )
        let separation = abs(points["b"]!.x - points["a"]!.x)
        XCTAssertGreaterThan(separation, 2)
    }

    func testSpringConvergesTowardRest() {
        // Segment's midpoint coincides with the graph center so center-pull reinforces
        // convergence symmetrically instead of fighting it.
        var points: [String: GraphLayout.Point] = [
            "a": GraphLayout.Point(x: 100, y: 200),
            "b": GraphLayout.Point(x: 300, y: 200),
        ]
        let edges = [GraphLayout.Edge(a: "a", b: "b", hasLabel: true)]
        GraphLayout.step(
            points: &points, ids: ["a", "b"], edges: edges,
            width: 400, height: 400, t: 0, wanderEnabled: false
        )
        let distance = points["b"]!.x - points["a"]!.x
        XCTAssertLessThan(distance, 200)
        XCTAssertGreaterThan(distance, GraphLayout.springRestAI)
    }

    func testDampingDecaysVelocity() {
        // Position == center so center-pull contributes nothing; isolated point has no repulsion.
        var points: [String: GraphLayout.Point] = [
            "a": GraphLayout.Point(x: 100, y: 100, vx: 10, vy: 0),
        ]
        GraphLayout.step(
            points: &points, ids: ["a"], edges: [],
            width: 200, height: 200, t: 0, wanderEnabled: false
        )
        XCTAssertEqual(points["a"]!.vx, 10 * GraphLayout.damping, accuracy: 0.0001)
    }

    func testFixedPointStaysPut() {
        var points: [String: GraphLayout.Point] = [
            "a": GraphLayout.Point(x: 50, y: 50, vx: 5, vy: 5, fixed: true),
            "b": GraphLayout.Point(x: 60, y: 60),
        ]
        GraphLayout.step(
            points: &points, ids: ["a", "b"], edges: [],
            width: 400, height: 400, t: 0, wanderEnabled: false
        )
        XCTAssertEqual(points["a"]!.x, 50)
        XCTAssertEqual(points["a"]!.y, 50)
        XCTAssertEqual(points["a"]!.vx, 0)
        XCTAssertEqual(points["a"]!.vy, 0)
    }
}
