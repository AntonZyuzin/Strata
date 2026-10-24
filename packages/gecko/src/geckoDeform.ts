/** Native-grid deformation. Adjacent source pixels keep their shared edge. */
export type DeformPoint = readonly [number, number];
export type PixelTransform = (x: number, y: number) => DeformPoint;

export interface ConnectedMesh {
  width: number;
  height: number;
  pixels: Uint32Array;
  vertices: { index: number; weights: readonly [number, number][] }[];
}

/** Smooth ownership around joints, while the interior of each part stays rigid. */
export function createConnectedMesh(
  source: Uint32Array,
  owners: Uint8Array,
  width: number,
  height: number,
): ConnectedMesh {
  const pixels = source.slice();
  for (let i = 0; i < pixels.length; i++) if (owners[i] === 255) pixels[i] = 0;
  const vertices: ConnectedMesh['vertices'] = [];
  for (let y = 0; y <= height; y++)
    for (let x = 0; x <= width; x++) {
      let used = false;
      for (let dy = -1; dy <= 0; dy++)
        for (let dx = -1; dx <= 0; dx++) {
          const px = x + dx,
            py = y + dy;
          if (px >= 0 && py >= 0 && px < width && py < height && pixels[py * width + px])
            used = true;
        }
      if (!used) continue;
      const sums = new Map<number, number>();
      let total = 0;
      // Skin can blend through the actual joint, never across an air gap
      // between a toe and the face that happens to be nearby in the drawing.
      const distances = new Map<number, number>(),
        queue: number[] = [];
      for (let dy = -1; dy <= 0; dy++)
        for (let dx = -1; dx <= 0; dx++) {
          const px = x + dx,
            py = y + dy,
            index = py * width + px;
          if (px < 0 || py < 0 || px >= width || py >= height || !pixels[index]) continue;
          distances.set(index, 0);
          queue.push(index);
        }
      for (const index of queue) {
        const distance = distances.get(index) ?? 0,
          px = index % width,
          py = Math.floor(index / width),
          owner = owners[index] ?? 255,
          weight = Math.exp(-((px + 0.5 - x) ** 2 + (py + 0.5 - y) ** 2) / 3.2);
        sums.set(owner, (sums.get(owner) ?? 0) + weight);
        total += weight;
        if (distance >= 3) continue;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx,
              ny = py + dy,
              next = ny * width + nx;
            if (
              nx < 0 ||
              ny < 0 ||
              nx >= width ||
              ny >= height ||
              !pixels[next] ||
              distances.has(next)
            )
              continue;
            distances.set(next, distance + 1);
            queue.push(next);
          }
      }
      vertices.push({
        index: y * (width + 1) + x,
        weights: [...sums].map(([owner, weight]) => [owner, weight / total]),
      });
    }
  return { width, height, pixels, vertices };
}

/**
 * Rasterizes deformed source cells without antialiasing. Source neighbours
 * also retain a pixel path between their centres: a narrow toe cannot be
 * dropped by resampling, and a shoulder cannot open into two islands.
 */
export function deformConnectedMesh(
  mesh: ConnectedMesh,
  transforms: readonly PixelTransform[],
): Uint32Array {
  const { width: w, height: h, pixels } = mesh,
    stride = w + 1,
    vx = new Float64Array(stride * (h + 1)),
    vy = new Float64Array(vx.length),
    centresX = new Float64Array(pixels.length),
    centresY = new Float64Array(pixels.length),
    out = new Uint32Array(w * h);
  for (const vertex of mesh.vertices) {
    const x = vertex.index % stride,
      y = Math.floor(vertex.index / stride);
    let tx = 0,
      ty = 0;
    for (const [owner, weight] of vertex.weights) {
      const p = transforms[owner]?.(x, y) ?? [x, y];
      tx += p[0] * weight;
      ty += p[1] * weight;
    }
    vx[vertex.index] = tx;
    vy[vertex.index] = ty;
  }
  const triangle = (a: number, b: number, c: number, colour: number) => {
    const ax = vx[a] ?? 0,
      ay = vy[a] ?? 0,
      bx = vx[b] ?? 0,
      by = vy[b] ?? 0,
      cx = vx[c] ?? 0,
      cy = vy[c] ?? 0,
      area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 0.00001) return;
    const left = Math.max(0, Math.floor(Math.min(ax, bx, cx))),
      right = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx))),
      top = Math.max(0, Math.floor(Math.min(ay, by, cy))),
      bottom = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= right; x++) {
        const px = x + 0.5,
          py = y + 0.5,
          u = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area,
          v = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area,
          q = 1 - u - v;
        if (u >= -0.00001 && v >= -0.00001 && q >= -0.00001) out[y * w + x] = colour;
      }
  };
  for (let i = 0; i < pixels.length; i++) {
    const colour = pixels[i] ?? 0;
    if (!colour) continue;
    const x = i % w,
      y = Math.floor(i / w),
      a = y * stride + x,
      b = a + 1,
      c = b + stride,
      d = a + stride;
    triangle(a, b, c, colour);
    triangle(a, c, d, colour);
    centresX[i] = ((vx[a] ?? 0) + (vx[b] ?? 0) + (vx[c] ?? 0) + (vx[d] ?? 0)) / 4;
    centresY[i] = ((vy[a] ?? 0) + (vy[b] ?? 0) + (vy[c] ?? 0) + (vy[d] ?? 0)) / 4;
  }
  const connect = (from: number, to: number, colour: number) => {
    const ax = Math.floor(centresX[from] ?? 0),
      ay = Math.floor(centresY[from] ?? 0),
      bx = Math.floor(centresX[to] ?? 0),
      by = Math.floor(centresY[to] ?? 0),
      steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1);
    for (let k = 0; k <= steps; k++) {
      const x = Math.round(ax + ((bx - ax) * k) / steps),
        y = Math.round(ay + ((by - ay) * k) / steps),
        index = y * w + x;
      if (x >= 0 && y >= 0 && x < w && y < h && !out[index]) out[index] = colour;
    }
  };
  for (let i = 0; i < pixels.length; i++) {
    const colour = pixels[i] ?? 0;
    if (!colour) continue;
    connect(i, i, colour);
    const x = i % w,
      y = Math.floor(i / w);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ]) {
      const nx = x + (dx ?? 0),
        ny = y + (dy ?? 0),
        next = ny * w + nx;
      if (nx >= 0 && ny < h && nx < w && pixels[next]) connect(i, next, colour);
    }
  }
  return out;
}
