"use strict";

const state = {
  mode: "9x9",
  puzzle: null,
  values: [],
  startedAt: 0,
  timerId: null,
  nextRoundTimer: null,
  player: null,
  completed: false
};

const board = document.querySelector("#board");
const timer = document.querySelector("#timer");
const scorePreview = document.querySelector("#scorePreview");
const statusText = document.querySelector("#statusText");
const syncText = document.querySelector("#syncText");
const playerLine = document.querySelector("#playerLine");
const leaderboard = document.querySelector("#leaderboard");
const leaderboardSource = document.querySelector("#leaderboardSource");
const playerDialog = document.querySelector("#playerDialog");
const playerForm = document.querySelector("#playerForm");
const playerNameInput = document.querySelector("#playerNameInput");

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function elapsedSeconds() {
  if (!state.startedAt || state.completed) {
    return state.lastElapsed || 0;
  }

  return Math.floor((Date.now() - state.startedAt) / 1000);
}

function updateTimer() {
  const elapsed = elapsedSeconds();
  timer.textContent = formatTime(elapsed);
  scorePreview.textContent = String(calculateScore(state.mode, elapsed));
}

function setStatus(message, tone = "") {
  statusText.textContent = message;
  statusText.dataset.tone = tone;
}

function readBoardValues() {
  const config = MODE_CONFIG[state.mode];
  const values = Array.from({ length: config.size }, () => Array(config.size).fill(0));

  board.querySelectorAll("input").forEach((input) => {
    const row = Number(input.dataset.row);
    const col = Number(input.dataset.col);
    values[row][col] = Number(input.value) || 0;
  });

  state.values = values;
  return values;
}

function applyConflicts() {
  const conflicts = getConflicts(state.mode, readBoardValues());

  board.querySelectorAll(".cell").forEach((cell) => {
    const key = `${cell.dataset.row}:${cell.dataset.col}`;
    cell.classList.toggle("invalid", conflicts.has(key));
    cell.classList.remove("wrong");
  });

  return conflicts;
}

function applyBoardMarks(conflicts, wrong = new Set()) {
  board.querySelectorAll(".cell").forEach((cell) => {
    const key = `${cell.dataset.row}:${cell.dataset.col}`;
    cell.classList.toggle("invalid", conflicts.has(key));
    cell.classList.toggle("wrong", wrong.has(key) && !conflicts.has(key));
  });
}

function renderBoard() {
  const config = MODE_CONFIG[state.mode];
  board.className = `board board-${config.size}`;
  board.innerHTML = "";

  for (let row = 0; row < config.size; row += 1) {
    for (let col = 0; col < config.size; col += 1) {
      const value = state.puzzle.puzzle[row][col];
      const cell = document.createElement("label");
      const input = document.createElement("input");

      cell.className = "cell";
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);

      if (state.mode === "9x9") {
        if ((col + 1) % 3 === 0 && col !== config.size - 1) {
          cell.classList.add("box-right");
        }
        if ((row + 1) % 3 === 0 && row !== config.size - 1) {
          cell.classList.add("box-bottom");
        }
      }

      input.dataset.row = String(row);
      input.dataset.col = String(col);
      input.inputMode = "numeric";
      input.maxLength = 1;
      input.setAttribute("aria-label", `Row ${row + 1}, column ${col + 1}`);

      if (value) {
        input.value = String(value);
        input.disabled = true;
        cell.classList.add("given");
      } else {
        input.addEventListener("input", () => {
          const allowed = new RegExp(`^[1-${config.size}]$`);
          if (!allowed.test(input.value)) {
            input.value = "";
          }
          applyConflicts();
          maybeComplete();
        });

        input.addEventListener("focus", () => {
          highlightPeers(row, col);
        });

        input.addEventListener("blur", () => {
          board.querySelectorAll(".peer").forEach((peer) => peer.classList.remove("peer"));
        });
      }

      cell.append(input);
      board.append(cell);
    }
  }

  readBoardValues();
}

function highlightPeers(activeRow, activeCol) {
  board.querySelectorAll(".cell").forEach((cell) => {
    const row = Number(cell.dataset.row);
    const col = Number(cell.dataset.col);
    const sameBox =
      state.mode === "9x9" &&
      Math.floor(row / 3) === Math.floor(activeRow / 3) &&
      Math.floor(col / 3) === Math.floor(activeCol / 3);
    cell.classList.toggle("peer", row === activeRow || col === activeCol || sameBox);
  });
}

