/**
 * The empty state.
 *
 * The year grid is the whole point of this page, so before there is any data
 * it plays snake on those same cells rather than sitting blank. It runs itself
 * until you press a key, then hands over.
 */

const ROWS = 7;
const TICK_MS = 120;

interface State {
  cells: HTMLElement[][];
  snake: Array<[number, number]>;
  dir: [number, number];
  food: [number, number];
  cols: number;
  score: number;
  best: number;
  playing: boolean;
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

export function startSnake(colsEl: HTMLElement, factsEl: HTMLElement, size: number): void {
  stopSnake();

  const cols = 52;
  document.documentElement.style.setProperty("--cs", `${size}px`);
  document.documentElement.style.setProperty("--cg", `3px`);
  colsEl.replaceChildren();

  const cells: HTMLElement[][] = [];
  for (let c = 0; c < cols; c++) {
    const col = document.createElement("div");
    col.className = "col";
    const column: HTMLElement[] = [];
    for (let r = 0; r < ROWS; r++) {
      const cell = document.createElement("i");
      cell.className = "cell";
      cell.style.animationDelay = `${c * 5}ms`;
      col.append(cell);
      column.push(cell);
    }
    cells.push(column);
    colsEl.append(col);
  }

  state = {
    cells,
    cols,
    snake: [[Math.floor(cols / 2), 3], [Math.floor(cols / 2) - 1, 3], [Math.floor(cols / 2) - 2, 3]],
    dir: [1, 0],
    food: [0, 0],
    score: 0,
    best: Number(localStorage.getItem("promptstreak:snake") ?? 0) || 0,
    playing: true,
    auto: true,
    dead: 0,
  };
  placeFood();

  factsEl.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "fact snake";
  scoreEl = document.createElement("b");
  const hint = document.createElement("span");
  hint.textContent = "Nothing here yet — run npx promptstreak to see your year. Arrow keys or WASD to play meanwhile.";
  wrap.append(scoreEl, hint);
  factsEl.append(wrap);
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

function placeFood(): void {
  if (!state) return;
  const free: Array<[number, number]> = [];
  for (let c = 0; c < state.cols; c++)
    for (let r = 0; r < ROWS; r++)
      if (!state.snake.some((s) => eq(s, [c, r]))) free.push([c, r]);
  state.food = free[Math.floor(Math.random() * free.length)] ?? [0, 0];
}

/** Greedy chase that refuses moves with no room to escape. */
function autoSteer(): void {
  if (!state) return;
  const [hx, hy] = state.snake[0];
  const options: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const safe = options.filter(([dx, dy]) => {
    if (dx === -state!.dir[0] && dy === -state!.dir[1]) return false;
    const nx = hx + dx, ny = hy + dy;
    if (nx < 0 || ny < 0 || nx >= state!.cols || ny >= ROWS) return false;
    return !state!.snake.slice(0, -1).some((s) => eq(s, [nx, ny]));
  });
  if (!safe.length) return;
  const [fx, fy] = state.food;
  safe.sort((a, b) => {
    const da = Math.abs(hx + a[0] - fx) + Math.abs(hy + a[1] - fy);
    const db = Math.abs(hx + b[0] - fx) + Math.abs(hy + b[1] - fy);
    return da - db;
  });
  state.dir = safe[0];
}

function paintScore(): void {
  if (!state || !scoreEl) return;
  scoreEl.textContent = state.best
    ? `${state.score} · best ${state.best}`
    : String(state.score);
}

function tick(): void {
  if (!state) return;
  if (state.dead > 0) {
    state.dead--;
    if (state.dead === 0) {
      state.snake = [[Math.floor(state.cols / 2), 3], [Math.floor(state.cols / 2) - 1, 3]];
      state.dir = [1, 0];
      state.score = 0;
      state.auto = true;
      placeFood();
      paintScore();
    }
    return;
  }
  if (state.auto) autoSteer();

  const [hx, hy] = state.snake[0];
  const head: [number, number] = [hx + state.dir[0], hy + state.dir[1]];
  const hitWall = head[0] < 0 || head[1] < 0 || head[0] >= state.cols || head[1] >= ROWS;
  if (hitWall || state.snake.some((s) => eq(s, head))) {
    state.best = Math.max(state.best, state.score);
    try {
      localStorage.setItem("promptstreak:snake", String(state.best));
    } catch {
      // Storage is optional; the game does not need it.
    }
    state.dead = 8;
    paintScore();
    return;
  }

  state.snake.unshift(head);
  if (eq(head, state.food)) {
    state.score++;
    paintScore();
    placeFood();
  } else state.snake.pop();

  paint();
}

function paint(): void {
  const s = state;
  if (!s) return;
  for (let c = 0; c < s.cols; c++)
    for (let r = 0; r < ROWS; r++) {
      const cell = s.cells[c][r];
      delete cell.dataset.l;
      delete cell.dataset.gold;
    }
  s.snake.forEach(([c, r], i) => {
    const cell = s.cells[c]?.[r];
    if (cell) cell.dataset.l = String(i === 0 ? 4 : Math.max(1, 3 - Math.floor(i / 6)));
  });
  const [fc, fr] = s.food;
  const food = s.cells[fc]?.[fr];
  if (food) food.dataset.gold = "2";
}
