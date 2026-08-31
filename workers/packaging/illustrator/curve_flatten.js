/* ES3-compatible deterministic cubic Bezier subdivision for Illustrator JSX. */
function curvePointSegmentDistance(point, start, end) {
    var dx = end[0] - start[0];
    var dy = end[1] - start[1];
    var lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 0.000000000000000001) {
        dx = point[0] - start[0];
        dy = point[1] - start[1];
        return Math.sqrt(dx * dx + dy * dy);
    }
    var ratio = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared;
    ratio = Math.max(0, Math.min(1, ratio));
    var nearestX = start[0] + ratio * dx;
    var nearestY = start[1] + ratio * dy;
    dx = point[0] - nearestX;
    dy = point[1] - nearestY;
    return Math.sqrt(dx * dx + dy * dy);
}

function curveMidpoint(left, right) {
    return [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
}

function flattenCubicSegment(start, controlA, controlB, end, tolerance, maximumDepth) {
    var result = [start];
    var exceeded = false;

    function visit(p0, p1, p2, p3, depth) {
        var flatness = Math.max(
            curvePointSegmentDistance(p1, p0, p3),
            curvePointSegmentDistance(p2, p0, p3)
        );
        if (flatness <= tolerance) {
            result.push(p3);
            return;
        }
        if (depth >= maximumDepth) {
            exceeded = true;
            return;
        }
        var p01 = curveMidpoint(p0, p1);
        var p12 = curveMidpoint(p1, p2);
        var p23 = curveMidpoint(p2, p3);
        var p012 = curveMidpoint(p01, p12);
        var p123 = curveMidpoint(p12, p23);
        var split = curveMidpoint(p012, p123);
        visit(p0, p01, p012, split, depth + 1);
        visit(split, p123, p23, p3, depth + 1);
    }

    visit(start, controlA, controlB, end, 0);
    return exceeded ? null : result;
}