async function maybeComplete() {
  if (state.completed) {
    return;
  }

  const values = readBoardValues();
  const conflicts = getConflicts(state.mode, values);
  const filled = isFilled(state.mode, values);

  if (!filled) {
    return;
  }

  const wrong = getWrongCells(state.mode, values, state.puzzle.solution);
  applyBoardMarks(conflicts, wrong);

  if (conflicts.size || wrong.size || !isComplete(state.mode, values, state.puzzle.solution)) {
    setStatus("The grid is full, but some cells need another look.", "bad");
    return;
  }

  state.lastElapsed = elapsedSeconds();
  state.completed = true;
  clearInterval(state.timerId);
  board.querySelectorAll("input").forEach((input) => {
    input.disabled = true;
  });
  updateTimer();

  const score = calculateScore(state.mode, state.lastElapsed);
  await window.suduku.saveScore({
    mode: state.mode,
    elapsedSeconds: state.lastElapsed,
    score
  });

  setStatus(`Correct. +${score} points in ${formatTime(state.lastElapsed)}. Next round starts shortly.`, "good");
  syncText.textContent = "Saved locally";
  void syncAndRefresh("auto");
  state.nextRoundTimer = setTimeout(() => {
    startNewRound(state.mode);
  }, 1600);
}

function startNewRound(mode = state.mode) {
  state.mode = mode;
  state.puzzle = createPuzzle(mode);
  state.values = state.puzzle.puzzle.map((row) => [...row]);
  state.startedAt = Date.now();
  state.lastElapsed = 0;
  state.completed = false;

  clearInterval(state.timerId);
  clearTimeout(state.nextRoundTimer);
  state.timerId = setInterval(updateTimer, 1000);
  state.nextRoundTimer = null;

  document.querySelectorAll(".mode-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });

  renderBoard();
  updateTimer();
  setStatus("Complete the grid to score this round.");
  refreshLeaderboard();
}

async function refreshLeaderboard() {
  const result = await window.suduku.getLeaderboard(state.mode);
  const sourceLabels = {
    "remote-postgres": "Server ranking",
    "marketplace-sqlite": "Marketplace SQLite",
    "local-sqlite": "Local SQLite",
    sqlite: "Local SQLite"
  };
  leaderboardSource.textContent = sourceLabels[result.source] || "Local SQLite";
  leaderboard.innerHTML = "";

  if (!result.rows.length) {
    const empty = document.createElement("li");
    empty.textContent = "No completed rounds yet.";
    leaderboard.append(empty);
    return;
  }

  for (const row of result.rows) {
    const item = document.createElement("li");
    const points = row.bestScore ?? row.totalScore ?? row.score;
    item.innerHTML = `
      <span class="leader-name"></span>
      <span class="leader-meta">${points} pts · ${row.rounds} rounds · best ${formatTime(row.bestTime)}</span>
    `;
    item.querySelector(".leader-name").textContent = `${row.rank}. ${row.playerName}`;
    leaderboard.append(item);
  }
}

function describeSyncResult(result) {
  if (result.ok) {
    return result.synced ? `Synced ${result.synced}` : "Server ranking refreshed";
  }
  const labels = {
    remote_not_configured: "No server configured",
    auth_required: "Login required to sync",
    remote_sync_failed: "Sync failed"
  };
  return labels[result.reason] || "Sync unavailable";
}

async function syncAndRefresh(reason = "manual") {
  const result = await window.suduku.syncNow();
  syncText.textContent = describeSyncResult(result);
  await refreshLeaderboard();
  if (reason === "manual" && result.error) {
    setStatus(result.error, "bad");
  }
  return result;
}

async function ensurePlayer() {
  const result = await window.suduku.getPlayer();
  if (result.syncStatus?.serverConfigured) {
    syncText.textContent = result.syncStatus.authenticated ? "Server sync ready" : "Server ranking ready";
  } else {
    syncText.textContent = "Offline-ready";
  }

  if (result.player) {
    state.player = result.player;
    playerLine.textContent = result.player.displayName;
    return;
  }

  playerNameInput.value = (result.suggestedName || "Player#0000").replace(/#\d{4}$/, "");
  playerDialog.showModal();
}

playerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const player = await window.suduku.setLocalPlayer(playerNameInput.value);
  state.player = player;
  playerLine.textContent = player.displayName;
  playerDialog.close();
  startNewRound();
});

document.querySelectorAll(".mode-button").forEach((button) => {
  button.addEventListener("click", () => {
    startNewRound(button.dataset.mode);
  });
});

document.querySelector("#newGameButton").addEventListener("click", () => {
  startNewRound();
});

document.querySelector("#checkButton").addEventListener("click", () => {
  const values = readBoardValues();
  const conflicts = getConflicts(state.mode, values);
  const wrong = isFilled(state.mode, values)
    ? getWrongCells(state.mode, values, state.puzzle.solution)
    : new Set();
  applyBoardMarks(conflicts, wrong);
  if (conflicts.size) {
    setStatus("There are duplicate numbers to fix.", "bad");
    return;
  }
  if (wrong.size) {
    setStatus("No duplicates, but at least one number is incorrect.", "bad");
    return;
  }
  if (isFilled(state.mode, values)) {
    void maybeComplete();
    return;
  }
  setStatus("No duplicate numbers found.");
});

document.querySelector("#syncButton").addEventListener("click", async () => {
  await syncAndRefresh("manual");
});

ensurePlayer().then(() => {
  if (state.player) {
    startNewRound();
  }
});
