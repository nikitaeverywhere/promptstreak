/**
 * The empty state.
 *
 * The year grid is the whole point of this page, so before there is any data
 * the snake plays on the real calendar cells rather than a blank box. It runs
 * itself until you press a key, then hands over.
 */

const ROWS = 7;
const TICK_MS = 120;

type Board = (HTMLElement | null)[][];

interface State {
  cells: Board;
  snake: Array<[number, number]>;
  dir: [number, number];
  food: [number, number];
  cols: number;
  score: number;
  best: number;
  auto: boolean;
  dead: number;
}

let timer: number | null = null;
let state: State | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;
let scoreEl: HTMLElement | null = null;

const eq = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

export function stopSnake(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (onKey) removeEventListener("keydown", onKey);
  onKey = null;
  state = null;
}

/** `cells[col][row]` from the rendered calendar; `null` where a pad cell is. */
export function startSnake(cells: Board, score: HTMLElement): void {
  stopSnake();
  const cols = cells.length;
  const mid = Math.floor(cols / 2);
  state = {
    cells, cols,
    snake: [[mid, 3], [mid - 1, 3], [mid - 2, 3]],
    dir: [1, 0], food: [0, 0], score: 0,
    best: Number(localStorage.getItem("promptstreak:snake") ?? 0) || 0,
    auto: true, dead: 0,
  };
  scoreEl = score;
  placeFood();
  paintScore();

  onKey = (e: KeyboardEvent) => {
    const map: Record<string, [number, number]> = {
      ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
    };
    const next = map[e.key] ?? map[e.key.toLowerCase()];
    if (!next || !state) return;
    e.preventDefault();
    state.auto = false;
    if (next[0] !== -state.dir[0] || next[1] !== -state.dir[1]) state.dir = next;
  };
  addEventListener("keydown", onKey);
  timer = setInterval(tick, TICK_MS) as unknown as number;
}

const open = (s: State, c: number, r: number) =>
  c >= 0 && r >= 0 && c < s.cols && r < ROWS && !!s.cells[c]?.[r];

function placeFood(): void {
  const s = state;
  if (!s) return;
  const free: Array<[number, number]> = [];
  for (let c = 0; c < s.cols; c++)
    for (let r = 0; r < ROWS; r++)
      if (open(s, c, r) && !s.snake.some((x) => eq(x, [c, r]))) free.push([c, r]);
  s.food = free[Math.floor(Math.random() * free.length)] ?? [0, 0];
}

/** Greedy chase that refuses moves with no room to escape. */
function autoSteer(): void {
  const s = state;
  if (!s) return;
  const [hx, hy] = s.snake[0];
  const options: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const safe = options.filter(([dx, dy]) => {
    if (dx === -s.dir[0] && dy === -s.dir[1]) return false;
    const nx = hx + dx, ny = hy + dy;
    return open(s, nx, ny) && !s.snake.slice(0, -1).some((x) => eq(x, [nx, ny]));
  });
  if (!safe.length) return;
  const [fx, fy] = s.food;
  safe.sort((a, b) =>
    Math.abs(hx + a[0] - fx) + Math.abs(hy + a[1] - fy) - (Math.abs(hx + b[0] - fx) + Math.abs(hy + b[1] - fy)));
  s.dir = safe[0];
}

function paintScore(): void {
  if (!state || !scoreEl) return;
  scoreEl.textContent = state.best ? `${state.score} · best ${state.best}` : String(state.score);
}

function tick(): void {
  const s = state;
  if (!s) return;
  if (s.dead > 0) {
    s.dead--;
    if (s.dead === 0) {
      const mid = Math.floor(s.cols / 2);
      s.snake = [[mid, 3], [mid - 1, 3]];
      s.dir = [1, 0];
      s.score = 0;
      s.auto = true;
      placeFood();
      paintScore();
    }
    return;
  }
  if (s.auto) autoSteer();

  const [hx, hy] = s.snake[0];
  const head: [number, number] = [hx + s.dir[0], hy + s.dir[1]];
  if (!open(s, head[0], head[1]) || s.snake.some((x) => eq(x, head))) {
    s.best = Math.max(s.best, s.score);
    try {
      localStorage.setItem("promptstreak:snake", String(s.best));
    } catch {
      // Storage is optional; the game does not need it.
    }
    s.dead = 8;
    paintScore();
    return;
  }

  s.snake.unshift(head);
  if (eq(head, s.food)) {
    s.score++;
    paintScore();
    placeFood();
  } else s.snake.pop();
  paint();
}

function paint(): void {
  const s = state;
  if (!s) return;
  for (let c = 0; c < s.cols; c++)
    for (let r = 0; r < ROWS; r++) {
      const cell = s.cells[c]?.[r];
      if (!cell) continue;
      cell.dataset.l = "0";
      delete cell.dataset.ov;
    }
  s.snake.forEach(([c, r], i) => {
    const cell = s.cells[c]?.[r];
    if (cell) cell.dataset.l = String(i === 0 ? 4 : Math.max(1, 3 - Math.floor(i / 6)));
  });
  const food = s.cells[s.food[0]]?.[s.food[1]];
  if (food) food.dataset.ov = "2";
}
